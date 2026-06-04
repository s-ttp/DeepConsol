import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hashPassword } from "../auth/password.js";
import { requireAdmin, requireAuth } from "../auth/middleware.js";
import { query } from "../db/pool.js";
import { audit } from "../services/audit.js";

const CreateUser = z.object({
  email: z.string().email(),
  password: z.string().min(10).max(200),
  role: z.enum(["engineer", "admin"]).default("engineer"),
  must_rotate_password: z.boolean().default(true),
});

const UpdateUser = z.object({
  role: z.enum(["engineer", "admin"]).optional(),
  password: z.string().min(10).max(200).optional(),
  must_rotate_password: z.boolean().optional(),
});

export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.get("/admin/users", { preHandler: requireAdmin }, async (_req, reply) => {
    const { rows } = await query(
      "SELECT id, email, role, must_rotate_password, created_at FROM users ORDER BY created_at"
    );
    reply.send(rows);
  });

  app.post("/admin/users", { preHandler: requireAdmin }, async (req, reply) => {
    const body = CreateUser.parse(req.body);
    const hash = await hashPassword(body.password);
    try {
      const { rows } = await query(
        "INSERT INTO users (email, password_hash, role, must_rotate_password) VALUES ($1,$2,$3,$4) RETURNING id, email, role, must_rotate_password, created_at",
        [body.email.toLowerCase(), hash, body.role, body.must_rotate_password]
      );
      await audit(req.user?.sub ?? null, "user.created", { user_id: rows[0].id, email: body.email });
      reply.code(201).send(rows[0]);
    } catch (err: unknown) {
      const e = err as { code?: string };
      if (e.code === "23505") {
        reply.code(409).send({ error: "email_already_exists" });
        return;
      }
      throw err;
    }
  });

  app.patch("/admin/users/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = UpdateUser.parse(req.body);
    const sets: string[] = [];
    const params: unknown[] = [];
    if (body.role) { params.push(body.role); sets.push(`role = $${params.length}`); }
    if (body.password) {
      params.push(await hashPassword(body.password));
      sets.push(`password_hash = $${params.length}`);
    }
    if (body.must_rotate_password !== undefined) {
      params.push(body.must_rotate_password);
      sets.push(`must_rotate_password = $${params.length}`);
    }
    if (!sets.length) {
      reply.code(400).send({ error: "no_fields_to_update" });
      return;
    }
    params.push(id);
    const { rows } = await query(
      `UPDATE users SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $${params.length} RETURNING id, email, role, must_rotate_password, created_at`,
      params
    );
    if (!rows[0]) {
      reply.code(404).send({ error: "user_not_found" });
      return;
    }
    await audit(req.user?.sub ?? null, "user.updated", { user_id: id, fields: Object.keys(body) });
    reply.send(rows[0]);
  });

  app.get("/admin/users/:id/groups", { preHandler: requireAdmin }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const { rows } = await query(
      `SELECT g.id, g.name, m.role_in_group
       FROM user_group_memberships m
       JOIN user_groups g ON g.id = m.group_id
       WHERE m.user_id = $1
       ORDER BY g.name`,
      [id]
    );
    reply.send(rows);
  });

  app.get("/users/me/audit", { preHandler: requireAuth }, async (req, reply) => {
    const { rows } = await query(
      "SELECT id, event_type, metadata_json, created_at FROM audit_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100",
      [req.user!.sub]
    );
    reply.send(rows);
  });
}
