import net from "node:net";
import os from "node:os";
import { promises as dns } from "node:dns";
import { readFileSync } from "node:fs";

/**
 * Terminal target policy — decides which host/IP the terminal gateway may
 * open SSH/Telnet connections to.
 *
 * The gateway sits inside the server's network, so without a policy any
 * engineer could use a terminal session to reach things that are not network
 * devices: the server itself (Redis, Postgres, the API), other services bound
 * to its interfaces, or the cloud metadata endpoint (169.254.169.254).
 *
 * Rules, in order:
 *   1. Built-in deny list (loopback, link-local incl. cloud metadata,
 *      unspecified, multicast, reserved, broadcast) — always applied.
 *   2. Every IP address of this server's own interfaces — always denied.
 *   3. Admin deny list (TERMINAL_DENIED_CIDRS).
 *   4. Admin allow list (TERMINAL_ALLOWED_CIDRS): when non-empty, the target
 *      must be inside it. When empty, everything not denied is allowed (private
 *      ranges like 10.0.0.0/8 stay reachable — that's where devices live).
 *
 * Hostnames are resolved once; EVERY returned address must pass, and the caller
 * connects to the checked IP (not the name) so DNS can't swap the target
 * between check and connect.
 *
 * This module is pure (no app config import) so it can be unit-tested.
 */

const BUILTIN_DENY: Array<[string, string]> = [
  // IPv4
  ["0.0.0.0/8", "unspecified / 'this network'"],
  ["127.0.0.0/8", "loopback (this server)"],
  ["169.254.0.0/16", "link-local (includes cloud metadata 169.254.169.254)"],
  ["100.100.100.200/32", "cloud metadata (Alibaba)"],
  ["224.0.0.0/4", "multicast"],
  ["255.255.255.255/32", "broadcast"], // before 240/4 so the specific reason wins
  ["240.0.0.0/4", "reserved"],
  // IPv6
  ["::/128", "unspecified"],
  ["::1/128", "loopback (this server)"],
  ["fe80::/10", "link-local"],
  ["fd00:ec2::254/128", "cloud metadata (AWS IPv6)"],
  ["ff00::/8", "multicast"],
];

export interface TargetPolicy {
  /** Built-in + admin deny entries, each with a human-readable reason. */
  deny: Array<{ list: net.BlockList; reason: string }>;
  /** Admin allow list; null = allow anything not denied. */
  allow: net.BlockList | null;
  allowCidrs: string[];
  /** Addresses of this host's interfaces (re-read on every check). */
  selfAddresses: () => string[];
}

export type TargetDecision =
  | { ok: true; ip: string; family: 4 | 6 }
  | { ok: false; reason: string; ip?: string };

/** Parse "10.0.0.0/8" or a bare IP ("192.0.2.7", "2001:db8::1") into a subnet. */
export function parseCidr(raw: string): { network: string; prefix: number; type: "ipv4" | "ipv6" } {
  const s = raw.trim();
  const [addr, pfx] = s.split("/");
  const fam = net.isIP(addr);
  if (!fam) throw new Error(`Invalid CIDR/IP in terminal policy: "${raw}"`);
  const max = fam === 4 ? 32 : 128;
  const prefix = pfx === undefined ? max : Number(pfx);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) {
    throw new Error(`Invalid prefix length in terminal policy: "${raw}"`);
  }
  return { network: addr, prefix, type: fam === 4 ? "ipv4" : "ipv6" };
}

function blockListOf(cidrs: string[]): net.BlockList {
  const bl = new net.BlockList();
  for (const c of cidrs) {
    const { network, prefix, type } = parseCidr(c);
    bl.addSubnet(network, prefix, type);
  }
  return bl;
}

/**
 * Every address this host answers on. os.networkInterfaces() alone is not
 * enough: libuv skips interfaces that aren't RUNNING (e.g. docker0 with no
 * containers), yet the kernel still accepts connections to their addresses.
 * On Linux, also read the kernel's own view: LOCAL routes in /proc/net/fib_trie
 * (IPv4) and /proc/net/if_inet6 (IPv6). Cached briefly — called per connect.
 */
let selfCache: { at: number; addrs: string[] } | null = null;

export function parseFibTrieLocal(text: string): string[] {
  const out = new Set<string>();
  let last: string | null = null;
  for (const line of text.split("\n")) {
    const m = /[|+]--\s+(\d+\.\d+\.\d+\.\d+)/.exec(line);
    if (m) { last = m[1]; continue; }
    if (last && /\/32 host LOCAL/.test(line)) out.add(last);
  }
  return [...out];
}

export function parseIfInet6(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const hex = line.trim().split(/\s+/)[0];
    if (!/^[0-9a-f]{32}$/i.test(hex)) continue;
    out.push(hex.match(/.{4}/g)!.join(":"));
  }
  return out;
}

function hostAddresses(): string[] {
  if (selfCache && Date.now() - selfCache.at < 10_000) return selfCache.addrs;
  const out = new Set<string>();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) out.add(a.address.split("%")[0]);
  }
  try { for (const a of parseFibTrieLocal(readFileSync("/proc/net/fib_trie", "utf8"))) out.add(a); } catch { /* non-Linux */ }
  try { for (const a of parseIfInet6(readFileSync("/proc/net/if_inet6", "utf8"))) out.add(a); } catch { /* non-Linux / no IPv6 */ }
  selfCache = { at: Date.now(), addrs: [...out] };
  return selfCache.addrs;
}

/** Build a policy. Throws on any invalid CIDR so a typo fails closed at startup. */
export function buildTargetPolicy(opts: {
  allowedCidrs?: string[];
  deniedCidrs?: string[];
  selfAddresses?: () => string[];
}): TargetPolicy {
  const deny = BUILTIN_DENY.map(([cidr, reason]) => ({ list: blockListOf([cidr]), reason }));
  const admDeny = (opts.deniedCidrs ?? []).filter(Boolean);
  if (admDeny.length) deny.push({ list: blockListOf(admDeny), reason: "in TERMINAL_DENIED_CIDRS" });
  const allowCidrs = (opts.allowedCidrs ?? []).filter(Boolean);
  return {
    deny,
    allow: allowCidrs.length ? blockListOf(allowCidrs) : null,
    allowCidrs,
    selfAddresses: opts.selfAddresses ?? hostAddresses,
  };
}

/** Map IPv4-mapped IPv6 (::ffff:10.0.0.1) to plain IPv4 so v4 rules apply. */
export function normalizeIp(ip: string): { ip: string; family: 4 | 6 } {
  const bare = ip.replace(/^\[|\]$/g, "").split("%")[0];
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare);
  if (m) return { ip: m[1], family: 4 };
  const fam = net.isIP(bare);
  if (!fam) throw new Error(`not an IP address: ${ip}`);
  return { ip: bare, family: fam as 4 | 6 };
}

/** Check one IP address against the policy. */
export function checkIp(policy: TargetPolicy, rawIp: string): TargetDecision {
  let n;
  try {
    n = normalizeIp(rawIp);
  } catch {
    return { ok: false, reason: "not a valid IP address" };
  }
  const type = n.family === 4 ? "ipv4" : "ipv6";
  for (const d of policy.deny) {
    if (d.list.check(n.ip, type)) return { ok: false, ip: n.ip, reason: d.reason };
  }
  // BlockList compares addresses canonically (fe80:0000:…:0001 == fe80::1).
  const self = new net.BlockList();
  for (const a of policy.selfAddresses()) {
    try {
      const s = normalizeIp(a);
      self.addAddress(s.ip, s.family === 4 ? "ipv4" : "ipv6");
    } catch { /* skip unparsable */ }
  }
  if (self.check(n.ip, type)) {
    return { ok: false, ip: n.ip, reason: "an address of this server" };
  }
  if (policy.allow && !policy.allow.check(n.ip, type)) {
    return { ok: false, ip: n.ip, reason: `not in TERMINAL_ALLOWED_CIDRS (${policy.allowCidrs.join(", ")})` };
  }
  return { ok: true, ip: n.ip, family: n.family };
}

export type Lookup = (host: string) => Promise<Array<{ address: string; family: number }>>;

const defaultLookup: Lookup = (host) => dns.lookup(host, { all: true, verbatim: true });

/**
 * Resolve `host` (name or IP literal) and check every address. Returns the
 * first address to connect to, or a denial. Denies if ANY address is denied —
 * a name must not be usable as a pointer to an internal address.
 */
export async function resolveTarget(
  policy: TargetPolicy,
  host: string,
  lookup: Lookup = defaultLookup
): Promise<TargetDecision> {
  const h = host.trim().replace(/^\[|\]$/g, "");
  if (!h) return { ok: false, reason: "empty host" };
  let addrs: string[];
  if (net.isIP(h.split("%")[0])) {
    addrs = [h];
  } else {
    try {
      addrs = (await lookup(h)).map((a) => a.address);
    } catch {
      return { ok: false, reason: `cannot resolve host "${h}"` };
    }
    if (addrs.length === 0) return { ok: false, reason: `cannot resolve host "${h}"` };
  }
  let first: TargetDecision | null = null;
  for (const a of addrs) {
    const d = checkIp(policy, a);
    if (!d.ok) return d;
    first ??= d;
  }
  return first!;
}
