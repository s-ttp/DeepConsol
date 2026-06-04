import "dotenv/config";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { config } from "@deepconsol/api/config";
import { logger } from "@deepconsol/api/logger";
import { installProxyDispatcher } from "@deepconsol/api/proxy";
import { pool, query } from "@deepconsol/api/db/pool";
import { storage } from "@deepconsol/api/services/storage";
import { embed, GeminiNotConfiguredError } from "@deepconsol/api/services/gemini";
import { embeddingConfigured } from "@deepconsol/api/services/embedding";
import { getSanitizerOverlay } from "@deepconsol/api/services/sanitizer-config";
import { audit } from "@deepconsol/api/services/audit";
import { sanitize } from "@deepconsol/shared/sanitizer";
import { parseDocument } from "./parsers/index.js";
import { chunkSections } from "./chunker.js";

const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

interface IngestJob {
  document_id: string;
}

async function setStatus(documentId: string, status: string, error?: string): Promise<void> {
  await query(
    "UPDATE documents SET status = $1, error_message = $2, updated_at = NOW() WHERE id = $3",
    [status, error ?? null, documentId]
  );
}

async function ingest(documentId: string): Promise<void> {
  const { rows } = await query<{
    id: string;
    filename: string;
    mime: string;
    object_storage_key: string;
    owner_user_id: string;
  }>(
    "SELECT id, filename, mime, object_storage_key, owner_user_id FROM documents WHERE id = $1",
    [documentId]
  );
  const doc = rows[0];
  if (!doc) {
    logger.warn({ documentId }, "ingest: document not found, skipping");
    return;
  }

  await setStatus(documentId, "parsing");
  const data = await storage.read(doc.object_storage_key);
  const parsed = await parseDocument(doc.filename, doc.mime, data);
  if (parsed.sections.length === 0) {
    throw new Error("no_text_extracted");
  }

  // Sanitize at ingestion: secrets/PII never enter the embedding store, so
  // they can't be recalled by a later RAG query. Uses the admin overlay
  // (custom rules + disabled built-ins), resolved once per job.
  const sanitizerOverlay = await getSanitizerOverlay();
  const sanitizedSections = parsed.sections.map((s) => ({
    ...s,
    text: sanitize(s.text, {}, sanitizerOverlay).sanitized,
  }));

  const chunks = chunkSections(
    sanitizedSections,
    config.ingestChunkTargetTokens,
    config.ingestChunkOverlapTokens
  );
  if (chunks.length === 0) {
    throw new Error("no_chunks_after_chunking");
  }

  await setStatus(documentId, "embedding");
  await query("DELETE FROM rag_chunks WHERE document_id = $1", [documentId]);

  // Resolve the active embedding config once per job (admin-managed model + key,
  // env fallback). When unconfigured, chunks are stored text-only so keyword
  // search still works and a later Reindex can backfill vectors.
  const canEmbed = await embeddingConfigured();

  let embeddedCount = 0;
  let textOnlyCount = 0;
  for (const c of chunks) {
    let vector: number[] | null = null;
    if (canEmbed) {
      try {
        vector = await embed(c.text);
      } catch (err) {
        if (err instanceof GeminiNotConfiguredError) {
          vector = null;
        } else {
          logger.warn({ err: (err as Error).message, documentId, chunk_index: c.chunk_index }, "embed failed; storing chunk text-only");
          vector = null;
        }
      }
    }
    if (vector) embeddedCount += 1; else textOnlyCount += 1;
    await query(
      `INSERT INTO rag_chunks (document_id, chunk_index, text, source_pointer, metadata_json, embedding)
       VALUES ($1, $2, $3, $4, $5, ${vector ? `$6::vector` : "NULL"})`,
      vector
        ? [documentId, c.chunk_index, c.text, c.source_pointer, c.metadata, `[${vector.join(",")}]`]
        : [documentId, c.chunk_index, c.text, c.source_pointer, c.metadata]
    );
  }

  await setStatus(documentId, "ready");
  await audit(doc.owner_user_id, "knowledge.document_indexed", {
    document_id: documentId,
    chunks: chunks.length,
    embedded: embeddedCount,
    text_only: textOnlyCount,
    gemini_configured: canEmbed,
  });
  logger.info(
    { documentId, chunks: chunks.length, embedded: embeddedCount, text_only: textOnlyCount },
    "document ingested"
  );
}

async function main(): Promise<void> {
  installProxyDispatcher();
  const worker = new Worker<IngestJob>(
    "deepconsol-ingest",
    async (job) => {
      const docId = job.data.document_id;
      logger.info({ docId, attempt: job.attemptsMade + 1 }, "ingest job start");
      try {
        await ingest(docId);
      } catch (err) {
        const msg = (err as Error).message ?? "unknown";
        logger.error({ err: msg, docId }, "ingest job failed");
        await setStatus(docId, "error", msg);
        throw err;
      }
    },
    { connection, concurrency: 2 }
  );

  worker.on("ready", () => logger.info("ingest worker ready"));
  worker.on("error", (err) => logger.error({ err }, "worker error"));

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "worker shutting down");
    await worker.close();
    await connection.quit();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.error({ err }, "worker fatal");
  process.exit(1);
});
