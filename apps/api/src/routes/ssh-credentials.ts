import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { query } from "../db/pool.js";
import { encrypt } from "../services/crypto.js";
import { audit } from "../services/audit.js";

const Create = z
  .object({
    label: z.string().min(1).max(120),
    protocol: z.enum(["ssh", "telnet"]).default("ssh"),
    host: z.string().min(1).max(255),
    port: z.number().int().min(1).max(65535).default(22),
    username: z.string().min(1).max(80),
    auth_type: z.enum(["password", "key"]),
    // Telnet credentials may be saved without a stored password (interactive
    // login at the prompt); SSH always needs a non-empty secret.
    secret: z.string().max(50_000).default(""),
    bastion_host: z.string().max(255).optional(),
    bastion_port: z.number().int().min(1).max(65535).optional(),
    bastion_username: z.string().max(80).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.protocol === "telnet" && data.auth_type === "key") {
      ctx.addIssue({
        path: ["auth_type"],
        code: z.ZodIssueCode.custom,
        message: "telnet_requires_password_auth",
      });
    }
    if (data.protocol === "ssh" && data.secret.length === 0) {
      ctx.addIssue({
        path: ["secret"],
        code: z.ZodIssueCode.custom,
        message: "ssh_requires_secret",
      });
    }
  });

export async function sshCredentialRoutes(app: FastifyInstance): Promise<void> {
  app.get("/ssh-credentials", { preHandler: requireAuth }, async (req, reply) => {
    const { rows } = await query(
      `SELECT id, label, protocol, host, port, username, auth_type, bastion_host, bastion_port, bastion_username, created_at, updated_at
         FROM ssh_credentials
        WHERE user_id = $1
        ORDER BY label`,
      [req.user!.sub]
    );
    reply.send(rows);
  });

  app.post("/ssh-credentials", { preHandler: requireAuth }, async (req, reply) => {
    const body = Create.parse(req.body);
    // Encrypt even an empty secret so the column stays NOT NULL and the
    // envelope (iv + auth_tag + ciphertext) is uniformly shaped.
    const enc = encrypt(body.secret);
    const { rows } = await query(
      `INSERT INTO ssh_credentials
        (user_id, label, protocol, host, port, username, auth_type, encrypted_secret, iv, auth_tag,
         bastion_host, bastion_port, bastion_username)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id, label, protocol, host, port, username, auth_type, bastion_host, bastion_port, bastion_username, created_at, updated_at`,
      [
        req.user!.sub,
        body.label,
        body.protocol,
        body.host,
        body.port,
        body.username,
        body.auth_type,
        enc.ciphertext,
        enc.iv,
        enc.auth_tag,
        body.bastion_host ?? null,
        body.bastion_port ?? null,
        body.bastion_username ?? null,
      ]
    );
    await audit(req.user!.sub, "ssh_credential.created", {
      credential_id: rows[0].id,
      protocol: body.protocol,
      host: body.host,
    });
    reply.code(201).send(rows[0]);
  });

  app.delete("/ssh-credentials/:id", { preHandler: requireAuth }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const { rowCount } = await query(
      "DELETE FROM ssh_credentials WHERE id = $1 AND user_id = $2",
      [id, req.user!.sub]
    );
    if (!rowCount) {
      reply.code(404).send({ error: "not_found" });
      return;
    }
    await audit(req.user!.sub, "ssh_credential.deleted", { credential_id: id });
    reply.code(204).send();
  });
}
