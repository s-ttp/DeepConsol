import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "../auth/middleware.js";
import { query } from "../db/pool.js";
import { audit } from "../services/audit.js";
import {
  EMBEDDING_DEFAULTS,
  EXPECTED_EMBEDDING_DIM,
  getActiveEmbeddingConfig,
  invalidateEmbeddingConfig,
  packApiKey,
  testEmbedding,
} from "../services/embedding.js";

// `api_key` is the *plaintext* admin-supplied key. undefined → leave stored
// key unchanged; null/"" → clear it (fall back to GEMINI_API_KEY env var);
// non-empty → encrypt + store. Mirrors the llm-config three-state logic.
const PutBody = z.object({
  embedding_model: z.string().min(1).max(120),
  api_base: z.string().url().max(255).optional().nullable(),
  api_key: z.string().max(500).optional().nullable(),
});

const TestBody = z.object({
  embedding_model: z.string().min(1).max(120).optional(),
  api_base: z.string().url().max(255).optional().nullable(),
  api_key: z.string().max(500).optional(),
});

export async function embeddingConfigRoutes(app: FastifyInstance): Promise<void> {
  app.get("/admin/embedding-config", { preHandler: requireAdmin }, async (_req, reply) => {
    const { rows } = await query<{
      provider: string;
      embedding_model: string;
      api_base: string | null;
      has_api_key: boolean;
      dimension: number;
      updated_at: Date;
      updated_by: string | null;
    }>(
      `SELECT provider, embedding_model, api_base, has_api_key, dimension, updated_at, updated_by
         FROM embedding_config WHERE id = 1`
    );
    if (!rows[0]) {
      reply.code(404).send({ error: "embedding_config_missing" });
      return;
    }
    const cfg = await getActiveEmbeddingConfig().catch(() => null);
    reply.send({
      provider: rows[0].provider,
      embedding_model: rows[0].embedding_model,
      api_base: rows[0].api_base,
      has_api_key: rows[0].has_api_key,
      dimension: rows[0].dimension,
      expected_dimension: EXPECTED_EMBEDDING_DIM,
      default_model: EMBEDDING_DEFAULTS.model,
      default_api_base: EMBEDDING_DEFAULTS.api_base,
      // Accounts for the env-var fallback when has_api_key is false.
      effectively_configured: cfg?.hasKey ?? false,
      updated_at: rows[0].updated_at,
      updated_by: rows[0].updated_by,
    });
  });

  app.put("/admin/embedding-config", { preHandler: requireAdmin }, async (req, reply) => {
    const body = PutBody.parse(req.body);
    const apiBase = body.api_base ?? null;

    let nextEnc: { ciphertext: string; iv: string; auth_tag: string } | null | undefined;
    if (body.api_key === undefined) {
      nextEnc = undefined; // unchanged
    } else if (body.api_key === null || body.api_key === "") {
      nextEnc = null; // clear → env fallback
    } else {
      nextEnc = packApiKey(body.api_key);
    }

    if (nextEnc === undefined) {
      await query(
        `UPDATE embedding_config
            SET embedding_model = $1, api_base = $2, updated_at = NOW(), updated_by = $3
          WHERE id = 1`,
        [body.embedding_model, apiBase, req.user!.sub]
      );
    } else if (nextEnc === null) {
      await query(
        `UPDATE embedding_config
            SET embedding_model = $1, api_base = $2,
                encrypted_api_key = '', iv = '', auth_tag = '', has_api_key = FALSE,
                updated_at = NOW(), updated_by = $3
          WHERE id = 1`,
        [body.embedding_model, apiBase, req.user!.sub]
      );
    } else {
      await query(
        `UPDATE embedding_config
            SET embedding_model = $1, api_base = $2,
                encrypted_api_key = $3, iv = $4, auth_tag = $5, has_api_key = TRUE,
                updated_at = NOW(), updated_by = $6
          WHERE id = 1`,
        [body.embedding_model, apiBase, nextEnc.ciphertext, nextEnc.iv, nextEnc.auth_tag, req.user!.sub]
      );
    }

    invalidateEmbeddingConfig();
    await audit(req.user!.sub, "embedding_config.updated", {
      embedding_model: body.embedding_model,
      key_change: nextEnc === undefined ? "unchanged" : nextEnc === null ? "cleared" : "set",
    });

    const cfg = await getActiveEmbeddingConfig();
    reply.send({
      provider: cfg.provider,
      embedding_model: cfg.model,
      api_base: cfg.apiBase,
      has_api_key: nextEnc !== null && (nextEnc !== undefined || (await isHasKey())),
      dimension: cfg.dimension,
      expected_dimension: EXPECTED_EMBEDDING_DIM,
      effectively_configured: cfg.hasKey,
    });
  });

  app.post("/admin/embedding-config/test", { preHandler: requireAdmin }, async (req, reply) => {
    const body = TestBody.parse(req.body ?? {});
    const result = await testEmbedding({
      model: body.embedding_model,
      apiBase: body.api_base ?? undefined,
      apiKeyPlain: body.api_key,
    });
    await audit(req.user!.sub, "embedding_config.tested", {
      embedding_model: result.model,
      ok: result.ok,
      dimension: result.dimension ?? null,
      candidate: Boolean(body.embedding_model || body.api_key),
    });
    reply.code(result.ok ? 200 : 502).send(result);
  });
}

async function isHasKey(): Promise<boolean> {
  const { rows } = await query<{ has_api_key: boolean }>(
    "SELECT has_api_key FROM embedding_config WHERE id = 1"
  );
  return rows[0]?.has_api_key ?? false;
}
