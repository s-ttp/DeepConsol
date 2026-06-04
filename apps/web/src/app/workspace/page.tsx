"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { useAuth } from "@/lib/auth-context";
import { sanitize, loadSanitizerOverlay } from "@/lib/sanitizer-rules";
import ConnectDialog, { type ConnectedSession } from "@/components/ConnectDialog";
import ContextDrawer, { type Snippet } from "@/components/ContextDrawer";
import SanitizePreview from "@/components/SanitizePreview";
import Chat, { type ChatHandle } from "@/components/Chat";
import { SettingsModal } from "@/components/SettingsModal";
import { api } from "@/lib/api";

// Terminal stays dynamic with ssr:false because xterm.js touches DOM at
// import time. Chat is imported normally — `next/dynamic` does NOT forward
// refs, which broke the Drawer → Chat appendDraft handoff.
const Terminal = dynamic(() => import("@/components/Terminal"), { ssr: false });

const SNIPPETS_KEY = "deepconsol.context.snippets.v1";
const CHAT_WIDTH_KEY = "deepconsol.workspace.chatWidth.v1";
const CHAT_WIDTH_MIN = 360;
const CHAT_WIDTH_MAX_FRACTION = 0.7; // chat can grow up to 70% of viewport
const CHAT_WIDTH_DEFAULT = 480;

interface SessionTab {
  id: string;
  label: string;
}

export default function WorkspacePage() {
  const router = useRouter();
  const { user, loading, logout } = useAuth();
  const [sessions, setSessions] = useState<SessionTab[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [showConnect, setShowConnect] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; selection: string } | null>(null);
  const [sanitizePreview, setSanitizePreview] = useState<string | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Snippets live at the workspace level — the drawer is now a popup, so its
  // component lifecycle starts/stops on every open. If the snippet store sat
  // inside ContextDrawer, pin events fired while the drawer was closed would
  // be dropped on the floor (which was the user-visible bug).
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set());
  const [drawerPulse, setDrawerPulse] = useState(false);
  const [chatWidth, setChatWidth] = useState<number>(CHAT_WIDTH_DEFAULT);
  const [resizing, setResizing] = useState(false);
  const chatRef = useRef<ChatHandle | null>(null);

  // Hydrate the saved chat-panel width once the page mounts.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(CHAT_WIDTH_KEY);
      if (raw) {
        const n = parseInt(raw, 10);
        if (Number.isFinite(n) && n > 0) setChatWidth(clampChatWidth(n));
      }
    } catch { /* noop */ }
  }, []);

  // Persist whenever the user finishes a drag.
  useEffect(() => {
    if (resizing) return;
    try { localStorage.setItem(CHAT_WIDTH_KEY, String(chatWidth)); } catch { /* noop */ }
  }, [resizing, chatWidth]);

  // Global drag handlers — bound only while resizing so the page doesn't pay
  // for these listeners when idle.
  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: MouseEvent): void => {
      // The drag handle is on the LEFT edge of the chat panel, so a smaller
      // clientX (further left) means a wider chat.
      const next = window.innerWidth - e.clientX;
      setChatWidth(clampChatWidth(next));
    };
    const onUp = (): void => setResizing(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    // Lock cursor + disable text selection while dragging so the resize feels
    // continuous and doesn't accidentally select chat text.
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [resizing]);

  // Re-clamp on viewport resize so the saved width never exceeds the new max.
  useEffect(() => {
    const onResize = (): void => setChatWidth((w) => clampChatWidth(w));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Hydrate from sessionStorage once the page mounts so pins survive a tab
  // refresh within the same browser session.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(SNIPPETS_KEY);
      if (raw) setSnippets(JSON.parse(raw) as Snippet[]);
    } catch { /* noop */ }
  }, []);

  // Load the admin sanitizer overlay (custom rules + disabled built-ins) so
  // client-side sanitization matches the configured policy (falls back to the
  // baseline until/if it loads). Re-fetch when the tab regains focus so an
  // admin who just edited the filters sees the change here without a hard
  // reload — the rules otherwise live in a module singleton loaded once.
  useEffect(() => {
    void loadSanitizerOverlay();
    const refresh = (): void => { void loadSanitizerOverlay(); };
    const onVisible = (): void => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    try { sessionStorage.setItem(SNIPPETS_KEY, JSON.stringify(snippets)); } catch { /* noop */ }
  }, [snippets]);

  const addSnippet = useCallback((text: string, source: Snippet["source"]): void => {
    const sanitized = sanitize(text).sanitized;
    if (!sanitized.trim()) return;
    const id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setSnippets((prev) => [
      { id, text: sanitized, source, tags: [], pinned: false, created_at: Date.now() },
      ...prev,
    ]);
    setFreshIds((prev) => new Set(prev).add(id));
    setTimeout(() => {
      setFreshIds((prev) => {
        const n = new Set(prev);
        n.delete(id);
        return n;
      });
    }, 1500);
  }, []);

  const removeSnippet = useCallback((id: string): void => {
    setSnippets((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const togglePinSnippet = useCallback((id: string): void => {
    setSnippets((prev) => prev.map((s) => (s.id === id ? { ...s, pinned: !s.pinned } : s)));
  }, []);

  const clearSnippets = useCallback((): void => {
    setSnippets([]);
  }, []);

  // Listen globally for pin events. The terminal's right-click "Pin to
  // Context Drawer" dispatches this event, which now flows directly into our
  // state instead of being routed through the (sometimes-unmounted) drawer.
  // Also auto-opens the drawer so the user gets immediate visual confirmation.
  useEffect(() => {
    const handler = (ev: Event): void => {
      const detail = (ev as CustomEvent<{ text: string; source: Snippet["source"] }>).detail;
      if (!detail) return;
      addSnippet(detail.text, detail.source);
      // Pulse the header button briefly even if we don't auto-open.
      setDrawerPulse(true);
      setTimeout(() => setDrawerPulse(false), 1500);
      // Auto-open from terminal pins (the typical entry point); keep notes
      // added from inside the drawer from re-triggering a flash by routing
      // them through addSnippet directly, not through this event.
      if (detail.source === "terminal") setDrawerOpen(true);
    };
    window.addEventListener("deepconsol:pin-to-drawer", handler);
    return () => window.removeEventListener("deepconsol:pin-to-drawer", handler);
  }, [addSnippet]);

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
    else if (user?.must_rotate_password) router.replace("/rotate-password");
  }, [loading, user, router]);

  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = (): void => setContextMenu(null);
    window.addEventListener("click", dismiss);
    return () => window.removeEventListener("click", dismiss);
  }, [contextMenu]);

  // Esc closes the drawer popup so engineers can pop back to the terminal fast.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  if (loading || !user) return null;

  // Refresh the ruleset before previewing so the modal reflects the latest
  // admin config even if it changed mid-session.
  const sendToChat = (text: string): void => {
    void loadSanitizerOverlay().finally(() => setSanitizePreview(text));
  };

  const pinToDrawer = (text: string): void => {
    window.dispatchEvent(
      new CustomEvent("deepconsol:pin-to-drawer", { detail: { text, source: "terminal" } })
    );
  };

  const copySanitized = async (text: string): Promise<void> => {
    await loadSanitizerOverlay();
    const cleaned = sanitize(text).sanitized;
    try { await navigator.clipboard.writeText(cleaned); } catch { /* noop */ }
  };

  const insertSnippetsToChat = (items: Snippet[]): void => {
    if (items.length === 0) return;
    chatRef.current?.appendDraft(items.map((s) => s.text).join("\n\n---\n\n"));
    setDrawerOpen(false);
  };

  const addSession = (s: ConnectedSession): void => {
    setSessions((prev) => (prev.some((p) => p.id === s.id) ? prev : [...prev, { id: s.id, label: s.target }]));
    setActiveSessionId(s.id);
  };

  const closeSession = (id: string): void => {
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      // If we just closed the active tab, focus the most-recent remaining one.
      if (id === activeSessionId) {
        setActiveSessionId(next.length > 0 ? next[next.length - 1].id : null);
      }
      return next;
    });
    // Explicitly close the server-side row. The WS-gateway cleanup also runs
    // on socket close, but that path is missed when the WS never connected
    // (dialog cancelled, network blip, browser refresh during connect).
    // Without this call, orphaned rows accumulate and trip the per-user
    // session cap (429 "too_many_active_sessions"). The endpoint is
    // idempotent — a 404 on already-closed rows is fine.
    void api.post(`/terminal/sessions/${id}/close`).catch(() => { /* tolerate */ });
  };

  return (
    <main className="flex h-screen flex-col bg-ink-950 text-app-text">
      <header className="z-10 flex items-center justify-between border-b border-ink-800 bg-ink-900 px-5 py-3">
        <div className="flex items-center gap-3">
          <span className="text-base font-semibold tracking-tight text-ink-100">
            <span className="text-brand-green">Deep</span>Consol
          </span>
          <span className="rounded border border-ink-700 bg-ink-800 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-ink-300">
            {user.role}
          </span>
        </div>
        <div className="flex items-center gap-4 text-xs text-ink-300">
          <button
            onClick={() => setShowConnect(true)}
            className="inline-flex items-center justify-center rounded-md bg-brand-purple px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-purple/90 focus:outline-none focus:ring-2 focus:ring-brand-purple/60 focus:ring-offset-2 focus:ring-offset-ink-900 transition-colors"
          >
            New session
          </button>
          <button
            onClick={() => setDrawerOpen((v) => !v)}
            className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
              drawerOpen
                ? "border-brand-purple/40 bg-brand-purple/15 text-brand-purple"
                : "border-ink-700 bg-ink-900 text-ink-200 hover:bg-ink-800"
            } ${drawerPulse ? "animate-pin-glow" : ""}`}
            title="Toggle context drawer"
          >
            <span>Drawer</span>
            <span
              className={`flex min-w-[20px] items-center justify-center rounded px-1.5 py-px text-[10px] font-semibold ${
                snippets.length > 0
                  ? drawerOpen
                    ? "bg-brand-purple/30 text-brand-purple"
                    : "bg-ink-800 text-ink-100"
                  : "bg-ink-800 text-ink-500"
              }`}
            >
              {snippets.length}
            </span>
          </button>
          {user.role === "admin" && (
            <a href="/admin" className="text-ink-300 hover:text-ink-100 transition-colors">Admin</a>
          )}
          <button onClick={() => setShowSettings(true)} className="text-ink-300 hover:text-ink-100 transition-colors">Settings</button>
          <span className="text-ink-400">{user.email}</span>
          <button onClick={() => void logout()} className="text-ink-300 hover:text-ink-100 transition-colors">Logout</button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-black">
          {sessions.length > 0 && (
            <div className="flex items-center gap-1 overflow-x-auto border-b border-white/[0.06] bg-ink-900/60 px-2 py-1.5 backdrop-blur-md">
              {sessions.map((s) => (
                <SessionTabButton
                  key={s.id}
                  active={s.id === activeSessionId}
                  label={s.label}
                  onActivate={() => setActiveSessionId(s.id)}
                  onClose={() => closeSession(s.id)}
                />
              ))}
              <button
                onClick={() => setShowConnect(true)}
                title="New SSH or Telnet session"
                className="ml-1 grid h-7 w-7 shrink-0 place-items-center rounded-full border border-ink-700 text-ink-300 hover:border-brand-purple/60 hover:text-brand-purple hover:bg-brand-purple/10 transition-all"
              >
                +
              </button>
            </div>
          )}
          <div className="relative min-h-0 flex-1">
            {sessions.length === 0 ? (
              <div className="grid h-full place-items-center text-ink-500">
                <div className="text-center">
                  <p className="text-sm">No active session.</p>
                  <button
                    onClick={() => setShowConnect(true)}
                    className="mt-4 rounded-full bg-brand-purple px-6 py-2.5 text-sm font-medium text-white hover:bg-brand-purple/80 hover:shadow-[0_0_15px_rgba(138,43,226,0.5)] transition-all"
                  >
                    Open SSH or Telnet session
                  </button>
                </div>
              </div>
            ) : (
              // Stack all terminals; only the active one is visible. Inactive
              // ones stay mounted so their SSH sessions / scrollback persist
              // across tab switches.
              sessions.map((s) => (
                <div
                  key={s.id}
                  className={`absolute inset-0 ${s.id === activeSessionId ? "" : "invisible pointer-events-none"}`}
                >
                  <Terminal
                    sessionId={s.id}
                    onSelectionChange={() => { /* handled in context-menu via getSelection */ }}
                    onContextMenu={(selection, x, y) => setContextMenu({ x, y, selection })}
                    onClose={() => closeSession(s.id)}
                  />
                </div>
              ))
            )}
          </div>
        </section>

        {/* Drag handle — sits between the terminal area and the chat panel.
            Hovers/drags expand the hit area visually so the line is easy to grab. */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize chat panel"
          title="Drag to resize chat panel · double-click to reset"
          onMouseDown={(e) => { e.preventDefault(); setResizing(true); }}
          onDoubleClick={() => setChatWidth(clampChatWidth(CHAT_WIDTH_DEFAULT))}
          className={`group relative h-full w-1.5 shrink-0 cursor-col-resize bg-ink-800/40 transition-colors hover:bg-brand-purple/30 ${resizing ? "bg-brand-purple/50" : ""}`}
        >
          <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-white/10 group-hover:bg-brand-purple/60" />
        </div>

        <section
          className="flex h-full min-h-0 shrink-0 flex-col border-l border-ink-800"
          style={{ width: `${chatWidth}px` }}
        >
          <Chat ref={chatRef} threadId={threadId} onCreateThread={setThreadId} />
        </section>
      </div>

      {drawerOpen && (
        <div
          className="fixed inset-0 z-40 grid place-items-center bg-black/70 p-6 backdrop-blur-sm"
          onClick={() => setDrawerOpen(false)}
        >
          <div
            // Solid bg-ink-900 + ink-800 border matches the rest of the modal
            // family (Settings, Connect, SafeCopy). The modal is large enough
            // that the calm border still reads cleanly against the backdrop.
            className="flex h-[85vh] w-[min(1240px,94vw)] flex-col overflow-hidden rounded-lg border border-ink-800 bg-ink-900 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <ContextDrawer
              snippets={snippets}
              freshIds={freshIds}
              onAddNote={(text) => addSnippet(text, "note")}
              onRemoveSnippet={removeSnippet}
              onTogglePin={togglePinSnippet}
              onClearAll={clearSnippets}
              onInsertToChat={insertSnippetsToChat}
              onSwitchToTerminal={() => setDrawerOpen(false)}
              onClose={() => setDrawerOpen(false)}
            />
          </div>
        </div>
      )}

      {showConnect && (
        <ConnectDialog
          onConnect={(s) => { addSession(s); setShowConnect(false); }}
          onClose={() => setShowConnect(false)}
        />
      )}

      <SettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} />

      {contextMenu && (
        <ul
          className="fixed z-50 w-56 rounded-xl border border-white/[0.08] bg-ink-900/95 p-1 text-sm shadow-[0_8px_32px_rgba(0,0,0,0.5)] backdrop-blur-xl"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <ContextItem onClick={() => { sendToChat(contextMenu.selection); setContextMenu(null); }}>
            Send to Chat (sanitized)
          </ContextItem>
          <ContextItem onClick={() => { pinToDrawer(contextMenu.selection); setContextMenu(null); }}>
            Pin to Context Drawer
          </ContextItem>
          <ContextItem onClick={() => { void copySanitized(contextMenu.selection); setContextMenu(null); }}>
            Copy Sanitized
          </ContextItem>
        </ul>
      )}

      {sanitizePreview && (
        <SanitizePreview
          raw={sanitizePreview}
          onCancel={() => setSanitizePreview(null)}
          onConfirm={(cleaned) => {
            chatRef.current?.appendDraft(cleaned);
            setSanitizePreview(null);
          }}
        />
      )}
    </main>
  );
}

function SessionTabButton({
  active,
  label,
  onActivate,
  onClose,
}: {
  active: boolean;
  label: string;
  onActivate: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className={`group flex shrink-0 items-center gap-1 rounded-lg border px-3 py-1 text-xs transition-all ${
        active
          ? "border-brand-green/50 bg-brand-green/[0.08] text-brand-green shadow-[0_0_8px_rgba(0,255,163,0.18)]"
          : "border-transparent text-ink-300 hover:bg-white/[0.04] hover:text-ink-100"
      }`}
    >
      <button onClick={onActivate} className="max-w-[220px] truncate font-medium" title={label}>
        {label}
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        title="Close session"
        className="grid h-4 w-4 place-items-center rounded-full text-ink-500 hover:bg-white/[0.10] hover:text-rose-400"
      >
        ×
      </button>
    </div>
  );
}

function clampChatWidth(value: number): number {
  if (typeof window === "undefined") return value;
  const max = Math.max(CHAT_WIDTH_MIN, Math.floor(window.innerWidth * CHAT_WIDTH_MAX_FRACTION));
  return Math.min(max, Math.max(CHAT_WIDTH_MIN, Math.round(value)));
}

function ContextItem({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <li>
      <button
        onClick={onClick}
        className="block w-full rounded-sm px-2 py-1 text-left text-ink-200 hover:bg-ink-800"
      >
        {children}
      </button>
    </li>
  );
}
