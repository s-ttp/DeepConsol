import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireAdmin } from "../auth/middleware.js";
import { audit } from "../services/audit.js";
import { sanitize } from "@deepconsol/shared/sanitizer";
import {
  createCustomRule,
  deleteCustomRule,
  getSanitizerOverlay,
  isKnownBuiltin,
  listBuiltinRules,
  listCustomRules,
  setBuiltinEnabled,
  updateCustomRule,
} from "../services/sanitizer-config.js";

const CustomRuleBody = z.object({
  label: z.string().min(1).max(80),
  match_type: z.enum(["literal", "wildcard"]),
  value: z.string().min(1).max(200),
  action: z.enum(["redact", "pseudonymize"]),
  alias_prefix: z.string().max(40).optional().nullable(),
  case_insensitive: z.boolean().default(true),
  enabled: z.boolean().default(true),
});

const ToggleBody = z.object({ enabled: z.boolean() });

const TestBody = z.object({ sample: z.string().min(1).max(20_000) });

export async function sanitizerConfigRoutes(app: FastifyInstance): Promise<void> {
  // ── Client-facing: the effective overlay every authenticated user needs to
  //    sanitize text locally before it enters the chat composer. Returns the
  //    SanitizerOverlay shape directly. ──
  app.get("/sanitizer/rules", { preHandler: requireAuth }, async (_req, reply) => {
    const overlay = await getSanitizerOverlay();
    reply.send(overlay);
  });

  // ── Admin management ──
  app.get("/admin/sanitizer", { preHandler: requireAdmin }, async (_req, reply) => {
    const [builtins, custom] = await Promise.all([listBuiltinRules(), listCustomRules()]);
    reply.send({ builtins, custom });
  });

  app.put("/admin/sanitizer/builtins/:name", { preHandler: requireAdmin }, async (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (!isKnownBuiltin(name)) {
      reply.code(404).send({ error: "unknown_rule" });
      return;
    }
    const body = ToggleBody.parse(req.body);
    await setBuiltinEnabled(name, body.enabled, req.user!.sub);
    await audit(req.user!.sub, "sanitizer_config.builtin_toggled", { rule_name: name, enabled: body.enabled });
    reply.send({ name, enabled: body.enabled });
  });

  app.post("/admin/sanitizer/custom", { preHandler: requireAdmin }, async (req, reply) => {
    const body = CustomRuleBody.parse(req.body);
    const rule = await createCustomRule(body, req.user!.sub);
    await audit(req.user!.sub, "sanitizer_config.custom_created", {
      id: rule.id,
      label: rule.label,
      action: rule.action,
      match_type: rule.match_type,
    });
    reply.code(201).send(rule);
  });

  app.patch("/admin/sanitizer/custom/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = CustomRuleBody.parse(req.body);
    const rule = await updateCustomRule(id, body, req.user!.sub);
    if (!rule) {
      reply.code(404).send({ error: "not_found" });
      return;
    }
    await audit(req.user!.sub, "sanitizer_config.custom_updated", { id: rule.id, label: rule.label, enabled: rule.enabled });
    reply.send(rule);
  });

  app.delete("/admin/sanitizer/custom/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const ok = await deleteCustomRule(id);
    if (!ok) {
      reply.code(404).send({ error: "not_found" });
      return;
    }
    await audit(req.user!.sub, "sanitizer_config.custom_deleted", { id });
    reply.code(204).send();
  });

  // Preview: run the CURRENT effective overlay against an admin-supplied sample
  // so changes can be verified before relying on them.
  app.post("/admin/sanitizer/test", { preHandler: requireAdmin }, async (req, reply) => {
    const body = TestBody.parse(req.body);
    const overlay = await getSanitizerOverlay();
    const result = sanitize(body.sample, {}, overlay);
    reply.send(result);
  });
}
