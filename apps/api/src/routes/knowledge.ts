import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../auth/middleware.js";
import { query, withTx } from "../db/pool.js";
import { storage } from "../services/storage.js";
import { audit } from "../services/audit.js";
import { enqueueIngest } from "../services/queue.js";
import { retrieve } from "../services/retrieval.js";
import { config } from "../config.js";

const Visibility = z.enum(["private", "group", "global"]);

const Metadata = z.object({
  vendor: z.string().max(80).optional(),
  domain: z.string().max(80).optional(),
  product: z.string().max(80).optional(),
  version: z.string().max(80).optional(),
  document_type: z.string().max(80).optional(),
  document_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  visibility: Visibility.default("private"),
  group_ids: z.array(z.string().uuid()).max(50).default([]),
});

const TestSearch = z.object({
  q: z.string().min(1).max(2000),
  vendor: z.string().optional(),
  domain: z.string().optional(),
  product: z.string().optional(),
  version: z.string().optional(),
});

export async function knowledgeRoutes(app: FastifyInstance): Promise<void> {
  app.post("/knowledge/documents/upload", { preHandler: requireAdmin }, async (req, reply) => {
    const file = await req.file();
    if (!file) {
      reply.code(400).send({ error: "no_file" });
      return;
    }

    const buffers: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of file.file) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.byteLength;
      if (totalBytes > config.uploadMaxBytes) {
        reply.code(413).send({ error: "file_too_large" });
        return;
      }
      buffers.push(buf);
    }
    const data = Buffer.concat(buffers);

    const meta = Metadata.parse(
      Object.fromEntries(
        Object.entries(file.fields).map(([k, v]) => {
          const val = Array.isArray(v) ? v[0] : v;
          if (val && typeof val === "object" && "value" in val) return [k, (val as { value: unknown }).value];
          return [k, val];
        })
      )
    );

    const stored = await storage.put(data, file.filename);
    const result = await withTx(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO documents
           (filename, mime, owner_user_id, visibility, vendor, domain, product, version,
            document_type, document_date, status, object_storage_key, byte_size)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'queued',$11,$12)
         RETURNING id`,
        [
          file.filename,
          file.mimetype,
          req.user!.sub,
          meta.visibility,
          meta.vendor ?? null,
          meta.domain ?? null,
          meta.product ?? null,
          meta.version ?? null,
          meta.document_type ?? null,
          meta.document_date ?? null,
          stored.key,
          stored.bytes,
        ]
      );
      const docId = rows[0].id;
      if (meta.visibility === "group" && meta.group_ids.length) {
        for (const gid of meta.group_ids) {
          await client.query(
            "INSERT INTO document_acl (document_id, group_id, access_level) VALUES ($1,$2,'read') ON CONFLICT DO NOTHING",
            [docId, gid]
          );
        }
      }
      return docId;
    });

    await audit(req.user!.sub, "knowledge.document_uploaded", {
      document_id: result,
      filename: file.filename,
      visibility: meta.visibility,
      group_ids: meta.group_ids,
    });
    await enqueueIngest(result);
    reply.code(201).send({ id: result, status: "queued" });
  });

  app.get("/knowledge/documents", { preHandler: requireAuth }, async (req, reply) => {
    const isAdmin = req.user!.role === "admin";
    const { rows } = isAdmin
      ? await query(
          `SELECT id, filename, mime, owner_user_id, visibility, vendor, domain, product, version,
                  document_type, document_date, status, error_message, byte_size, created_at
             FROM documents ORDER BY created_at DESC LIMIT 500`
        )
      : await query(
          `SELECT d.id, d.filename, d.mime, d.owner_user_id, d.visibility, d.vendor, d.domain,
                  d.product, d.version, d.document_type, d.document_date, d.status, d.byte_size, d.created_at
             FROM documents d
            WHERE d.visibility = 'global'
               OR d.owner_user_id = $1
               OR EXISTS (SELECT 1 FROM document_acl a WHERE a.document_id = d.id AND a.group_id = ANY($2::uuid[]))
            ORDER BY d.created_at DESC LIMIT 500`,
          [req.user!.sub, req.user!.group_ids]
        );
    reply.send(rows);
  });

  app.get("/knowledge/documents/:id", { preHandler: requireAuth }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const isAdmin = req.user!.role === "admin";
    const { rows } = isAdmin
      ? await query("SELECT * FROM documents WHERE id = $1", [id])
      : await query(
          `SELECT * FROM documents d WHERE d.id = $1 AND (
             d.visibility = 'global'
             OR d.owner_user_id = $2
             OR EXISTS (SELECT 1 FROM document_acl a WHERE a.document_id = d.id AND a.group_id = ANY($3::uuid[]))
           )`,
          [id, req.user!.sub, req.user!.group_ids]
        );
    if (!rows[0]) {
      reply.code(404).send({ error: "not_found" });
      return;
    }
    const { rows: acl } = await query(
      `SELECT g.id, g.name FROM document_acl a JOIN user_groups g ON g.id = a.group_id WHERE a.document_id = $1`,
      [id]
    );
    reply.send({ ...rows[0], acl });
  });

  app.post("/knowledge/documents/:id/reindex", { preHandler: requireAdmin }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const { rows } = await query("SELECT id FROM documents WHERE id = $1", [id]);
    if (!rows[0]) {
      reply.code(404).send({ error: "not_found" });
      return;
    }
    await query(
      "UPDATE documents SET status = 'queued', error_message = NULL, updated_at = NOW() WHERE id = $1",
      [id]
    );
    await query("DELETE FROM rag_chunks WHERE document_id = $1", [id]);
    await enqueueIngest(id);
    await audit(req.user!.sub, "knowledge.document_indexed", { document_id: id, action: "reindex" });
    reply.send({ id, status: "queued" });
  });

  app.patch("/knowledge/documents/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = z
      .object({
        visibility: Visibility.optional(),
        group_ids: z.array(z.string().uuid()).optional(),
      })
      .parse(req.body);
    await withTx(async (client) => {
      if (body.visibility) {
        await client.query("UPDATE documents SET visibility = $1, updated_at = NOW() WHERE id = $2", [body.visibility, id]);
      }
      if (body.group_ids !== undefined) {
        await client.query("DELETE FROM document_acl WHERE document_id = $1", [id]);
        for (const gid of body.group_ids) {
          await client.query(
            "INSERT INTO document_acl (document_id, group_id, access_level) VALUES ($1,$2,'read') ON CONFLICT DO NOTHING",
            [id, gid]
          );
        }
      }
    });
    await audit(req.user!.sub, "knowledge.document_visibility_changed", {
      document_id: id,
      visibility: body.visibility,
      group_ids: body.group_ids,
    });
    reply.send({ ok: true });
  });

  app.delete("/knowledge/documents/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const { rows } = await query<{ object_storage_key: string }>(
      "SELECT object_storage_key FROM documents WHERE id = $1",
      [id]
    );
    if (!rows[0]) {
      reply.code(404).send({ error: "not_found" });
      return;
    }
    await query("DELETE FROM documents WHERE id = $1", [id]);
    try { await storage.delete(rows[0].object_storage_key); } catch { /* tolerate */ }
    await audit(req.user!.sub, "knowledge.document_deleted", { document_id: id });
    reply.send({ ok: true });
  });

  app.post("/knowledge/test-search", { preHandler: requireAuth }, async (req, reply) => {
    const body = TestSearch.parse(req.body);
    const r = await retrieve(req.user!.sub, req.user!.group_ids, body.q, {
      vendor: body.vendor,
      domain: body.domain,
      product: body.product,
      version: body.version,
    });
    reply.send({
      high_confidence: r.high_confidence,
      results: r.chunks.map((c) => ({
        document_id: c.document_id,
        filename: c.filename,
        source_pointer: c.source_pointer,
        score: c.combined_score,
        text: c.text.slice(0, 800),
      })),
    });
  });
}
