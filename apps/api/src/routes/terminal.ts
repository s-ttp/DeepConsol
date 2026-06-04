import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { query } from "../db/pool.js";
import { audit } from "../services/audit.js";
import { config } from "../config.js";

const AdHoc = z
  .object({
    protocol: z.enum(["ssh", "telnet"]).default("ssh"),
    host: z.string().min(1).max(255),
    port: z.number().int().min(1).max(65535).default(22),
    // Telnet ad-hoc may omit username (the user will type it at the prompt).
    username: z.string().max(80).default(""),
    auth_type: z.enum(["password", "key"]).default("password"),
    secret: z.string().max(50_000).default(""),
  })
  .superRefine((data, ctx) => {
    if (data.protocol === "ssh") {
      if (!data.username) {
        ctx.addIssue({
          path: ["username"],
          code: z.ZodIssueCode.custom,
          message: "ssh_requires_username",
        });
      }
      if (!data.secret) {
        ctx.addIssue({
          path: ["secret"],
          code: z.ZodIssueCode.custom,
          message: "ssh_requires_secret",
        });
      }
    }
    if (data.protocol === "telnet" && data.auth_type === "key") {
      ctx.addIssue({
        path: ["auth_type"],
        code: z.ZodIssueCode.custom,
        message: "telnet_requires_password_auth",
      });
    }
  });

const Create = z.object({
  credential_id: z.string().uuid().optional(),
  ad_hoc: AdHoc.optional(),
  cols: z.number().int().min(20).max(500).default(120),
  rows: z.number().int().min(5).max(500).default(32),
});

export async function terminalRoutes(app: FastifyInstance): Promise<void> {
  app.post("/terminal/sessions", { preHandler: requireAuth }, async (req, reply) => {
    const body = Create.parse(req.body);
    if (!body.credential_id && !body.ad_hoc) {
      reply.code(400).send({ error: "credential_id_or_ad_hoc_required" });
      return;
    }
    const { rows: existing } = await query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM terminal_sessions WHERE user_id = $1 AND ended_at IS NULL",
      [req.user!.sub]
    );
    if (existing[0].count >= config.terminalMaxSessionsPerUser) {
      reply.code(429).send({ error: "too_many_active_sessions" });
      return;
    }
    let target = "ad-hoc";
    if (body.credential_id) {
      const { rows: c } = await query<{ protocol: string; host: string; port: number; username: string }>(
        "SELECT protocol, host, port, username FROM ssh_credentials WHERE id = $1 AND user_id = $2",
        [body.credential_id, req.user!.sub]
      );
      if (!c[0]) {
        reply.code(404).send({ error: "credential_not_found" });
        return;
      }
      target = `${c[0].protocol}://${c[0].username || "?"}@${c[0].host}:${c[0].port}`;
    } else if (body.ad_hoc) {
      const userPart = body.ad_hoc.username || "?";
      target = `${body.ad_hoc.protocol}://${userPart}@${body.ad_hoc.host}:${body.ad_hoc.port}`;
    }
    const { rows } = await query<{ id: string }>(
      `INSERT INTO terminal_sessions (user_id, credential_id, target, metadata_json)
       VALUES ($1, $2, $3, $4) RETURNING id, started_at`,
      [
        req.user!.sub,
        body.credential_id ?? null,
        target,
        { cols: body.cols, rows: body.rows, ad_hoc: !!body.ad_hoc },
      ]
    );
    await audit(req.user!.sub, "terminal.session_started", {
      session_id: rows[0].id,
      target,
      credential_id: body.credential_id ?? null,
    });

    // Cache the ad-hoc credentials in Redis for the WS gateway to consume on
    // attach. They are wiped on first read or after 60s.
    if (body.ad_hoc) {
      const { redisConnection } = await import("../services/queue.js");
      const { encrypt } = await import("../services/crypto.js");
      const enc = encrypt(JSON.stringify(body.ad_hoc));
      await redisConnection.setex(
        `deepconsol:term:adhoc:${rows[0].id}`,
        60,
        JSON.stringify(enc)
      );
    }

    reply.code(201).send({
      id: rows[0].id,
      target,
      ws_path: `/terminal/connect/${rows[0].id}`,
    });
  });

  app.get("/terminal/sessions", { preHandler: requireAuth }, async (req, reply) => {
    const { rows } = await query(
      `SELECT id, target, started_at, ended_at, metadata_json
         FROM terminal_sessions
        WHERE user_id = $1
        ORDER BY started_at DESC
        LIMIT 100`,
      [req.user!.sub]
    );
    reply.send(rows);
  });

  app.post("/terminal/sessions/:id/close", { preHandler: requireAuth }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const { rowCount } = await query(
      "UPDATE terminal_sessions SET ended_at = NOW() WHERE id = $1 AND user_id = $2 AND ended_at IS NULL",
      [id, req.user!.sub]
    );
    if (!rowCount) {
      reply.code(404).send({ error: "not_found_or_already_closed" });
      return;
    }
    await audit(req.user!.sub, "terminal.session_ended", { session_id: id, reason: "user_close" });
    reply.code(204).send();
  });
}
