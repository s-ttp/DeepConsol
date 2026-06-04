import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "../auth/middleware.js";
import { query } from "../db/pool.js";
import { audit } from "../services/audit.js";
import {
  PROVIDER_DEFAULTS,
  PROVIDER_LABELS,
  getActiveConfig,
  invalidateActiveConfig,
  packApiKey,
  testChat,
  type LlmProviderName,
} from "../services/llm.js";

const Provider = z.enum(["gemini", "openai", "anthropic"]);

// PUT body — `api_key` is the *plaintext* admin-supplied key. Empty string
// means "leave the stored key unchanged"; explicit null means "clear it and
// fall back to env-var (gemini-only) or unconfigured".
const PutBody = z.object({
  provider: Provider,
  chat_model: z.string().min(1).max(120),
  api_base: z.string().url().max(255).optional().nullable(),
  api_key: z.string().max(500).optional().nullable(),
});

const TestBody = z.object({
  // All optional — when omitted we test the currently saved config; when
  // present we test the candidate without persisting.
  provider: Provider.optional(),
  chat_model: z.string().min(1).max(120).optional(),
  api_base: z.string().url().max(255).optional().nullable(),
  api_key: z.string().max(500).optional(),
});

export async function llmConfigRoutes(app: FastifyInstance): Promise<void> {
  // Static catalog so the admin UI can render dropdowns without a hardcoded
  // duplicate. Lists each provider's display label + default model + base URL.
  app.get("/admin/llm-config/providers", { preHandler: requireAdmin }, async (_req, reply) => {
    const providers = (Object.keys(PROVIDER_LABELS) as LlmProviderName[]).map((p) => ({
      id: p,
      label: PROVIDER_LABELS[p],
      default_model: PROVIDER_DEFAULTS[p].model,
      default_api_base: PROVIDER_DEFAULTS[p].api_base,
      // Whether this provider falls back to the GEMINI_API_KEY env var when
      // no key is saved; only true for gemini.
      env_fallback: p === "gemini",
    }));
    reply.send({ providers });
  });

  app.get("/admin/llm-config", { preHandler: requireAdmin }, async (_req, reply) => {
    const { rows } = await query<{
      provider: LlmProviderName;
      chat_model: string;
      api_base: string | null;
      has_api_key: boolean;
      updated_at: Date;
      updated_by: string | null;
    }>(
      "SELECT provider, chat_model, api_base, has_api_key, updated_at, updated_by FROM llm_config WHERE id = 1"
    );
    if (!rows[0]) {
      reply.code(404).send({ error: "llm_config_missing" });
      return;
    }
    const cfg = await getActiveConfig().catch(() => null);
    reply.send({
      provider: rows[0].provider,
      chat_model: rows[0].chat_model,
      api_base: rows[0].api_base,
      has_api_key: rows[0].has_api_key,
      // Whether chat is *actually* able to call out — accounts for the env-var
      // fallback when has_api_key is false but provider=gemini and env is set.
      effectively_configured: cfg?.hasKey ?? false,
      updated_at: rows[0].updated_at,
      updated_by: rows[0].updated_by,
    });
  });

  app.put("/admin/llm-config", { preHandler: requireAdmin }, async (req, reply) => {
    const body = PutBody.parse(req.body);
    const apiBase = body.api_base ?? null;

    // Three-state logic for api_key:
    //  - undefined  → leave stored key unchanged (admin only edited model/provider)
    //  - null/""    → clear the stored key
    //  - non-empty  → encrypt + store
    let nextEnc: { ciphertext: string; iv: string; auth_tag: string } | null | undefined;
    if (body.api_key === undefined) {
      nextEnc = undefined; // unchanged
    } else if (body.api_key === null || body.api_key === "") {
      nextEnc = null; // clear
    } else {
      nextEnc = packApiKey(body.api_key);
    }

    if (nextEnc === undefined) {
      await query(
        `UPDATE llm_config
            SET provider = $1,
                chat_model = $2,
                api_base = $3,
                updated_at = NOW(),
                updated_by = $4
          WHERE id = 1`,
        [body.provider, body.chat_model, apiBase, req.user!.sub]
      );
    } else if (nextEnc === null) {
      await query(
        `UPDATE llm_config
            SET provider = $1,
                chat_model = $2,
                api_base = $3,
                encrypted_api_key = '',
                iv = '',
                auth_tag = '',
                has_api_key = FALSE,
                updated_at = NOW(),
                updated_by = $4
          WHERE id = 1`,
        [body.provider, body.chat_model, apiBase, req.user!.sub]
      );
    } else {
      await query(
        `UPDATE llm_config
            SET provider = $1,
                chat_model = $2,
                api_base = $3,
                encrypted_api_key = $4,
                iv = $5,
                auth_tag = $6,
                has_api_key = TRUE,
                updated_at = NOW(),
                updated_by = $7
          WHERE id = 1`,
        [body.provider, body.chat_model, apiBase, nextEnc.ciphertext, nextEnc.iv, nextEnc.auth_tag, req.user!.sub]
      );
    }

    invalidateActiveConfig();
    await audit(req.user!.sub, "llm_config.updated", {
      provider: body.provider,
      chat_model: body.chat_model,
      key_change: nextEnc === undefined ? "unchanged" : nextEnc === null ? "cleared" : "set",
    });

    const cfg = await getActiveConfig();
    reply.send({
      provider: cfg.provider,
      chat_model: cfg.chatModel,
      api_base: cfg.apiBase,
      has_api_key: nextEnc !== null && (nextEnc !== undefined || (await isHasKey())),
      effectively_configured: cfg.hasKey,
    });
  });

  app.post("/admin/llm-config/test", { preHandler: requireAdmin }, async (req, reply) => {
    const body = TestBody.parse(req.body ?? {});
    const result = await testChat({
      provider: body.provider,
      chatModel: body.chat_model,
      apiBase: body.api_base ?? undefined,
      apiKeyPlain: body.api_key,
    });
    await audit(req.user!.sub, "llm_config.tested", {
      provider: result.provider,
      chat_model: result.model,
      ok: result.ok,
      candidate: Boolean(body.provider || body.chat_model || body.api_key),
    });
    reply.code(result.ok ? 200 : 502).send(result);
  });
}

async function isHasKey(): Promise<boolean> {
  const { rows } = await query<{ has_api_key: boolean }>(
    "SELECT has_api_key FROM llm_config WHERE id = 1"
  );
  return rows[0]?.has_api_key ?? false;
}
