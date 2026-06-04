import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth/middleware.js";
import { query } from "../db/pool.js";

export async function playbookRoutes(app: FastifyInstance): Promise<void> {
  app.get("/playbooks", { preHandler: requireAuth }, async (_req, reply) => {
    const { rows } = await query(
      `SELECT id, title, category, symptoms, questions, commands, expected_outputs,
              interpretation, next_steps, escalation_template
         FROM playbooks ORDER BY title`
    );
    reply.send(rows);
  });

  app.get("/playbooks/:id", { preHandler: requireAuth }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const { rows } = await query("SELECT * FROM playbooks WHERE id = $1", [id]);
    if (!rows[0]) {
      reply.code(404).send({ error: "not_found" });
      return;
    }
    reply.send(rows[0]);
  });
}
