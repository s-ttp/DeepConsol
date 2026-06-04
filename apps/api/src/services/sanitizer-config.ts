import { query } from "../db/pool.js";
import {
  BUILTIN_RULES,
  type BuiltinRuleMeta,
  type CustomRule,
  type SanitizerOverlay,
} from "@deepconsol/shared/sanitizer";

/**
 * Server-side loader for the sanitizer overlay (migration 006).
 *
 * Both the API (chat.ts) and the worker (ingestion) call getSanitizerOverlay()
 * and pass the result into shared `sanitize()`. Like the embedding config, the
 * worker is a separate process that never sees invalidate(), so we use a short
 * TTL: a saved change is reflected within CACHE_TTL across processes without a
 * restart. invalidateSanitizerOverlay() gives the API process an immediate
 * refresh after an admin write.
 *
 * On ANY DB error the resolver returns an EMPTY overlay, which makes
 * `sanitize()` run the full hardcoded baseline — failing safe, never open.
 */

const CACHE_TTL_MS = 30_000;

export interface CustomRuleRow extends CustomRule {
  created_at: Date;
  updated_at: Date;
}

let cached: { value: SanitizerOverlay; at: number } | null = null;

export function invalidateSanitizerOverlay(): void {
  cached = null;
}

export async function getSanitizerOverlay(): Promise<SanitizerOverlay> {
  if (cached && performance.now() - cached.at < CACHE_TTL_MS) return cached.value;
  try {
    const [overrides, customs] = await Promise.all([
      query<{ rule_name: string; enabled: boolean }>(
        "SELECT rule_name, enabled FROM sanitizer_builtin_overrides"
      ),
      query<CustomRule>(
        `SELECT id, label, match_type, value, action, alias_prefix, case_insensitive, enabled
           FROM sanitizer_custom_rules WHERE enabled = TRUE`
      ),
    ]);
    const knownNames = new Set(BUILTIN_RULES.map((r) => r.name));
    const value: SanitizerOverlay = {
      disabledBuiltins: overrides.rows
        .filter((r) => r.enabled === false && knownNames.has(r.rule_name))
        .map((r) => r.rule_name),
      customRules: customs.rows,
    };
    cached = { value, at: performance.now() };
    return value;
  } catch {
    // Fail safe: empty overlay → full baseline runs.
    return {};
  }
}

/** Built-in rules with their effective enabled state, for the admin UI. */
export async function listBuiltinRules(): Promise<Array<BuiltinRuleMeta & { enabled: boolean }>> {
  const { rows } = await query<{ rule_name: string; enabled: boolean }>(
    "SELECT rule_name, enabled FROM sanitizer_builtin_overrides"
  );
  const overrideMap = new Map(rows.map((r) => [r.rule_name, r.enabled]));
  return BUILTIN_RULES.map((r) => ({ ...r, enabled: overrideMap.get(r.name) ?? true }));
}

export function isKnownBuiltin(name: string): boolean {
  return BUILTIN_RULES.some((r) => r.name === name);
}

export async function setBuiltinEnabled(
  name: string,
  enabled: boolean,
  userId: string
): Promise<void> {
  await query(
    `INSERT INTO sanitizer_builtin_overrides (rule_name, enabled, updated_by)
       VALUES ($1, $2, $3)
     ON CONFLICT (rule_name) DO UPDATE
       SET enabled = EXCLUDED.enabled, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
    [name, enabled, userId]
  );
  invalidateSanitizerOverlay();
}

export async function listCustomRules(): Promise<CustomRuleRow[]> {
  const { rows } = await query<CustomRuleRow>(
    `SELECT id, label, match_type, value, action, alias_prefix, case_insensitive, enabled, created_at, updated_at
       FROM sanitizer_custom_rules ORDER BY created_at`
  );
  return rows;
}

export interface CustomRuleInput {
  label: string;
  match_type: "literal" | "wildcard";
  value: string;
  action: "redact" | "pseudonymize";
  alias_prefix?: string | null;
  case_insensitive: boolean;
  enabled: boolean;
}

export async function createCustomRule(input: CustomRuleInput, userId: string): Promise<CustomRuleRow> {
  const { rows } = await query<CustomRuleRow>(
    `INSERT INTO sanitizer_custom_rules
       (label, match_type, value, action, alias_prefix, case_insensitive, enabled, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, label, match_type, value, action, alias_prefix, case_insensitive, enabled, created_at, updated_at`,
    [
      input.label,
      input.match_type,
      input.value,
      input.action,
      input.action === "pseudonymize" ? input.alias_prefix ?? null : null,
      input.case_insensitive,
      input.enabled,
      userId,
    ]
  );
  invalidateSanitizerOverlay();
  return rows[0];
}

export async function updateCustomRule(
  id: string,
  input: CustomRuleInput,
  userId: string
): Promise<CustomRuleRow | null> {
  const { rows } = await query<CustomRuleRow>(
    `UPDATE sanitizer_custom_rules
        SET label = $2, match_type = $3, value = $4, action = $5,
            alias_prefix = $6, case_insensitive = $7, enabled = $8,
            updated_at = NOW(), created_by = COALESCE(created_by, $9)
      WHERE id = $1
      RETURNING id, label, match_type, value, action, alias_prefix, case_insensitive, enabled, created_at, updated_at`,
    [
      id,
      input.label,
      input.match_type,
      input.value,
      input.action,
      input.action === "pseudonymize" ? input.alias_prefix ?? null : null,
      input.case_insensitive,
      input.enabled,
      userId,
    ]
  );
  invalidateSanitizerOverlay();
  return rows[0] ?? null;
}

export async function deleteCustomRule(id: string): Promise<boolean> {
  const { rowCount } = await query("DELETE FROM sanitizer_custom_rules WHERE id = $1", [id]);
  invalidateSanitizerOverlay();
  return (rowCount ?? 0) > 0;
}
