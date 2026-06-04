import { config } from "../config.js";
import { logger } from "../logger.js";
import { query } from "../db/pool.js";
import { decrypt, encrypt } from "./crypto.js";

/**
 * Provider-agnostic LLM service.
 *
 * The chat route talks to `streamChat` only — provider differences
 * (Gemini vs OpenAI vs Anthropic SSE shapes, system-prompt placement,
 * web-grounding tools) are absorbed inside the per-provider implementations.
 *
 * Active config is cached in-process and invalidated by `invalidateActiveConfig()`,
 * which the admin route calls after a successful PUT. This avoids a DB round-trip
 * per chat request without forcing a service restart on config changes.
 *
 * Embeddings are deliberately NOT routed through this layer (see migration
 * 004): the rag_chunks vector column is fixed at 3072 dims, which only matches
 * Gemini today. Embeddings keep using GEMINI_API_KEY directly.
 */

export type LlmProviderName = "gemini" | "openai" | "anthropic";

export const PROVIDER_LABELS: Record<LlmProviderName, string> = {
  gemini: "Google Gemini",
  openai: "OpenAI",
  anthropic: "Anthropic Claude",
};

export const PROVIDER_DEFAULTS: Record<LlmProviderName, { model: string; api_base: string }> = {
  gemini: { model: "gemini-3-pro-preview", api_base: "https://generativelanguage.googleapis.com/v1beta" },
  openai: { model: "gpt-5.4", api_base: "https://api.openai.com/v1" },
  anthropic: { model: "claude-sonnet-4-6", api_base: "https://api.anthropic.com/v1" },
};

export class LlmNotConfiguredError extends Error {
  constructor(reason: string) {
    super(`LLM not configured: ${reason}`);
    this.name = "LlmNotConfiguredError";
  }
}

export class LlmApiError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`LLM API error ${status}: ${body.slice(0, 500)}`);
    this.name = "LlmApiError";
  }
}

export interface LlmTurn {
  role: "user" | "assistant";
  text: string;
}

export interface StreamChatRequest {
  systemPrompt: string;
  history: LlmTurn[];
  userText: string;
  // Provider-specific tool hints. Currently only Gemini honours web grounding;
  // others silently ignore.
  tools?: { web_grounding?: boolean };
  generation?: { temperature?: number; maxOutputTokens?: number };
}

export interface StreamChatChunk {
  text?: string;
  // Web grounding citations (Gemini-only today).
  groundingChunks?: Array<{ uri: string; title?: string }>;
  finishReason?: string;
}

export interface ResolvedConfig {
  provider: LlmProviderName;
  chatModel: string;
  apiBase: string;
  apiKey: string; // resolved (env-fallback or decrypted DB value)
  hasKey: boolean; // true if the resolved apiKey is usable
}

interface RawConfigRow {
  provider: LlmProviderName;
  chat_model: string;
  api_base: string | null;
  encrypted_api_key: string;
  iv: string;
  auth_tag: string;
  has_api_key: boolean;
}

let cached: ResolvedConfig | null = null;

export function invalidateActiveConfig(): void {
  cached = null;
}

export async function getActiveConfig(): Promise<ResolvedConfig> {
  if (cached) return cached;
  const { rows } = await query<RawConfigRow>(
    "SELECT provider, chat_model, api_base, encrypted_api_key, iv, auth_tag, has_api_key FROM llm_config WHERE id = 1"
  );
  if (!rows[0]) {
    // The migration seeds row 1; if we land here, treat it as a hard misconfig.
    throw new LlmNotConfiguredError("llm_config row missing — re-run migrations");
  }
  cached = resolveRow(rows[0]);
  return cached;
}

function resolveRow(row: RawConfigRow): ResolvedConfig {
  const provider = row.provider;
  const apiBase = row.api_base && row.api_base.length > 0 ? row.api_base : PROVIDER_DEFAULTS[provider].api_base;
  let apiKey = "";
  if (row.has_api_key && row.encrypted_api_key) {
    try {
      apiKey = decrypt({
        ciphertext: row.encrypted_api_key,
        iv: row.iv,
        auth_tag: row.auth_tag,
      });
    } catch (err) {
      logger.error({ err }, "failed to decrypt llm_config api_key — falling back to env");
      apiKey = "";
    }
  }
  // Env-var fallback — only applies to gemini, since the env var is named
  // GEMINI_API_KEY. Other providers must provide a key through the admin UI.
  if (!apiKey && provider === "gemini") {
    apiKey = config.geminiApiKey ?? "";
  }
  return {
    provider,
    chatModel: row.chat_model,
    apiBase,
    apiKey,
    hasKey: apiKey.length > 0 && !apiKey.startsWith("REPLACE_ME"),
  };
}

/** Encrypt a plaintext API key for storage. */
export function packApiKey(plaintext: string): { ciphertext: string; iv: string; auth_tag: string } {
  return encrypt(plaintext);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public chat entry-point
// ─────────────────────────────────────────────────────────────────────────────

export async function* streamChat(req: StreamChatRequest): AsyncIterable<StreamChatChunk> {
  const cfg = await getActiveConfig();
  if (!cfg.hasKey) throw new LlmNotConfiguredError(`no API key for ${cfg.provider}`);

  if (cfg.provider === "gemini") {
    yield* streamGemini(cfg, req);
  } else if (cfg.provider === "openai") {
    yield* streamOpenAI(cfg, req);
  } else if (cfg.provider === "anthropic") {
    yield* streamAnthropic(cfg, req);
  } else {
    throw new LlmNotConfiguredError(`unknown provider ${cfg.provider as string}`);
  }
}

/**
 * One-shot non-streaming "ping" used by the admin Test button. Sends a tiny
 * prompt and returns the first text it receives (or the error). Designed to
 * surface auth/network/model-not-found errors quickly.
 *
 * `override` lets an admin test a candidate config without saving it first.
 */
export async function testChat(override?: Partial<ResolvedConfig> & { apiKeyPlain?: string }): Promise<{
  ok: boolean;
  provider: LlmProviderName;
  model: string;
  reply?: string;
  error?: string;
}> {
  const base = await getActiveConfig().catch(() => null);
  const cfg: ResolvedConfig = {
    provider: override?.provider ?? base?.provider ?? "gemini",
    chatModel: override?.chatModel ?? base?.chatModel ?? PROVIDER_DEFAULTS.gemini.model,
    apiBase: override?.apiBase ?? base?.apiBase ?? PROVIDER_DEFAULTS.gemini.api_base,
    apiKey: override?.apiKeyPlain ?? override?.apiKey ?? base?.apiKey ?? "",
    hasKey: false,
  };
  cfg.hasKey = cfg.apiKey.length > 0;
  if (!cfg.hasKey) {
    return { ok: false, provider: cfg.provider, model: cfg.chatModel, error: "missing_api_key" };
  }
  const req: StreamChatRequest = {
    systemPrompt: "You are a connection test. Reply with exactly: OK",
    history: [],
    userText: "ping",
    generation: { temperature: 0, maxOutputTokens: 16 },
  };
  try {
    const iterable =
      cfg.provider === "gemini"
        ? streamGemini(cfg, req)
        : cfg.provider === "openai"
        ? streamOpenAI(cfg, req)
        : streamAnthropic(cfg, req);
    let reply = "";
    for await (const chunk of iterable) {
      if (chunk.text) reply += chunk.text;
      if (reply.length > 64) break;
    }
    return { ok: true, provider: cfg.provider, model: cfg.chatModel, reply: reply.trim() || "(empty)" };
  } catch (err) {
    const msg = err instanceof LlmApiError ? `${err.status}: ${err.body.slice(0, 240)}` : (err as Error).message;
    return { ok: false, provider: cfg.provider, model: cfg.chatModel, error: msg };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider: Gemini (REST, SSE)
// ─────────────────────────────────────────────────────────────────────────────

async function* streamGemini(cfg: ResolvedConfig, req: StreamChatRequest): AsyncIterable<StreamChatChunk> {
  const url = `${cfg.apiBase}/models/${encodeURIComponent(cfg.chatModel)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(cfg.apiKey)}`;
  const contents = [
    ...req.history.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.text }],
    })),
    { role: "user", parts: [{ text: req.userText }] },
  ];
  const body = {
    contents,
    systemInstruction: { parts: [{ text: req.systemPrompt }] },
    tools: req.tools?.web_grounding && config.geminiWebGroundingEnabled ? [{ google_search: {} }] : undefined,
    generationConfig: {
      temperature: req.generation?.temperature ?? 0.3,
      maxOutputTokens: req.generation?.maxOutputTokens ?? 4096,
    },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    throw new LlmApiError(res.status, await res.text().catch(() => ""));
  }
  for await (const evt of readSse(res.body)) {
    if (evt === "[DONE]") continue;
    try {
      const parsed = JSON.parse(evt);
      const candidate = parsed?.candidates?.[0];
      const text = candidate?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("");
      const groundingChunks =
        candidate?.groundingMetadata?.groundingChunks
          ?.map((c: { web?: { uri: string; title?: string } }) => c.web)
          .filter((c: unknown): c is { uri: string; title?: string } => Boolean(c)) ?? undefined;
      yield { text: text || undefined, groundingChunks, finishReason: candidate?.finishReason };
    } catch (err) {
      logger.warn({ err, evt }, "gemini sse parse error");
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider: OpenAI Chat Completions (SSE)
// ─────────────────────────────────────────────────────────────────────────────

async function* streamOpenAI(cfg: ResolvedConfig, req: StreamChatRequest): AsyncIterable<StreamChatChunk> {
  const url = `${cfg.apiBase}/chat/completions`;
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: req.systemPrompt },
    ...req.history.map((m) => ({ role: m.role, content: m.text })),
    { role: "user", content: req.userText },
  ];
  const body = {
    model: cfg.chatModel,
    messages,
    stream: true,
    temperature: req.generation?.temperature ?? 0.3,
    max_tokens: req.generation?.maxOutputTokens ?? 4096,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    throw new LlmApiError(res.status, await res.text().catch(() => ""));
  }
  for await (const evt of readSse(res.body)) {
    if (evt === "[DONE]") return;
    try {
      const parsed = JSON.parse(evt);
      const choice = parsed?.choices?.[0];
      const text = choice?.delta?.content;
      yield { text: text || undefined, finishReason: choice?.finish_reason };
    } catch (err) {
      logger.warn({ err, evt }, "openai sse parse error");
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider: Anthropic Messages (SSE)
// ─────────────────────────────────────────────────────────────────────────────

async function* streamAnthropic(cfg: ResolvedConfig, req: StreamChatRequest): AsyncIterable<StreamChatChunk> {
  const url = `${cfg.apiBase}/messages`;
  // Anthropic separates the system prompt from the message list and requires
  // the conversation to start with a `user` turn.
  const messages = [
    ...req.history.map((m) => ({
      role: m.role,
      content: [{ type: "text", text: m.text }],
    })),
    { role: "user", content: [{ type: "text", text: req.userText }] },
  ];
  const body = {
    model: cfg.chatModel,
    system: req.systemPrompt,
    messages,
    stream: true,
    temperature: req.generation?.temperature ?? 0.3,
    max_tokens: req.generation?.maxOutputTokens ?? 4096,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    throw new LlmApiError(res.status, await res.text().catch(() => ""));
  }
  for await (const evt of readSse(res.body)) {
    try {
      const parsed = JSON.parse(evt);
      // We care about `content_block_delta` (text deltas) and `message_delta`
      // (final stop_reason). Other event types (message_start, ping, etc.) are
      // ignored.
      if (parsed?.type === "content_block_delta" && parsed?.delta?.type === "text_delta") {
        yield { text: parsed.delta.text };
      } else if (parsed?.type === "message_delta" && parsed?.delta?.stop_reason) {
        yield { text: undefined, finishReason: parsed.delta.stop_reason };
      }
    } catch (err) {
      logger.warn({ err, evt }, "anthropic sse parse error");
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared SSE reader — yields each event payload (the `data:` body) as a string.
// Stops naturally when the stream closes.
// ─────────────────────────────────────────────────────────────────────────────

async function* readSse(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload) yield payload;
    }
  }
}
