"use client";

import { useEffect, useImperativeHandle, useMemo, useRef, useState, forwardRef } from "react";
import type {
  AssistantMessageContent,
  ChatMode,
  MessageSegment,
  ProvenanceTag,
  RiskAssessment,
} from "@deepconsol/shared/types";
import { classifyBlock } from "@deepconsol/shared/risk";
import { sanitize } from "@/lib/sanitizer-rules";
import { api } from "@/lib/api";
import ProvenanceBadge from "./ProvenanceBadge";
import SafeCopyModal from "./SafeCopyModal";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string | AssistantMessageContent;
  ts: number;
}

export interface ChatHandle {
  appendDraft: (text: string) => void;
}

interface Props {
  threadId: string | null;
  onCreateThread: (id: string) => void;
}

const MODES: ChatMode[] = ["auto", "kb_only", "model_only", "web_grounded"];
const MODE_LABELS: Record<ChatMode, string> = {
  auto: "Auto",
  kb_only: "KB",
  model_only: "Model",
  web_grounded: "Web",
};
const MODE_TITLES: Record<ChatMode, string> = {
  auto: "Auto — try KB first, fall back to model knowledge",
  kb_only: "KB only — answer strictly from your uploaded documents",
  model_only: "Model only — Gemini general knowledge, no RAG",
  web_grounded: "Web grounded — Gemini + Google Search",
};

const Chat = forwardRef<ChatHandle, Props>(function Chat({ threadId, onCreateThread }, ref) {
  const [thread, setThread] = useState<string | null>(threadId);
  const [mode, setMode] = useState<ChatMode>("auto");
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [safeCopy, setSafeCopy] = useState<{ messageId: string; block: string; assessment: RiskAssessment } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [freshAssistantIds, setFreshAssistantIds] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  useImperativeHandle(ref, () => ({
    appendDraft: (text: string) => {
      const sanitized = sanitize(text).sanitized;
      setDraft((prev) => (prev ? `${prev}\n\n${sanitized}` : sanitized));
      requestAnimationFrame(() => {
        composerRef.current?.focus();
        composerRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    },
  }));

  useEffect(() => {
    setThread(threadId);
  }, [threadId]);

  useEffect(() => {
    if (!thread) {
      setMessages([]);
      return;
    }
    void api
      .get<{ thread: { mode: ChatMode }; messages: Array<{ id: string; role: string; content_json: unknown }> }>(`/chat/threads/${thread}`)
      .then((data) => {
        setMode(data.thread.mode);
        setMessages(
          data.messages.map((m) => ({
            id: m.id,
            role: m.role as "user" | "assistant",
            content:
              m.role === "assistant"
                ? (m.content_json as AssistantMessageContent)
                : (m.content_json as { text: string }).text,
            ts: Date.now(),
          }))
        );
      })
      .catch(() => setMessages([]));
  }, [thread]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, streamingText]);

  useEffect(() => {
    if (freshAssistantIds.size === 0) return;
    const t = setTimeout(() => setFreshAssistantIds(new Set()), 5000);
    return () => clearTimeout(t);
  }, [freshAssistantIds]);

  async function ensureThread(): Promise<string> {
    if (thread) return thread;
    const created = await api.post<{ id: string }>("/chat/threads", { mode });
    setThread(created.id);
    onCreateThread(created.id);
    return created.id;
  }

  function markFresh(id: string): void {
    setFreshAssistantIds((prev) => new Set(prev).add(id));
  }

  async function send(): Promise<void> {
    if (!draft.trim() || streaming) return;
    setError(null);
    const id = await ensureThread();
    const userText = draft;
    setDraft("");
    setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: "user", content: userText, ts: Date.now() }]);
    setStreaming(true);
    setStreamingText("");

    try {
      const res = await fetch(`/api/chat/threads/${id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        credentials: "include",
        body: JSON.stringify({ text: userText, mode }),
      });
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("text/event-stream")) {
        const data = (await res.json()) as AssistantMessageContent;
        const newId = `a-${Date.now()}`;
        setMessages((prev) => [...prev, { id: newId, role: "assistant", content: data, ts: Date.now() }]);
        markFresh(newId);
        setStreaming(false);
        return;
      }
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let aggregated = "";
      let final: AssistantMessageContent | null = null;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const events = buf.split(/\n\n/);
        buf = events.pop() ?? "";
        for (const ev of events) {
          if (!ev.startsWith("data:")) continue;
          const payload = ev.slice(5).trim();
          if (!payload) continue;
          try {
            const parsed = JSON.parse(payload);
            if (parsed.type === "delta") {
              aggregated += parsed.text;
              setStreamingText(aggregated);
            } else if (parsed.type === "done") {
              final = parsed.message as AssistantMessageContent;
            } else if (parsed.type === "error") {
              setError(parsed.message);
            }
          } catch {
            /* ignore */
          }
        }
      }
      const newId = `a-${Date.now()}`;
      if (final) {
        setMessages((prev) => [...prev, { id: newId, role: "assistant", content: final!, ts: Date.now() }]);
        markFresh(newId);
      } else if (aggregated) {
        setMessages((prev) => [
          ...prev,
          {
            id: newId,
            role: "assistant",
            content: {
              provenance: { mode: "model_only", rag_used: false, web_used: false },
              segments: [{ tag: "GEN", text: aggregated, citations: [] }],
            },
            ts: Date.now(),
          },
        ]);
        markFresh(newId);
      }
    } catch {
      setError("Network error");
    } finally {
      setStreaming(false);
      setStreamingText("");
    }
  }

  function openSafeCopy(messageId: string, block: string): void {
    setSafeCopy({ messageId, block, assessment: classifyBlock(block) });
  }

  return (
    <div className="flex h-full flex-col bg-white/[0.02] backdrop-blur-md">
      {/* Header — brand mark + segmented mode control */}
      <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2.5">
        <div className="flex items-center gap-2">
          <DcAvatar size={6} />
          <h3 className="text-sm font-semibold text-ink-100">Assistant</h3>
        </div>
        <div className="inline-flex rounded-full border border-white/[0.08] bg-white/[0.03] p-0.5">
          {MODES.map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              title={MODE_TITLES[m]}
              className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-all ${
                mode === m
                  ? "bg-gradient-to-r from-emerald-400 to-cyan-400 text-ink-950 shadow-[0_0_8px_rgba(0,255,163,0.45)]"
                  : "text-ink-400 hover:text-ink-100"
              }`}
            >
              {MODE_LABELS[m]}
            </button>
          ))}
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {messages.length === 0 && !streaming && <EmptyState />}
        {messages.map((m) =>
          m.role === "user" ? (
            <UserBubble key={m.id} text={typeof m.content === "string" ? m.content : ""} />
          ) : (
            <AssistantBubble
              key={m.id}
              messageId={m.id}
              content={m.content as AssistantMessageContent}
              fresh={freshAssistantIds.has(m.id)}
              onSafeCopy={openSafeCopy}
            />
          )
        )}
        {streaming && <StreamingBubble text={streamingText} />}
        {error && (
          <div className="my-2 inline-flex items-center gap-1.5 rounded-full border border-rose-500/30 bg-rose-500/10 px-3 py-1 text-[11px] text-rose-400">
            <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />
            {error}
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="border-t border-white/[0.06] p-3">
        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-2 transition-all focus-within:border-brand-green/50 focus-within:bg-white/[0.05] focus-within:shadow-[0_0_15px_rgba(0,255,163,0.12)]">
          <div className="flex items-end gap-2">
            <textarea
              ref={composerRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder="Ask a question, paste an alarm/log, or insert from the drawer.  ⌘/Ctrl + Enter to send."
              rows={2}
              className="flex-1 resize-none bg-transparent px-1 py-1 text-sm text-ink-100 outline-none placeholder:text-ink-500"
            />
            <SendButton disabled={streaming || !draft.trim()} onClick={() => void send()} />
          </div>
        </div>
      </div>

      {safeCopy && (
        <SafeCopyModal
          messageId={safeCopy.messageId}
          block={safeCopy.block}
          assessment={safeCopy.assessment}
          onClose={() => setSafeCopy(null)}
        />
      )}
    </div>
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Subcomponents
// ─────────────────────────────────────────────────────────────────────────────

function DcAvatar({ size, glow = false }: { size: number; glow?: boolean }) {
  // size is in tailwind 0.25rem units (h-{n} w-{n})
  const px = size * 4;
  const fontSize = Math.max(8, Math.floor(px * 0.38));
  return (
    <div
      className={`grid shrink-0 place-items-center rounded-full bg-gradient-to-br from-brand-green to-cyan-400 font-black text-ink-950 ${
        glow ? "shadow-[0_0_14px_rgba(0,255,163,0.6)]" : "shadow-[0_0_8px_rgba(0,255,163,0.3)]"
      }`}
      style={{ height: `${px}px`, width: `${px}px`, fontSize: `${fontSize}px` }}
    >
      DC
    </div>
  );
}

function SendButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title="Send  (⌘/Ctrl + Enter)"
      className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gradient-to-r from-emerald-400 to-cyan-400 text-ink-950 transition-all hover:scale-105 hover:shadow-[0_0_18px_rgba(52,211,153,0.55)] disabled:scale-100 disabled:bg-none disabled:bg-ink-800 disabled:text-ink-600 disabled:shadow-none"
    >
      {/* paper-plane */}
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 2 L11 13" />
        <path d="M22 2 L15 22 L11 13 L2 9 Z" />
      </svg>
    </button>
  );
}

function EmptyState() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center py-8">
      <DcAvatar size={12} glow />
      <h3 className="mt-4 text-base font-semibold text-ink-100">How can I help?</h3>
      <p className="mt-1 text-center text-xs text-ink-500">
        Ask anything telecom-related, paste a log/alarm, or pick a starter.
      </p>
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  // Pasted CLI/log output should keep its alignment — use monospace + horizontal
  // scroll for very long lines, fall back to wrap for prose.
  const looksLikeCli = /\n.*\s{2,}|^\S+@\S+[:#$>]/.test(text) || text.includes("\t");
  return (
    <div className="my-3 ml-auto max-w-[95%] rounded-2xl rounded-tr-sm border border-white/[0.08] bg-white/[0.03] p-3 text-sm text-ink-100 backdrop-blur-md">
      <div className="mb-1 text-[10px] uppercase tracking-wider text-ink-400">You</div>
      <pre
        className={
          looksLikeCli
            ? "overflow-x-auto whitespace-pre font-mono text-xs leading-snug"
            : "whitespace-pre-wrap break-words font-sans"
        }
      >
        {text}
      </pre>
    </div>
  );
}

const PROVENANCE_LEFT_EDGE: Record<ProvenanceTag, string> = {
  KB: "border-l-brand-green/70",
  WEB: "border-l-cyan-400/70",
  GEN: "border-l-brand-purple/70",
};

function AssistantBubble({
  messageId,
  content,
  fresh,
  onSafeCopy,
}: {
  messageId: string;
  content: AssistantMessageContent;
  fresh: boolean;
  onSafeCopy: (messageId: string, block: string) => void;
}) {
  const dominantTag: ProvenanceTag = content.provenance.rag_used
    ? "KB"
    : content.provenance.web_used
    ? "WEB"
    : "GEN";
  return (
    <div
      className={`my-3 max-w-[95%] rounded-2xl rounded-tl-sm border border-l-2 border-white/[0.10] ${PROVENANCE_LEFT_EDGE[dominantTag]} bg-white/[0.05] p-3 shadow-[0_4px_24px_rgba(0,0,0,0.3)] backdrop-blur-md`}
    >
      <div className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-wider">
        <DcAvatar size={5} />
        <span className="text-ink-300">DeepConsol</span>
        <span className={fresh ? "animate-badge-glow" : ""}>
          <ProvenanceBadge tag={dominantTag} />
        </span>
        <span className="text-ink-600">· {content.provenance.mode.replace(/_/g, " ")}</span>
      </div>
      {content.segments.map((seg, i) => (
        <Segment key={i} messageId={messageId} segment={seg} onSafeCopy={onSafeCopy} />
      ))}
    </div>
  );
}

function StreamingBubble({ text }: { text: string }) {
  return (
    <div className="my-3 max-w-[95%]">
      <div
        className="animate-stream-edge rounded-2xl rounded-tl-sm bg-gradient-to-r from-brand-green/50 via-cyan-400/50 to-brand-green/50 p-[1.5px]"
        style={{ backgroundSize: "200% 100%" }}
      >
        <div className="rounded-2xl rounded-tl-sm bg-ink-950/90 p-3 backdrop-blur-md">
          <div className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-wider">
            <DcAvatar size={5} glow />
            <span className="text-ink-300">DeepConsol</span>
            <span className="ml-1 inline-flex items-center gap-1">
              <span className="h-1.5 w-1.5 animate-typing-dot rounded-full bg-brand-green" />
              <span
                className="h-1.5 w-1.5 animate-typing-dot rounded-full bg-brand-green"
                style={{ animationDelay: "0.2s" }}
              />
              <span
                className="h-1.5 w-1.5 animate-typing-dot rounded-full bg-brand-green"
                style={{ animationDelay: "0.4s" }}
              />
            </span>
          </div>
          {text && (
            <pre className="whitespace-pre-wrap break-words font-sans text-sm text-ink-100">{text}</pre>
          )}
        </div>
      </div>
    </div>
  );
}

function Segment({
  messageId,
  segment,
  onSafeCopy,
}: {
  messageId: string;
  segment: MessageSegment;
  onSafeCopy: (messageId: string, block: string) => void;
}) {
  const klass = segment.tag === "KB" ? "kb" : segment.tag === "WEB" ? "web" : "gen";
  const renderText = (text: string): React.ReactNode => {
    const parts = text.split(/(```[\s\S]*?```)/g);
    return parts.map((p, i) => {
      if (p.startsWith("```")) {
        const code = p.replace(/^```[a-zA-Z0-9]*\n?/, "").replace(/```$/, "");
        return <CodeBlock key={i} code={code} onSafeCopy={() => onSafeCopy(messageId, code)} />;
      }
      return (
        <pre key={i} className="my-1 whitespace-pre-wrap break-words font-sans text-sm text-ink-100">
          {p}
        </pre>
      );
    });
  };
  return (
    <div className={`message-segment ${klass} my-2 pl-3`}>
      {renderText(segment.text)}
      {segment.citations.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {segment.citations.map((c, i) => (
            <CitationChip key={i} cite={c} tag={segment.tag} />
          ))}
        </div>
      )}
    </div>
  );
}

const RISK_TOP_EDGE = {
  low: "border-t-brand-green/60",
  medium: "border-t-amber-500/70",
  high: "border-t-rose-500/80",
  critical: "border-t-red-600",
} as const;

const RISK_TAG_TEXT = {
  low: "low risk · read-only",
  medium: "medium risk",
  high: "high risk · state-changing",
  critical: "CRITICAL · destructive",
} as const;

const RISK_TAG_COLOR = {
  low: "text-brand-green",
  medium: "text-amber-500",
  high: "text-rose-500",
  critical: "text-red-500 font-bold tracking-wider",
} as const;

function CodeBlock({ code, onSafeCopy }: { code: string; onSafeCopy: () => void }) {
  const risk = useMemo(() => classifyBlock(code), [code]);
  return (
    <div
      className={`safe-copy-block my-2 rounded-md border border-t-2 border-white/[0.08] ${RISK_TOP_EDGE[risk.level]} bg-black/85 p-3`}
      onCopy={(e) => e.preventDefault()}
    >
      <div className="mb-2 flex items-center justify-between text-[10px]">
        <span className={`uppercase tracking-wider ${RISK_TAG_COLOR[risk.level]}`}>
          {RISK_TAG_TEXT[risk.level]}
        </span>
        <button
          onClick={onSafeCopy}
          className="rounded-full border border-brand-green/30 px-3 py-1 text-[10px] font-medium text-brand-green transition-colors hover:bg-brand-green/10"
        >
          Review &amp; Copy
        </button>
      </div>
      <pre className="overflow-x-auto whitespace-pre font-mono text-xs text-ink-100">{code}</pre>
    </div>
  );
}

const CITATION_COLORS: Record<ProvenanceTag, string> = {
  KB: "border-brand-green/30 bg-brand-green/5 text-brand-green hover:bg-brand-green/15",
  WEB: "border-cyan-400/30 bg-cyan-400/5 text-cyan-400 hover:bg-cyan-400/15",
  GEN: "border-brand-purple/30 bg-brand-purple/5 text-brand-purple hover:bg-brand-purple/15",
};

function CitationChip({ cite, tag }: { cite: string; tag: ProvenanceTag }) {
  const [docId, ptr] = cite.split("#");
  const label = ptr || (docId ? docId.slice(0, 8) : cite);
  return (
    <span
      title={cite}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] transition-colors ${CITATION_COLORS[tag]}`}
    >
      <span className="opacity-60">§</span>
      {label}
    </span>
  );
}

export default Chat;
