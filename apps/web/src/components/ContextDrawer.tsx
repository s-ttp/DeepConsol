"use client";

import { useState } from "react";
import { PrimaryButton, SecondaryButton, Textarea } from "./ui/Form";

export interface Snippet {
  id: string;
  text: string;
  source: "terminal" | "chat" | "note";
  tags: string[];
  pinned: boolean;
  created_at: number;
}

interface Props {
  // Controlled inputs — owned by the workspace so pin events are captured even
  // when the drawer is closed (the drawer is a popup that mounts/unmounts).
  snippets: Snippet[];
  freshIds: Set<string>;
  // Callbacks for state mutations.
  onAddNote: (text: string) => void;
  onRemoveSnippet: (id: string) => void;
  onTogglePin: (id: string) => void;
  onClearAll: () => void;
  // Drawer-only navigation.
  onInsertToChat: (snippets: Snippet[]) => void;
  onSwitchToTerminal: () => void;
  onClose: () => void;
}

export default function ContextDrawer({
  snippets,
  freshIds,
  onAddNote,
  onRemoveSnippet,
  onTogglePin,
  onClearAll,
  onInsertToChat,
  onSwitchToTerminal,
  onClose,
}: Props) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [noteText, setNoteText] = useState("");

  const toggle = (id: string): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const sorted = [...snippets].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.created_at - a.created_at
  );
  const pinnedCount = snippets.filter((s) => s.pinned).length;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-ink-800 px-5 py-3">
        <div className="flex items-baseline gap-3">
          <h3 className="text-base font-semibold text-ink-100">Context Drawer</h3>
          <span className="text-xs text-ink-400">
            {snippets.length} pinned{pinnedCount > 0 ? ` · ${pinnedCount} starred` : ""}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <SecondaryButton
            onClick={onSwitchToTerminal}
            title="Hide drawer and return to the SSH terminal so you can pin more items"
            className="px-3 py-1 text-xs"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
            <span>Pin more from terminal</span>
          </SecondaryButton>
          {snippets.length > 0 && (
            <button
              onClick={() => {
                if (confirm("Clear all snippets from the drawer?")) {
                  onClearAll();
                  setSelectedIds(new Set());
                }
              }}
              className="rounded-md border border-ink-700 bg-ink-900 px-3 py-1 text-xs text-ink-300 hover:border-danger-500/50 hover:bg-danger-500/10 hover:text-danger-500 transition-colors"
            >
              Clear all
            </button>
          )}
          <button
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close"
            className="grid h-7 w-7 place-items-center rounded-md text-ink-400 hover:bg-ink-800 hover:text-ink-100 transition-colors"
          >
            ×
          </button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[300px_minmax(0,1fr)] overflow-hidden">
        <aside className="flex flex-col gap-3 border-r border-ink-800 bg-ink-950 p-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-300">Add note</label>
            <Textarea
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              placeholder="Free-form note (alarm summary, hypothesis, RCA hint)…"
              rows={5}
              className="text-xs"
            />
            <SecondaryButton
              type="button"
              onClick={() => {
                if (noteText.trim()) {
                  onAddNote(noteText.trim());
                  setNoteText("");
                }
              }}
              disabled={!noteText.trim()}
              className="mt-2 w-full px-3 py-1.5 text-xs"
            >
              Add note
            </SecondaryButton>
          </div>
          <div className="rounded-md border border-ink-800 bg-ink-900 p-3 text-[11px] leading-relaxed text-ink-300">
            <p>
              Pin terminal output from any SSH/Telnet tab via right-click → <span className="text-ink-100">Pin to Context Drawer</span>. The drawer pops open automatically.
            </p>
            <p className="mt-2">
              Snippets are sanitized — secrets stripped, IMSI/IP/hostname pseudonymized — before they reach this list.
            </p>
            <p className="mt-2">
              Tick the items you want in your next message, then <span className="text-ink-100">Insert into chat</span>.
            </p>
          </div>
        </aside>

        <div className="min-h-0 overflow-y-auto bg-ink-950 p-4">
          {sorted.length === 0 ? (
            <div className="grid h-full place-items-center text-center text-xs text-ink-400">
              <div>
                <p className="text-sm">No pins yet.</p>
                <p className="mt-1.5 text-ink-500">Right-click a terminal selection to pin it, or add a note from the left.</p>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {sorted.map((s) => (
                <div
                  key={s.id}
                  className={`flex flex-col rounded-md border bg-ink-900 p-3 transition-colors ${
                    selectedIds.has(s.id)
                      ? "border-brand-purple/50 bg-brand-purple/[0.06]"
                      : "border-ink-800 hover:border-ink-700"
                  } ${freshIds.has(s.id) ? "animate-pin-glow" : ""}`}
                >
                  <div className="flex items-center justify-between text-[10px] text-ink-400">
                    <span className="font-medium uppercase tracking-wide text-ink-300">{s.source}</span>
                    <div className="flex gap-2">
                      <button
                        title="pin/unpin"
                        onClick={() => onTogglePin(s.id)}
                        className="hover:text-ink-100 transition-colors"
                      >
                        {s.pinned ? "★" : "☆"}
                      </button>
                      <button
                        title="remove"
                        onClick={() => onRemoveSnippet(s.id)}
                        className="hover:text-danger-500 transition-colors"
                      >
                        ×
                      </button>
                    </div>
                  </div>
                  <pre className="mt-2 max-h-56 flex-1 overflow-y-auto whitespace-pre-wrap break-all rounded bg-ink-950 p-2 font-mono text-[11px] text-ink-100">{s.text}</pre>
                  <label className="mt-2 flex items-center gap-2 text-[11px] text-ink-300">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(s.id)}
                      onChange={() => toggle(s.id)}
                      className="accent-brand-purple"
                    />
                    Include in next message
                  </label>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-ink-800 bg-ink-950/40 px-5 py-3">
        <p className="text-[11px] text-ink-400">
          Press <kbd className="rounded border border-ink-700 bg-ink-900 px-1.5 py-0.5 text-[10px] text-ink-200">Esc</kbd> to close.
          Items stay pinned across drawer toggles.
        </p>
        <PrimaryButton
          disabled={snippets.length === 0}
          onClick={() => {
            const items = selectedIds.size > 0
              ? sorted.filter((s) => selectedIds.has(s.id))
              : sorted;
            onInsertToChat(items);
            setSelectedIds(new Set());
          }}
        >
          {selectedIds.size > 0
            ? `Insert ${selectedIds.size} selected into chat`
            : `Insert all (${snippets.length}) into chat`}
        </PrimaryButton>
      </div>
    </div>
  );
}
