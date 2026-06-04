import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { sha256Hex } from "../services/crypto.js";
import { audit } from "../services/audit.js";
import { classifyBlock, requiresTypedConfirmation } from "@deepconsol/shared/risk";

const Classify = z.object({
  block: z.string().min(1).max(50_000),
});

const Confirm = z.object({
  message_id: z.string().min(1).max(200),
  block: z.string().min(1).max(50_000),
  confirmation: z.enum(["click", "typed"]),
  typed_value: z.string().optional(),
});

export async function safeCopyRoutes(app: FastifyInstance): Promise<void> {
  app.post("/safe-copy/classify", { preHandler: requireAuth }, async (req, reply) => {
    const body = Classify.parse(req.body);
    const assessment = classifyBlock(body.block);
    reply.send({
      ...assessment,
      requires_typed_confirmation: requiresTypedConfirmation(assessment.level),
    });
  });

  app.post("/safe-copy/confirm", { preHandler: requireAuth }, async (req, reply) => {
    const body = Confirm.parse(req.body);
    const assessment = classifyBlock(body.block);
    if (requiresTypedConfirmation(assessment.level)) {
      if (body.confirmation !== "typed" || body.typed_value !== "I UNDERSTAND") {
        reply.code(400).send({ error: "typed_confirmation_required", expected: "I UNDERSTAND" });
        return;
      }
    }
    await audit(req.user!.sub, "safe_copy.confirmed", {
      message_id: body.message_id,
      risk_level: assessment.level,
      content_hash: sha256Hex(body.block),
      confirmation_method: body.confirmation,
    });
    reply.send({ ok: true });
  });
}
