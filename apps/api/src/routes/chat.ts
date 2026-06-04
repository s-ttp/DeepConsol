import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { query } from "../db/pool.js";
import { audit } from "../services/audit.js";
import { sanitize } from "@deepconsol/shared/sanitizer";
import { getSanitizerOverlay } from "../services/sanitizer-config.js";
import { retrieve } from "../services/retrieval.js";
import {
  LlmNotConfiguredError,
  getActiveConfig,
  streamChat,
  type LlmTurn,
} from "../services/llm.js";
import { logger } from "../logger.js";

const ChatMode = z.enum(["auto", "kb_only", "model_only", "web_grounded"]);

const CreateThread = z.object({
  title: z.string().max(200).optional(),
  mode: ChatMode.default("auto"),
});

const PostMessage = z.object({
  text: z.string().min(1).max(50_000),
  attached_snippets: z.array(z.string().max(50_000)).max(20).optional(),
  filters: z
    .object({
      vendor: z.string().optional(),
      domain: z.string().optional(),
      product: z.string().optional(),
      version: z.string().optional(),
    })
    .optional(),
  mode: ChatMode.optional(),
});

const SYSTEM_PROMPT = `You are DeepConsol, an AI copilot for telecom network engineers.

Operating rules:
- You assist with diagnostics, command explanations, log analysis, troubleshooting, RCA, and configuration guidance.
- You MUST NOT execute commands, ever. Only suggest commands the human will run.
- Suggest read-only/diagnostic commands first; mark state-changing or destructive commands clearly with WARNING and explain rollback before suggesting them.
- Vendor-aware (Cisco, Juniper, Nokia, Ericsson, Huawei, Mavenir) but vendor-neutral when scope is unclear — ask which vendor.
- When KB context is provided, prefer it and cite the chunk markers like [KB:doc_id#pointer]. When you fall back to general knowledge, say so.
- Always prefer concise, structured answers (Symptoms → Hypotheses → Evidence to gather → Suggested commands → Interpretation → Next steps → Escalation).
- Sanitize: never echo back IMSI/IMEI/MSISDN/IP literals the user provided — refer to them by the alias they appear under (IMSI_001, IP_001, etc.).`;

function buildHistory(
  history: Array<{ role: string; content_json: unknown }>
): LlmTurn[] {
  // Drop the just-inserted final user row — `streamChat` adds the userText
  // back as the trailing turn — and skip any rows with empty rendered text
  // (defensive against malformed legacy data).
  const out: LlmTurn[] = [];
  for (const m of history) {
    const role = m.role === "assistant" ? "assistant" : m.role === "user" ? "user" : null;
    if (!role) continue;
    const c = m.content_json as { text?: string; segments?: Array<{ text: string }> };
    const text = c.segments?.map((s) => s.text).join("\n\n") ?? c.text ?? "";
    if (!text) continue;
    out.push({ role, text });
  }
  return out;
}

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.post("/chat/threads", { preHandler: requireAuth }, async (req, reply) => {
    const body = CreateThread.parse(req.body);
    const { rows } = await query<{ id: string; created_at: Date }>(
      "INSERT INTO chat_threads (user_id, title, mode) VALUES ($1, $2, $3) RETURNING id, title, mode, created_at",
      [req.user!.sub, body.title ?? null, body.mode]
    );
    reply.code(201).send(rows[0]);
  });

  app.get("/chat/threads", { preHandler: requireAuth }, async (req, reply) => {
    const { rows } = await query(
      `SELECT id, title, mode, created_at, updated_at FROM chat_threads
        WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 100`,
      [req.user!.sub]
    );
    reply.send(rows);
  });

  app.get("/chat/threads/:id", { preHandler: requireAuth }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const { rows: thread } = await query(
      "SELECT id, title, mode, created_at FROM chat_threads WHERE id = $1 AND user_id = $2",
      [id, req.user!.sub]
    );
    if (!thread[0]) {
      reply.code(404).send({ error: "not_found" });
      return;
    }
    const { rows: messages } = await query(
      "SELECT id, role, content_json, created_at FROM chat_messages WHERE thread_id = $1 ORDER BY created_at",
      [id]
    );
    reply.send({ thread: thread[0], messages });
  });

  app.post("/chat/threads/:id/messages", { preHandler: requireAuth }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = PostMessage.parse(req.body);

    const { rows: threadRows } = await query<{ id: string; mode: "auto"|"kb_only"|"model_only"|"web_grounded" }>(
      "SELECT id, mode FROM chat_threads WHERE id = $1 AND user_id = $2",
      [id, req.user!.sub]
    );
    if (!threadRows[0]) {
      reply.code(404).send({ error: "not_found" });
      return;
    }
    const mode = body.mode ?? threadRows[0].mode;

    // Server-side sanitization (defense in depth — client already sanitized).
    // Applies the admin overlay (disabled built-ins + custom rules); falls back
    // to the full baseline if the overlay can't be loaded.
    const sanitizerOverlay = await getSanitizerOverlay();
    const combinedRaw = [body.text, ...(body.attached_snippets ?? [])].join("\n\n---\n\n");
    const sanitizedUserBlock = sanitize(combinedRaw, {}, sanitizerOverlay);
    const userText = sanitizedUserBlock.sanitized;

    await query(
      "INSERT INTO chat_messages (thread_id, role, content_json) VALUES ($1, 'user', $2)",
      [id, { text: userText }]
    );
    await audit(req.user!.sub, "chat.message_sent", {
      thread_id: id,
      mode,
      attached: body.attached_snippets?.length ?? 0,
    });

    const { rows: history } = await query<{ role: string; content_json: unknown }>(
      "SELECT role, content_json FROM chat_messages WHERE thread_id = $1 ORDER BY created_at",
      [id]
    );

    let ragChunks: Awaited<ReturnType<typeof retrieve>>["chunks"] = [];
    let highConfidence = false;
    let useKb = false;
    if (mode === "kb_only" || mode === "auto") {
      const r = await retrieve(req.user!.sub, req.user!.group_ids, userText, body.filters ?? {});
      ragChunks = r.chunks;
      highConfidence = r.high_confidence;
      useKb = mode === "kb_only" ? true : highConfidence;
      await audit(req.user!.sub, "rag.query", {
        thread_id: id,
        chunks_returned: ragChunks.length,
        high_confidence: highConfidence,
      });
    }

    if (mode === "kb_only" && ragChunks.length === 0) {
      const content = {
        provenance: { mode: "kb_only", rag_used: false, web_used: false },
        segments: [{ tag: "GEN", text: "No relevant KB evidence found. Try widening filters, or switch to Auto mode.", citations: [] }],
      };
      await query("INSERT INTO chat_messages (thread_id, role, content_json) VALUES ($1, 'assistant', $2)", [id, content]);
      reply.send(content);
      return;
    }

    const kbBlock = useKb && ragChunks.length
      ? ragChunks
          .slice(0, 6)
          .map(
            (c, i) =>
              `[KB#${i + 1} | doc=${c.document_id}#${c.source_pointer ?? "?"} | file=${c.filename}]\n${c.text}`
          )
          .join("\n\n---\n\n")
      : null;

    // Resolve active LLM config so we know upfront whether to stub-respond
    // (no key configured) or stream from the configured provider.
    let llmCfg;
    try {
      llmCfg = await getActiveConfig();
    } catch (err) {
      logger.error({ err }, "failed to load llm config");
      llmCfg = null;
    }

    if (!llmCfg || !llmCfg.hasKey) {
      const stub = {
        provenance: { mode: useKb ? "kb_only" : "model_only", rag_used: useKb, web_used: false },
        segments: [
          {
            tag: useKb ? "KB" : "GEN",
            text:
              "LLM is not configured yet. " +
              (kbBlock
                ? "Showing the top KB excerpts that would have been sent:\n\n" + kbBlock.slice(0, 2000)
                : "An admin can set the chat model + API key under Admin → LLM Config."),
            citations: ragChunks.slice(0, 6).map((c) => `${c.document_id}#${c.source_pointer ?? ""}`),
          },
        ],
      };
      await query("INSERT INTO chat_messages (thread_id, role, content_json) VALUES ($1, 'assistant', $2)", [id, stub]);
      reply.send(stub);
      return;
    }

    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.flushHeaders?.();

    // Drop the trailing user row (just inserted) — streamChat tacks userText on
    // as the final turn itself.
    const historyForLlm = buildHistory(history.slice(0, -1));
    const finalUser = kbBlock
      ? `Relevant KB context (use and cite if helpful):\n\n${kbBlock}\n\nUser question:\n${userText}`
      : userText;

    let aggregated = "";
    let webChunks: Array<{ uri: string; title?: string }> = [];

    try {
      for await (const chunk of streamChat({
        systemPrompt: SYSTEM_PROMPT,
        history: historyForLlm,
        userText: finalUser,
        tools: { web_grounding: mode === "web_grounded" },
        generation: { temperature: 0.3, maxOutputTokens: 4096 },
      })) {
        if (chunk.text) {
          aggregated += chunk.text;
          reply.raw.write(`data: ${JSON.stringify({ type: "delta", text: chunk.text })}\n\n`);
        }
        if (chunk.groundingChunks?.length) {
          webChunks = chunk.groundingChunks;
        }
      }
    } catch (err) {
      if (err instanceof LlmNotConfiguredError) {
        reply.raw.write(`data: ${JSON.stringify({ type: "error", message: err.message })}\n\n`);
      } else {
        logger.error({ err }, "llm stream failed");
        reply.raw.write(`data: ${JSON.stringify({ type: "error", message: "ai_unavailable" })}\n\n`);
      }
    }

    const segments = [];
    if (useKb && ragChunks.length) {
      segments.push({
        tag: "KB" as const,
        text: aggregated,
        citations: ragChunks.slice(0, 6).map((c) => `${c.document_id}#${c.source_pointer ?? ""}`),
      });
    } else if (webChunks.length) {
      segments.push({
        tag: "WEB" as const,
        text: aggregated,
        citations: webChunks.map((c) => c.uri),
      });
    } else {
      segments.push({ tag: "GEN" as const, text: aggregated, citations: [] });
    }
    const content = {
      provenance: {
        mode: useKb ? (webChunks.length ? "mixed" : "kb_only") : webChunks.length ? "web_grounded" : "model_only",
        rag_used: useKb,
        web_used: webChunks.length > 0,
      },
      segments,
    };
    await query("INSERT INTO chat_messages (thread_id, role, content_json) VALUES ($1, 'assistant', $2)", [id, content]);
    await query("UPDATE chat_threads SET updated_at = NOW() WHERE id = $1", [id]);
    await audit(req.user!.sub, "chat.message_received", {
      thread_id: id,
      provenance: content.provenance,
    });
    reply.raw.write(`data: ${JSON.stringify({ type: "done", message: content })}\n\n`);
    reply.raw.end();
  });
}
