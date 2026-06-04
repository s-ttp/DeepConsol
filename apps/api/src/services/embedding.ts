import { config } from "../config.js";
import { logger } from "../logger.js";
import { query } from "../db/pool.js";
import { decrypt, encrypt } from "./crypto.js";

/**
 * Embedding configuration service.
 *
 * Embeddings are deliberately kept on Gemini (see migration 005): the
 * rag_chunks.embedding column is fixed at vector(3072), so the provider is
 * locked and only the *model*, *API key*, and *base URL* are admin-tunable.
 *
 * The active config lives in the singleton `embedding_config` row. Unlike the
 * chat config (which is invalidated in-process by the admin route), embeddings
 * are also resolved from the *worker* process — a different OS process that
 * never sees `invalidateEmbeddingConfig()`. So instead of a permanent cache we
 * use a short TTL: a saved change is picked up by the worker within `CACHE_TTL`
 * without a restart. `invalidateEmbeddingConfig()` still gives the API process
 * an immediate refresh after a PUT.
 *
 * This module intentionally does NOT import ./gemini.js — gemini.ts imports the
 * resolver/low-level call from here, so a back-import would create a cycle.
 */

export const EMBEDDING_PROVIDER = "gemini" as const;

export const EMBEDDING_DEFAULTS = {
  model: "gemini-embedding-001",
  api_base: "https://generativelanguage.googleapis.com/v1beta",
};

/** Must match the rag_chunks.embedding column dimension (migration 002). */
export const EXPECTED_EMBEDDING_DIM = 3072;

const CACHE_TTL_MS = 30_000;

export class EmbeddingApiError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`Embedding API error ${status}: ${body.slice(0, 500)}`);
    this.name = "EmbeddingApiError";
  }
}

export interface ResolvedEmbeddingConfig {
  provider: typeof EMBEDDING_PROVIDER;
  model: string;
  apiBase: string;
  apiKey: string; // resolved (decrypted DB value or env fallback)
  hasKey: boolean; // true when apiKey is usable
  dimension: number;
}

interface RawRow {
  provider: typeof EMBEDDING_PROVIDER;
  embedding_model: string;
  api_base: string | null;
  encrypted_api_key: string;
  iv: string;
  auth_tag: string;
  has_api_key: boolean;
  dimension: number;
}

let cached: { value: ResolvedEmbeddingConfig; at: number } | null = null;

export function invalidateEmbeddingConfig(): void {
  cached = null;
}

export async function getActiveEmbeddingConfig(): Promise<ResolvedEmbeddingConfig> {
  const nowTs = cached ? cached.at : 0;
  if (cached && performanceNow() - nowTs < CACHE_TTL_MS) return cached.value;

  const { rows } = await query<RawRow>(
    `SELECT provider, embedding_model, api_base, encrypted_api_key, iv, auth_tag, has_api_key, dimension
       FROM embedding_config WHERE id = 1`
  );
  if (!rows[0]) {
    // Migration 005 seeds row 1; if we're here, fall back to env defaults so
    // ingestion/retrieval degrade gracefully rather than throwing.
    const fallback = resolveRow({
      provider: EMBEDDING_PROVIDER,
      embedding_model: config.geminiEmbeddingModel || EMBEDDING_DEFAULTS.model,
      api_base: null,
      encrypted_api_key: "",
      iv: "",
      auth_tag: "",
      has_api_key: false,
      dimension: EXPECTED_EMBEDDING_DIM,
    });
    cached = { value: fallback, at: performanceNow() };
    return fallback;
  }
  const value = resolveRow(rows[0]);
  cached = { value, at: performanceNow() };
  return value;
}

function resolveRow(row: RawRow): ResolvedEmbeddingConfig {
  const apiBase = row.api_base && row.api_base.length > 0 ? row.api_base : EMBEDDING_DEFAULTS.api_base;
  let apiKey = "";
  if (row.has_api_key && row.encrypted_api_key) {
    try {
      apiKey = decrypt({ ciphertext: row.encrypted_api_key, iv: row.iv, auth_tag: row.auth_tag });
    } catch (err) {
      logger.error({ err }, "failed to decrypt embedding_config api_key — falling back to env");
      apiKey = "";
    }
  }
  // Env fallback — embeddings are gemini-only, so GEMINI_API_KEY is the fallback.
  if (!apiKey) apiKey = config.geminiApiKey ?? "";
  return {
    provider: EMBEDDING_PROVIDER,
    model: row.embedding_model,
    apiBase,
    apiKey,
    hasKey: apiKey.length > 0 && !apiKey.startsWith("REPLACE_ME"),
    dimension: row.dimension,
  };
}

/** True when the resolved embedding config can actually call out. */
export async function embeddingConfigured(): Promise<boolean> {
  const cfg = await getActiveEmbeddingConfig();
  return cfg.hasKey;
}

/** Encrypt a plaintext API key for storage. */
export function packApiKey(plaintext: string): { ciphertext: string; iv: string; auth_tag: string } {
  return encrypt(plaintext);
}

/**
 * Low-level Gemini embedContent call. Kept here (not in gemini.ts) so the
 * resolver and the call live together and gemini.ts can depend on this module
 * without a cycle. Returns the raw embedding vector.
 */
export async function requestEmbedding(
  model: string,
  apiBase: string,
  apiKey: string,
  text: string
): Promise<number[]> {
  const url = `${apiBase}/models/${encodeURIComponent(model)}:embedContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: { parts: [{ text }] } }),
  });
  if (!res.ok) {
    throw new EmbeddingApiError(res.status, await res.text().catch(() => ""));
  }
  const data = (await res.json()) as { embedding?: { values?: number[] } };
  const values = data.embedding?.values;
  if (!values || values.length === 0) {
    throw new EmbeddingApiError(res.status, "no embedding values in response");
  }
  return values;
}

/**
 * One-shot embedding "ping" used by the admin Test button. Embeds a tiny string
 * and reports the returned dimension, flagging when it won't fit the fixed
 * rag_chunks column. `override` lets an admin test an unsaved candidate.
 */
export async function testEmbedding(
  override?: { model?: string; apiBase?: string; apiKeyPlain?: string }
): Promise<{
  ok: boolean;
  model: string;
  dimension?: number;
  expected_dimension: number;
  dimension_ok?: boolean;
  error?: string;
}> {
  const base = await getActiveEmbeddingConfig().catch(() => null);
  const model = override?.model ?? base?.model ?? EMBEDDING_DEFAULTS.model;
  const apiBase = override?.apiBase ?? base?.apiBase ?? EMBEDDING_DEFAULTS.api_base;
  const apiKey = override?.apiKeyPlain ?? base?.apiKey ?? "";
  if (!apiKey || apiKey.startsWith("REPLACE_ME")) {
    return { ok: false, model, expected_dimension: EXPECTED_EMBEDDING_DIM, error: "missing_api_key" };
  }
  try {
    const values = await requestEmbedding(model, apiBase, apiKey, "DeepConsol embedding connection test.");
    const dimension = values.length;
    return {
      ok: true,
      model,
      dimension,
      expected_dimension: EXPECTED_EMBEDDING_DIM,
      dimension_ok: dimension === EXPECTED_EMBEDDING_DIM,
    };
  } catch (err) {
    const msg =
      err instanceof EmbeddingApiError ? `${err.status}: ${err.body.slice(0, 240)}` : (err as Error).message;
    return { ok: false, model, expected_dimension: EXPECTED_EMBEDDING_DIM, error: msg };
  }
}

// `performance.now()` is monotonic and available in Node 20+ globals; isolating
// it here keeps the TTL math readable and easy to stub in tests.
function performanceNow(): number {
  return performance.now();
}
