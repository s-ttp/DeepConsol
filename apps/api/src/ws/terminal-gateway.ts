import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import { Client as SshClient } from "ssh2";
import { z } from "zod";
import { verifySession } from "../auth/jwt.js";
import { query } from "../db/pool.js";
import { decrypt } from "../services/crypto.js";
import { audit } from "../services/audit.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { redisConnection } from "../services/queue.js";
import { TelnetSession } from "./telnet.js";

/**
 * Terminal gateway: bridges xterm.js (browser WSS) to ssh2 (real SSH PTY).
 *
 * Wire protocol (JSON frames over a single WS):
 *  {type:"input", data: string}            // keystrokes
 *  {type:"resize", cols: number, rows: number}
 *  {type:"signal", name: "SIGINT"|"SIGTERM"|...}
 *  {type:"close"}
 *
 * Server → client:
 *  {type:"ready"}                           // PTY allocated, shell open
 *  {type:"data", data: string}              // PTY output
 *  {type:"error", message: string}
 *  {type:"closed", code?: number, reason?: string}
 */

const ResizeFrame = z.object({ type: z.literal("resize"), cols: z.number().int().positive(), rows: z.number().int().positive() });
const InputFrame = z.object({ type: z.literal("input"), data: z.string() });
const SignalFrame = z.object({ type: z.literal("signal"), name: z.string().min(1).max(20) });
const CloseFrame = z.object({ type: z.literal("close") });
const Frame = z.union([ResizeFrame, InputFrame, SignalFrame, CloseFrame]);

type Protocol = "ssh" | "telnet";

interface ConnectInfo {
  protocol: Protocol;
  host: string;
  port: number;
  username: string;
  auth_type: "password" | "key";
  secret: string;
  bastion_host?: string | null;
  bastion_port?: number | null;
  bastion_username?: string | null;
}

async function loadConnectInfo(
  user_id: string,
  session_id: string,
  credential_id: string | null
): Promise<ConnectInfo | null> {
  if (credential_id) {
    const { rows } = await query<{
      protocol: Protocol;
      host: string;
      port: number;
      username: string;
      auth_type: "password" | "key";
      encrypted_secret: string;
      iv: string;
      auth_tag: string;
      bastion_host: string | null;
      bastion_port: number | null;
      bastion_username: string | null;
    }>(
      `SELECT protocol, host, port, username, auth_type, encrypted_secret, iv, auth_tag,
              bastion_host, bastion_port, bastion_username
         FROM ssh_credentials WHERE id = $1 AND user_id = $2`,
      [credential_id, user_id]
    );
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      protocol: r.protocol,
      host: r.host,
      port: r.port,
      username: r.username,
      auth_type: r.auth_type,
      secret: decrypt({ ciphertext: r.encrypted_secret, iv: r.iv, auth_tag: r.auth_tag }),
      bastion_host: r.bastion_host,
      bastion_port: r.bastion_port,
      bastion_username: r.bastion_username,
    };
  }
  const cached = await redisConnection.get(`deepconsol:term:adhoc:${session_id}`);
  if (!cached) return null;
  await redisConnection.del(`deepconsol:term:adhoc:${session_id}`);
  const { ciphertext, iv, auth_tag } = JSON.parse(cached);
  const json = decrypt({ ciphertext, iv, auth_tag });
  const parsed = JSON.parse(json) as {
    protocol?: Protocol;
    host: string;
    port: number;
    username: string;
    auth_type: "password" | "key";
    secret: string;
  };
  return {
    protocol: parsed.protocol ?? "ssh",
    host: parsed.host,
    port: parsed.port,
    username: parsed.username,
    auth_type: parsed.auth_type,
    secret: parsed.secret,
  };
}

function connectSsh(info: ConnectInfo): Promise<SshClient> {
  return new Promise((resolve, reject) => {
    const client = new SshClient();
    const opts: Parameters<SshClient["connect"]>[0] = {
      host: info.host,
      port: info.port,
      username: info.username,
      readyTimeout: 20_000,
      keepaliveInterval: 15_000,
    };
    if (info.auth_type === "password") {
      opts.password = info.secret;
    } else {
      opts.privateKey = info.secret;
    }
    client.on("ready", () => resolve(client));
    client.on("error", (err) => reject(err));
    client.connect(opts);
  });
}

export async function registerTerminalGateway(app: FastifyInstance): Promise<void> {
  app.get("/terminal/connect/:sessionId", { websocket: true }, async (socket: WebSocket, req) => {
    const sessionId = (req.params as { sessionId: string }).sessionId;
    const sendJson = (obj: unknown): void => {
      try {
        socket.send(JSON.stringify(obj));
      } catch {
        /* socket closed */
      }
    };

    const tokenFromQs = (req.query as { token?: string } | undefined)?.token;
    const tokenFromCookie = (req.cookies as Record<string, string> | undefined)?.[config.sessionCookieName];
    const token = tokenFromQs ?? tokenFromCookie;
    if (!token) {
      sendJson({ type: "error", message: "unauthenticated" });
      socket.close(4401, "unauthenticated");
      return;
    }
    let claims;
    try {
      claims = verifySession(token);
    } catch {
      sendJson({ type: "error", message: "invalid_session" });
      socket.close(4401, "invalid_session");
      return;
    }

    const { rows } = await query<{
      id: string;
      credential_id: string | null;
      metadata_json: { cols?: number; rows?: number };
      ended_at: Date | null;
    }>(
      "SELECT id, credential_id, metadata_json, ended_at FROM terminal_sessions WHERE id = $1 AND user_id = $2",
      [sessionId, claims.sub]
    );
    const session = rows[0];
    if (!session || session.ended_at) {
      sendJson({ type: "error", message: "session_not_found_or_closed" });
      socket.close(4404, "session_not_found");
      return;
    }

    const info = await loadConnectInfo(claims.sub, sessionId, session.credential_id);
    if (!info) {
      sendJson({ type: "error", message: "credentials_not_available" });
      socket.close(4404, "credentials_not_available");
      // The row is open but unusable — close it so it doesn't count toward
      // the per-user session cap.
      await endSession(sessionId, claims.sub, "credentials_not_available");
      return;
    }

    const cols = session.metadata_json.cols ?? 120;
    const termRows = session.metadata_json.rows ?? 32;

    if (info.protocol === "telnet") {
      await runTelnet(socket, sendJson, sessionId, claims.sub, info, cols, termRows);
    } else {
      await runSsh(socket, sendJson, sessionId, claims.sub, info, cols, termRows);
    }
  });
}

async function endSession(sessionId: string, userId: string, reason: string): Promise<void> {
  await query(
    "UPDATE terminal_sessions SET ended_at = NOW() WHERE id = $1 AND ended_at IS NULL",
    [sessionId]
  );
  await audit(userId, "terminal.session_ended", { session_id: sessionId, reason });
}

async function runSsh(
  socket: WebSocket,
  sendJson: (obj: unknown) => void,
  sessionId: string,
  userId: string,
  info: ConnectInfo,
  cols: number,
  termRows: number
): Promise<void> {
  let ssh: SshClient;
  try {
    ssh = await connectSsh(info);
  } catch (err: unknown) {
    const msg = (err as { message?: string }).message ?? "ssh connect failed";
    logger.warn({ err: msg, sessionId }, "ssh connect failed");
    sendJson({ type: "error", message: `ssh_connect_failed: ${msg}` });
    socket.close(4500, "ssh_connect_failed");
    // The WS-close handler that normally records ended_at is registered
    // *after* a successful SSH connect; on failure here we must close the
    // row ourselves or it stays open and trips the per-user cap.
    await endSession(sessionId, userId, "ssh_connect_failed");
    return;
  }

  ssh.shell({ term: "xterm-256color", cols, rows: termRows }, (err, stream) => {
    if (err || !stream) {
      sendJson({ type: "error", message: `shell_open_failed: ${err?.message ?? "unknown"}` });
      socket.close(4500, "shell_open_failed");
      ssh.end();
      // Same orphan-prevention as the connectSsh catch above. Fire-and-forget;
      // we're already in the shell callback and the surrounding function has
      // returned.
      void endSession(sessionId, userId, "shell_open_failed");
      return;
    }
    sendJson({ type: "ready" });

    stream.on("data", (chunk: Buffer) => {
      sendJson({ type: "data", data: chunk.toString("utf8") });
    });
    stream.stderr.on("data", (chunk: Buffer) => {
      sendJson({ type: "data", data: chunk.toString("utf8") });
    });

    let idleTimer = setTimeout(closeForIdle, config.terminalIdleTimeoutSec * 1000);
    function bumpIdle(): void {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(closeForIdle, config.terminalIdleTimeoutSec * 1000);
    }
    function closeForIdle(): void {
      sendJson({ type: "error", message: "idle_timeout" });
      try { stream!.signal("HUP"); } catch { /* noop */ }
      try { socket.close(4408, "idle_timeout"); } catch { /* noop */ }
    }

    socket.on("message", (raw: Buffer | string) => {
      bumpIdle();
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const result = Frame.safeParse(parsed);
      if (!result.success) return;
      const f = result.data;
      if (f.type === "input") {
        stream.write(f.data);
      } else if (f.type === "resize") {
        stream.setWindow(f.rows, f.cols, 0, 0);
      } else if (f.type === "signal") {
        try { stream.signal(f.name as Parameters<typeof stream.signal>[0]); } catch { /* noop */ }
      } else if (f.type === "close") {
        stream.end();
      }
    });

    const cleanup = async (reason: string): Promise<void> => {
      clearTimeout(idleTimer);
      try { stream.end(); } catch { /* noop */ }
      try { ssh.end(); } catch { /* noop */ }
      try { socket.close(); } catch { /* noop */ }
      await endSession(sessionId, userId, reason);
    };

    stream.on("close", () => { void cleanup("stream_close"); });
    ssh.on("close", () => { void cleanup("ssh_close"); });
    ssh.on("error", (e) => {
      sendJson({ type: "error", message: `ssh_error: ${e.message}` });
      void cleanup("ssh_error");
    });
    socket.on("close", () => { void cleanup("ws_close"); });
  });
}

async function runTelnet(
  socket: WebSocket,
  sendJson: (obj: unknown) => void,
  sessionId: string,
  userId: string,
  info: ConnectInfo,
  cols: number,
  termRows: number
): Promise<void> {
  const telnet = new TelnetSession({
    host: info.host,
    port: info.port,
    cols,
    rows: termRows,
    username: info.username || undefined,
    password: info.auth_type === "password" ? info.secret || undefined : undefined,
  });

  let cleanedUp = false;
  let idleTimer: NodeJS.Timeout | null = null;

  const cleanup = async (reason: string): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (idleTimer) clearTimeout(idleTimer);
    try { telnet.end(); } catch { /* noop */ }
    try { socket.close(); } catch { /* noop */ }
    await endSession(sessionId, userId, reason);
  };

  function bumpIdle(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      sendJson({ type: "error", message: "idle_timeout" });
      try { socket.close(4408, "idle_timeout"); } catch { /* noop */ }
      void cleanup("idle_timeout");
    }, config.terminalIdleTimeoutSec * 1000);
  }

  telnet.on("ready", () => {
    sendJson({ type: "ready" });
    bumpIdle();
  });
  telnet.on("data", (text: string) => {
    sendJson({ type: "data", data: text });
  });
  telnet.on("close", () => { void cleanup("telnet_close"); });
  telnet.on("error", (e: Error) => {
    logger.warn({ err: e.message, sessionId }, "telnet error");
    sendJson({ type: "error", message: `telnet_error: ${e.message}` });
    void cleanup("telnet_error");
  });

  socket.on("message", (raw: Buffer | string) => {
    bumpIdle();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const result = Frame.safeParse(parsed);
    if (!result.success) return;
    const f = result.data;
    if (f.type === "input") {
      telnet.write(f.data);
    } else if (f.type === "resize") {
      telnet.setWindow(f.cols, f.rows);
    } else if (f.type === "close") {
      telnet.end();
    }
    // Telnet has no in-band "signal" channel; signals are ignored.
  });

  socket.on("close", () => { void cleanup("ws_close"); });

  try {
    telnet.connect();
  } catch (err: unknown) {
    const msg = (err as { message?: string }).message ?? "telnet connect failed";
    logger.warn({ err: msg, sessionId }, "telnet connect failed");
    sendJson({ type: "error", message: `telnet_connect_failed: ${msg}` });
    socket.close(4500, "telnet_connect_failed");
    await cleanup("telnet_connect_failed");
  }
}
