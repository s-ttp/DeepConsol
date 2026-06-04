import { config, geminiConfigured } from "../config.js";
import { logger } from "../logger.js";
import { getActiveEmbeddingConfig, requestEmbedding } from "./embedding.js";

/**
 * Minimal Gemini REST client. Uses fetch — no SDK, so we don't pin to an
 * SDK release that may diverge from the API.
 *
 * Endpoints:
 *  - chat (streaming):  POST /models/{model}:streamGenerateContent
 *  - chat (one-shot):   POST /models/{model}:generateContent
 *  - embeddings:        POST /models/{model}:embedContent
 *
 * When the API key is the placeholder (REPLACE_ME_*), every call short-circuits
 * with a NotConfigured error so the app degrades gracefully instead of crashing.
 */

export class GeminiNotConfiguredError extends Error {
  constructor() {
    super("Gemini API key is not configured. Set GEMINI_API_KEY in .env to enable AI features.");
    this.name = "GeminiNotConfiguredError";
  }
}

export class GeminiApiError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`Gemini API error ${status}: ${body.slice(0, 500)}`);
    this.name = "GeminiApiError";
  }
}

export interface GeminiContent {
  role: "user" | "model";
  parts: Array<{ text: string }>;
}

export interface GeminiTool {
  google_search?: {};
}

export interface GenerateContentRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: Array<{ text: string }> };
  tools?: GeminiTool[];
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
    topP?: number;
    topK?: number;
  };
  safetySettings?: Array<{ category: string; threshold: string }>;
}

export interface GenerateContentChunk {
  text?: string;
  groundingMetadata?: {
    groundingChunks?: Array<{ web?: { uri: string; title?: string } }>;
    groundingSupports?: Array<{ groundingChunkIndices: number[]; segment: { text: string } }>;
  };
  finishReason?: string;
}

function authParams(): string {
  return `key=${encodeURIComponent(config.geminiApiKey)}`;
}

export async function* streamGenerate(
  req: GenerateContentRequest
): AsyncIterable<GenerateContentChunk> {
  if (!geminiConfigured()) throw new GeminiNotConfiguredError();
  const url = `${config.geminiApiBase}/models/${config.geminiChatModel}:streamGenerateContent?alt=sse&${authParams()}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    throw new GeminiApiError(res.status, body);
  }
  const reader = res.body.getReader();
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
      if (!payload || payload === "[DONE]") continue;
      try {
        const parsed = JSON.parse(payload);
        const candidate = parsed?.candidates?.[0];
        const text = candidate?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("");
        yield {
          text: text ?? undefined,
          groundingMetadata: candidate?.groundingMetadata,
          finishReason: candidate?.finishReason,
        };
      } catch (err) {
        logger.warn({ err, line }, "gemini sse parse error");
      }
    }
  }
}

export async function generate(req: GenerateContentRequest): Promise<{
  text: string;
  groundingChunks: Array<{ uri: string; title?: string }>;
}> {
  if (!geminiConfigured()) throw new GeminiNotConfiguredError();
  const url = `${config.geminiApiBase}/models/${config.geminiChatModel}:generateContent?${authParams()}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new GeminiApiError(res.status, body);
  }
  const data = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      groundingMetadata?: { groundingChunks?: Array<{ web?: { uri: string; title?: string } }> };
    }>;
  };
  const candidate = data.candidates?.[0];
  const text =
    candidate?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  const groundingChunks =
    candidate?.groundingMetadata?.groundingChunks
      ?.map((c) => c.web)
      .filter((c): c is { uri: string; title?: string } => Boolean(c)) ?? [];
  return { text, groundingChunks };
}

/**
 * Embed a single string. The embedding model, API key, and base URL now come
 * from the admin-managed `embedding_config` row (see services/embedding.ts),
 * falling back to the GEMINI_API_KEY env var when no key is saved. Throws
 * GeminiNotConfiguredError when no usable key is resolved so callers (worker,
 * retrieval) keep their existing text-only / no-vector fallback behaviour.
 */
export async function embed(text: string): Promise<number[]> {
  const cfg = await getActiveEmbeddingConfig();
  if (!cfg.hasKey) throw new GeminiNotConfiguredError();
  return requestEmbedding(cfg.model, cfg.apiBase, cfg.apiKey, text);
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  const results: number[][] = [];
  for (const t of texts) {
    results.push(await embed(t));
  }
  return results;
}
