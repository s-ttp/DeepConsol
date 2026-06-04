import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../auth/middleware.js";
import { query } from "../db/pool.js";
import { audit } from "../services/audit.js";

const CreateGroup = z.object({
  name: z.string().min(2).max(80),
  description: z.string().max(500).optional(),
});

const AddMember = z.object({
  user_id: z.string().uuid(),
  role_in_group: z.string().max(40).default("member"),
});

export async function groupRoutes(app: FastifyInstance): Promise<void> {
  app.get("/admin/groups", { preHandler: requireAdmin }, async (_req, reply) => {
    const { rows } = await query(
      `SELECT g.id, g.name, g.description, g.created_at,
              COALESCE((SELECT COUNT(*) FROM user_group_memberships m WHERE m.group_id = g.id), 0)::int AS member_count
         FROM user_groups g
        ORDER BY g.name`
    );
    reply.send(rows);
  });

  app.post("/admin/groups", { preHandler: requireAdmin }, async (req, reply) => {
    const body = CreateGroup.parse(req.body);
    try {
      const { rows } = await query(
        "INSERT INTO user_groups (name, description) VALUES ($1, $2) RETURNING id, name, description, created_at",
        [body.name, body.description ?? null]
      );
      await audit(req.user?.sub ?? null, "group.created", { group_id: rows[0].id, name: body.name });
      reply.code(201).send(rows[0]);
    } catch (err: unknown) {
      const e = err as { code?: string };
      if (e.code === "23505") {
        reply.code(409).send({ error: "group_name_already_exists" });
        return;
      }
      throw err;
    }
  });

  app.get("/admin/groups/:id/members", { preHandler: requireAdmin }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const { rows } = await query(
      `SELECT u.id, u.email, u.role, m.role_in_group, m.created_at
         FROM user_group_memberships m
         JOIN users u ON u.id = m.user_id
        WHERE m.group_id = $1
        ORDER BY u.email`,
      [id]
    );
    reply.send(rows);
  });

  app.post("/admin/groups/:id/members", { preHandler: requireAdmin }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = AddMember.parse(req.body);
    await query(
      `INSERT INTO user_group_memberships (user_id, group_id, role_in_group)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, group_id) DO UPDATE SET role_in_group = EXCLUDED.role_in_group`,
      [body.user_id, id, body.role_in_group]
    );
    await audit(req.user?.sub ?? null, "group.member_added", { group_id: id, user_id: body.user_id });
    reply.code(204).send();
  });

  app.delete("/admin/groups/:id/members/:userId", { preHandler: requireAdmin }, async (req, reply) => {
    const { id, userId } = req.params as { id: string; userId: string };
    await query("DELETE FROM user_group_memberships WHERE group_id = $1 AND user_id = $2", [id, userId]);
    await audit(req.user?.sub ?? null, "group.member_removed", { group_id: id, user_id: userId });
    reply.code(204).send();
  });

  app.get("/groups", { preHandler: requireAuth }, async (req, reply) => {
    const { rows } = await query(
      `SELECT g.id, g.name FROM user_groups g
        WHERE g.id = ANY($1::uuid[])
        ORDER BY g.name`,
      [req.user?.group_ids ?? []]
    );
    reply.send(rows);
  });
}
