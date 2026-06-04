"use client";

import { useEffect, useImperativeHandle, useLayoutEffect, useRef, forwardRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { useSettings } from "./SettingsContext";

export interface TerminalHandle {
  search: (q: string) => void;
  focus: () => void;
  getSelection: () => string;
  fit: () => void;
}

export interface TerminalProps {
  sessionId: string;
  onSelectionChange: (selection: string) => void;
  onContextMenu: (selection: string, x: number, y: number) => void;
  onClose: () => void;
}

const Terminal = forwardRef<TerminalHandle, TerminalProps>(function Terminal(
  { sessionId, onSelectionChange, onContextMenu, onClose },
  ref
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  
  const { settings } = useSettings();

  // Keep the latest callbacks in refs so the WS-attach effect can fire ONCE
  // per session. Otherwise every parent re-render produces new prop function
  // identities, retriggers the effect, and closes the live SSH session.
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onContextMenuRef = useRef(onContextMenu);
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => { onSelectionChangeRef.current = onSelectionChange; });
  useLayoutEffect(() => { onContextMenuRef.current = onContextMenu; });
  useLayoutEffect(() => { onCloseRef.current = onClose; });

  useEffect(() => {
    if (!containerRef.current) return;

    const getTheme = () => {
      const base = {
        background: "#000000",
        foreground: "#e2e8f0",
        cursor: "#38bdf8",
        // Brand-purple translucent — reads against any ANSI color the shell
        // emits, and ties the terminal to the rest of the workspace palette.
        selectionBackground: "rgba(138, 43, 226, 0.4)",
        black: "#000000",
        red: "#f87171",
        green: "#4ade80",
        yellow: "#facc15",
        blue: "#60a5fa",
        magenta: "#c084fc",
        cyan: "#22d3ee",
        white: "#e2e8f0",
      };
      if (settings.terminalTheme === "mac-green") {
        return {
          ...base,
          foreground: "#00FF00",
          cursor: "#00FF00",
          selectionBackground: "#004400",
          green: "#00FF00",
        };
      }
      return base;
    };

    const term = new XTerm({
      cursorBlink: true,
      fontFamily: settings.terminalFontFamily,
      fontSize: settings.terminalFontSize,
      scrollback: 10000,
      allowProposedApi: true,
      theme: getTheme(),
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    try {
      const webgl = new WebglAddon();
      term.loadAddon(webgl);
    } catch {
      /* WebGL unavailable; canvas renderer used as fallback. */
    }

    term.open(containerRef.current);
    fit.fit();

    xtermRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;

    // WSS connect — uses the public host from the browser's location, so works
    // both for self-signed deploys at https://<public-ip>/ and via reverse-proxy.
    const wsScheme = window.location.protocol === "https:" ? "wss" : "ws";
    const url = `${wsScheme}://${window.location.host}/terminal/connect/${sessionId}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      const { rows, cols } = term;
      ws.send(JSON.stringify({ type: "resize", rows, cols }));
    };
    ws.onmessage = (ev) => {
      try {
        const frame = JSON.parse(ev.data);
        if (frame.type === "data") {
          term.write(frame.data);
        } else if (frame.type === "ready") {
          term.writeln("\x1b[2;37m[deepconsol] connected\x1b[0m");
        } else if (frame.type === "error") {
          term.writeln(`\r\n\x1b[31m[deepconsol] ${frame.message}\x1b[0m`);
        }
      } catch {
        /* ignore parse errors */
      }
    };
    ws.onclose = () => {
      term.writeln("\r\n\x1b[2;37m[deepconsol] disconnected\x1b[0m");
      onCloseRef.current();
    };

    const onData = term.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data: d }));
    });

    const onResize = (): void => {
      try { fit.fit(); } catch { /* noop */ }
      const { rows, cols } = term;
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", rows, cols }));
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(containerRef.current);
    window.addEventListener("resize", onResize);

    const onSelection = term.onSelectionChange(() => {
      onSelectionChangeRef.current(term.getSelection());
    });

    const containerEl = containerRef.current;
    const handleContextMenu = (ev: MouseEvent): void => {
      const sel = term.getSelection();
      if (!sel) return;
      ev.preventDefault();
      onContextMenuRef.current(sel, ev.clientX, ev.clientY);
    };
    containerEl.addEventListener("contextmenu", handleContextMenu);

    return () => {
      onData.dispose();
      onSelection.dispose();
      ro.disconnect();
      window.removeEventListener("resize", onResize);
      containerEl.removeEventListener("contextmenu", handleContextMenu);
      try { ws.close(); } catch { /* noop */ }
      term.dispose();
      xtermRef.current = null;
    };
    // Only `sessionId` should re-trigger this effect; handlers are accessed
    // via refs above to avoid closing the SSH session on parent re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Update xterm options when settings change
  useEffect(() => {
    if (!xtermRef.current) return;
    
    xtermRef.current.options.fontFamily = settings.terminalFontFamily;
    xtermRef.current.options.fontSize = settings.terminalFontSize;
    
    const baseTheme = {
      background: "#000000",
      foreground: "#e2e8f0",
      cursor: "#38bdf8",
      selectionBackground: "#334155",
      black: "#000000",
      red: "#f87171",
      green: "#4ade80",
      yellow: "#facc15",
      blue: "#60a5fa",
      magenta: "#c084fc",
      cyan: "#22d3ee",
      white: "#e2e8f0",
    };
    if (settings.terminalTheme === "mac-green") {
      xtermRef.current.options.theme = {
        ...baseTheme,
        foreground: "#00FF00",
        cursor: "#00FF00",
        selectionBackground: "#004400",
        green: "#00FF00",
      };
    } else {
      xtermRef.current.options.theme = baseTheme;
    }
    
    // Changing font size requires refitting
    setTimeout(() => {
      try { fitRef.current?.fit(); } catch { /* noop */ }
    }, 10);
  }, [settings.terminalFontFamily, settings.terminalFontSize, settings.terminalTheme]);

  useImperativeHandle(ref, () => ({
    search: (q: string) => searchRef.current?.findNext(q),
    focus: () => xtermRef.current?.focus(),
    getSelection: () => xtermRef.current?.getSelection() ?? "",
    fit: () => fitRef.current?.fit(),
  }));

  return <div ref={containerRef} className="xterm-container h-full w-full" />;
});

export default Terminal;
