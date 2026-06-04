import { EventEmitter } from "node:events";
import * as net from "node:net";

/**
 * Minimal Telnet client tailored for interactive PTY-style sessions to network
 * gear (Cisco IOS, Junos, Nokia/SAM, Ericsson MGW, etc.).
 *
 * What it implements:
 *  - IAC byte-stuffing parser (DO/DONT/WILL/WONT, SB/SE subnegotiation)
 *  - Negotiation: WILL TERM-TYPE (24), WILL NAWS (31), DO ECHO (1), DO SGA (3)
 *    (server-side echo + suppress-go-ahead — the typical "character mode")
 *  - Subnegotiation responses: TERM-TYPE → "XTERM-256COLOR"; NAWS → window size
 *  - Optional auto-login: if `username` / `password` are supplied, watches the
 *    output stream for canonical "Login:" / "Password:" prompts and replies
 *    once each. Stops after the password is sent (or after 60 s).
 *
 * What it does NOT implement: ENVIRON, CHARSET, line-mode (LINEMODE 34), MCCP,
 * authentication options. Real network gear almost never needs them.
 */

const IAC = 0xff;
const DONT = 0xfe;
const DO = 0xfd;
const WONT = 0xfc;
const WILL = 0xfb;
const SB = 0xfa;
const SE = 0xf0;

const OPT_BINARY = 0;
const OPT_ECHO = 1;
const OPT_SGA = 3;
const OPT_TERMTYPE = 24;
const OPT_NAWS = 31;

const SUB_IS = 0;
const SUB_SEND = 1;

export interface TelnetOptions {
  host: string;
  port: number;
  cols: number;
  rows: number;
  username?: string;
  password?: string;
  termType?: string;
  connectTimeoutMs?: number;
}

export interface TelnetSessionEvents {
  ready: () => void;
  data: (text: string) => void;
  close: () => void;
  error: (err: Error) => void;
}

export class TelnetSession extends EventEmitter {
  private socket: net.Socket | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private cols: number;
  private rows: number;
  private termType: string;
  private autoUser?: string;
  private autoPass?: string;
  // Tail of recent printable output, used to detect login/password prompts.
  // Capped at ~256 bytes — prompts are short and we don't want unbounded growth.
  private tail = "";
  private loginState: "want_user" | "want_pass" | "done" = "want_user";
  private autoLoginTimeout: NodeJS.Timeout | null = null;
  private destroyed = false;

  constructor(private opts: TelnetOptions) {
    super();
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.termType = (opts.termType ?? "XTERM-256COLOR").toUpperCase();
    this.autoUser = opts.username && opts.username.length > 0 ? opts.username : undefined;
    this.autoPass = opts.password && opts.password.length > 0 ? opts.password : undefined;
    if (!this.autoUser) this.loginState = this.autoPass ? "want_pass" : "done";
  }

  connect(): void {
    const sock = net.createConnection({
      host: this.opts.host,
      port: this.opts.port,
      // Telnet is byte-oriented; we do our own IAC parsing.
      allowHalfOpen: false,
    });
    this.socket = sock;
    const timeoutMs = this.opts.connectTimeoutMs ?? 20_000;
    const connectTimer = setTimeout(() => {
      if (!sock.connecting) return;
      sock.destroy(new Error("telnet connect timeout"));
    }, timeoutMs);

    sock.once("connect", () => {
      clearTimeout(connectTimer);
      this.emit("ready");
      // If we have credentials, give up auto-login after 60s to avoid
      // leaking creds into the user's typed input mid-session.
      if (this.autoUser || this.autoPass) {
        this.autoLoginTimeout = setTimeout(() => {
          this.loginState = "done";
        }, 60_000);
      }
    });
    sock.on("data", (chunk: Buffer) => this._onData(chunk));
    sock.on("close", () => {
      clearTimeout(connectTimer);
      if (this.autoLoginTimeout) clearTimeout(this.autoLoginTimeout);
      if (!this.destroyed) {
        this.destroyed = true;
        this.emit("close");
      }
    });
    sock.on("error", (err) => {
      clearTimeout(connectTimer);
      this.emit("error", err);
    });
  }

  write(data: string): void {
    if (!this.socket || this.socket.destroyed) return;
    // RFC 854: any 0xFF byte in the user data must be doubled.
    let out: Buffer = Buffer.from(data, "utf8");
    if (out.includes(IAC)) {
      const parts: Buffer[] = [];
      let last = 0;
      for (let i = 0; i < out.length; i++) {
        if (out[i] === IAC) {
          parts.push(out.subarray(last, i + 1), Buffer.from([IAC]));
          last = i + 1;
        }
      }
      parts.push(out.subarray(last));
      out = Buffer.concat(parts);
    }
    this.socket.write(out);
  }

  setWindow(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this._sendNaws();
  }

  end(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.autoLoginTimeout) clearTimeout(this.autoLoginTimeout);
    try { this.socket?.end(); } catch { /* noop */ }
  }

  private _onData(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: number[] = [];
    // Only advance `consumed` past complete frames or plain data bytes. Any
    // partial frame at the tail stays in `this.buf` for the next chunk.
    let consumed = 0;
    let i = 0;

    while (i < this.buf.length) {
      const b = this.buf[i];
      if (b !== IAC) {
        out.push(b);
        i++;
        consumed = i;
        continue;
      }
      if (i + 1 >= this.buf.length) break; // need cmd byte
      const cmd = this.buf[i + 1];
      if (cmd === IAC) {
        out.push(IAC);
        i += 2;
        consumed = i;
        continue;
      }
      if (cmd === DO || cmd === DONT || cmd === WILL || cmd === WONT) {
        if (i + 2 >= this.buf.length) break; // need option byte
        this._handleNegotiation(cmd, this.buf[i + 2]);
        i += 3;
        consumed = i;
        continue;
      }
      if (cmd === SB) {
        // Scan for the closing IAC SE, allowing escaped IAC bytes inside.
        let j = i + 2;
        let endAt = -1;
        while (j < this.buf.length - 1) {
          if (this.buf[j] === IAC) {
            if (this.buf[j + 1] === SE) { endAt = j + 2; break; }
            if (this.buf[j + 1] === IAC) { j += 2; continue; }
            // Spec violation; treat any other IAC <X> as terminator.
            endAt = j + 2;
            break;
          }
          j++;
        }
        if (endAt < 0) break; // wait for SE
        const subBytes: number[] = [];
        let k = i + 2;
        while (k < endAt - 2) {
          if (this.buf[k] === IAC && k + 1 < endAt - 2 && this.buf[k + 1] === IAC) {
            subBytes.push(IAC);
            k += 2;
          } else {
            subBytes.push(this.buf[k]);
            k++;
          }
        }
        this._handleSubneg(Buffer.from(subBytes));
        i = endAt;
        consumed = i;
        continue;
      }
      // Other 2-byte IAC commands (NOP, BRK, IP, AO, AYT, EC, EL, GA): ignore.
      i += 2;
      consumed = i;
    }

    this.buf = this.buf.subarray(consumed);

    if (out.length) {
      // Accept that a multibyte UTF-8 sequence might split across a chunk; for
      // network-gear sessions this is dominantly ASCII, so we tolerate that.
      const text = Buffer.from(out).toString("utf8");
      this.emit("data", text);
      this._maybeAutoLogin(text);
    }
  }

  private _handleNegotiation(cmd: number, opt: number): void {
    if (!this.socket) return;
    let response: number;
    if (cmd === DO) {
      response = opt === OPT_TERMTYPE || opt === OPT_NAWS || opt === OPT_SGA ? WILL : WONT;
    } else if (cmd === WILL) {
      response = opt === OPT_ECHO || opt === OPT_SGA || opt === OPT_BINARY ? DO : DONT;
    } else if (cmd === DONT) {
      response = WONT;
    } else {
      response = DONT;
    }
    this.socket.write(Buffer.from([IAC, response, opt]));

    // After agreeing to NAWS, push the current window dimensions.
    if (cmd === DO && opt === OPT_NAWS && response === WILL) {
      this._sendNaws();
    }
  }

  private _handleSubneg(sub: Buffer): void {
    if (!this.socket || sub.length < 1) return;
    const opt = sub[0];
    if (opt === OPT_TERMTYPE && sub[1] === SUB_SEND) {
      const term = Buffer.from(this.termType, "ascii");
      this.socket.write(
        Buffer.concat([
          Buffer.from([IAC, SB, OPT_TERMTYPE, SUB_IS]),
          term,
          Buffer.from([IAC, SE]),
        ])
      );
    }
    // We don't request anything else, so other subneg payloads are ignored.
  }

  private _sendNaws(): void {
    if (!this.socket) return;
    const buf = Buffer.alloc(9);
    buf[0] = IAC;
    buf[1] = SB;
    buf[2] = OPT_NAWS;
    // 16-bit big-endian width then height. RFC 1073.
    buf.writeUInt16BE(Math.max(1, Math.min(0xffff, this.cols)), 3);
    buf.writeUInt16BE(Math.max(1, Math.min(0xffff, this.rows)), 5);
    buf[7] = IAC;
    buf[8] = SE;
    this.socket.write(buf);
  }

  private _maybeAutoLogin(text: string): void {
    if (this.loginState === "done" || !this.socket) return;
    this.tail = (this.tail + text).slice(-256);
    if (this.loginState === "want_user" && this.autoUser) {
      // Common forms: "Username:", "login:", "User Name:"
      if (/(?:^|[\s\r\n])(?:user(?:\s*name)?|login)\s*:\s*$/i.test(this.tail)) {
        this.socket.write(`${this.autoUser}\r\n`);
        this.tail = "";
        this.loginState = this.autoPass ? "want_pass" : "done";
      }
      return;
    }
    if (this.loginState === "want_pass" && this.autoPass) {
      if (/password\s*:\s*$/i.test(this.tail)) {
        this.socket.write(`${this.autoPass}\r\n`);
        this.tail = "";
        this.loginState = "done";
      }
    }
  }
}
