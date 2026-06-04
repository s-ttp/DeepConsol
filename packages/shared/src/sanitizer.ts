/**
 * DeepConsol sanitizer.
 *
 * Runs in BOTH browser and Node.js. Strips secrets, pseudonymizes telecom
 * identifiers (deterministic per-call so the same value gets the same alias
 * within a chunk), preserves technical signals.
 *
 * Defense in depth: client sanitizes BEFORE content enters chat; server
 * re-sanitizes BEFORE retrieval, prompt construction, Gemini call, web
 * grounding, and history storage. The two passes are intentional — the
 * server must NEVER trust the client.
 *
 * Rules are a HARDCODED SAFE BASELINE. Admins may layer an *overlay* on top
 * (see SanitizerOverlay): disable specific built-in rules and/or add guided
 * custom rules. The overlay is optional — when absent, the full baseline runs,
 * so a failure to load admin config can never silently drop sanitization.
 */

export interface SanitizeOptions {
  pseudonymize?: boolean;
  preservePartialIp?: boolean;
}

export interface SanitizeResult {
  sanitized: string;
  redactions: number;
  pseudonymizations: number;
  pseudonymMap: Record<string, string>;
}

export type RuleCategory = "strip" | "pseudonymize";

/** Metadata for a built-in rule, surfaced to the admin UI for toggling. */
export interface BuiltinRuleMeta {
  name: string;
  category: RuleCategory;
  description: string;
}

/**
 * A guided (non-regex) admin-defined rule. `value` is a literal string or a
 * simple wildcard pattern (`*` = any run of non-space chars, `?` = one char).
 * It is regex-escaped before compilation, so it CANNOT introduce ReDoS.
 */
export interface CustomRule {
  id: string;
  label: string;
  match_type: "literal" | "wildcard";
  value: string;
  action: "redact" | "pseudonymize";
  alias_prefix?: string | null;
  case_insensitive: boolean;
  enabled: boolean;
}

export interface SanitizerOverlay {
  /** Built-in rule names to skip. */
  disabledBuiltins?: string[];
  /** Admin-defined custom rules (already filtered to a tenant's set). */
  customRules?: CustomRule[];
}

interface StripRule {
  name: string;
  description: string;
  pattern: RegExp;
  replacement: string;
}

interface PseudoRule {
  name: string;
  description: string;
  prefix: string;
  pattern: RegExp;
}

const STRIP_RULES: StripRule[] = [
  { name: "ssh-private-key-block", description: "OpenSSH/PEM private key blocks", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: "[REDACTED:PRIVATE_KEY]" },
  { name: "pgp-private-key-block", description: "PGP private key blocks", pattern: /-----BEGIN PGP PRIVATE KEY BLOCK-----[\s\S]*?-----END PGP PRIVATE KEY BLOCK-----/g, replacement: "[REDACTED:PRIVATE_KEY]" },
  { name: "putty-private-key", description: "PuTTY .ppk private key files", pattern: /\bPuTTY-User-Key-File-\d+:[\s\S]*?Private-MAC:[^\r\n]+/g, replacement: "[REDACTED:PRIVATE_KEY]" },
  { name: "openssh-pubkey-with-comment", description: "ssh-rsa/ed25519/ecdsa/dss public keys", pattern: /\bssh-(?:rsa|ed25519|dss|ecdsa-[a-z0-9-]+)\s+[A-Za-z0-9+/=]+(?:\s+\S+)?/g, replacement: "[REDACTED:SSH_KEY]" },
  { name: "authorization-header", description: "HTTP Authorization headers", pattern: /\b[Aa]uthorization\s*:\s*[^\r\n]+/g, replacement: "Authorization: [REDACTED]" },
  { name: "cookie-header", description: "Cookie / Set-Cookie header values", pattern: /\b(Set-Cookie|Cookie)\s*:\s*[^\r\n]+/gi, replacement: "$1: [REDACTED]" },
  { name: "bearer-token", description: "Bearer tokens", pattern: /\b[Bb]earer\s+[A-Za-z0-9._\-+/=]{12,}/g, replacement: "Bearer [REDACTED]" },
  { name: "basic-auth", description: "Basic auth credentials", pattern: /\b[Bb]asic\s+[A-Za-z0-9+/=]{8,}/g, replacement: "Basic [REDACTED]" },
  { name: "jwt", description: "JSON Web Tokens (eyJ…header.payload.sig)", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replacement: "[REDACTED:JWT]" },
  { name: "connection-string-creds", description: "Credentials embedded in URIs (user:pass@host)", pattern: /\b([a-z][a-z0-9+.\-]*:\/\/)[^:@/\s]+:[^@/\s]+@/gi, replacement: "$1[REDACTED]@" },
  { name: "aws-access-key", description: "AWS access key IDs (AKIA/ASIA)", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replacement: "[REDACTED:AWS_ACCESS_KEY]" },
  { name: "google-api-key", description: "Google API keys (AIza…)", pattern: /\bAIza[0-9A-Za-z_\-]{35}\b/g, replacement: "[REDACTED:API_KEY]" },
  { name: "cloud-provider-token", description: "GitHub / Slack / Stripe / SendGrid / Google OAuth tokens", pattern: /\b(?:gh[opusr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|(?:sk|rk)_live_[A-Za-z0-9]{16,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|ya29\.[A-Za-z0-9_-]{20,})\b/g, replacement: "[REDACTED:TOKEN]" },
  { name: "generic-api-key-kv", description: "api_key / apikey / x-api-key = …", pattern: /\b(api[_-]?key|api[_-]?secret|apikey|x-api-key)\s*[:=]\s*['"]?[A-Za-z0-9._\-+/=]{12,}['"]?/gi, replacement: "$1: [REDACTED]" },
  { name: "generic-token-kv", description: "token / access_token / secret = …", pattern: /\b(token|access[_-]?token|refresh[_-]?token|auth[_-]?token|secret)\s*[:=]\s*['"]?[A-Za-z0-9._\-+/=]{12,}['"]?/gi, replacement: "$1: [REDACTED]" },
  { name: "password-kv", description: "password / passwd / pwd / enable_secret = …", pattern: /\b(password|passwd|pwd|pass|cred|credential|enable[_-]?secret)\s*[:=]\s*['"]?\S{1,}['"]?/gi, replacement: "$1: [REDACTED]" },
  { name: "cisco-type7-password", description: "Cisco IOS 'password 7'/'secret 5' hashes", pattern: /\b(password|secret)\s+([57])\s+[^\s]+/gi, replacement: "$1 $2 [REDACTED]" },
  { name: "cisco-enable-secret", description: "Cisco 'enable secret <hash>'", pattern: /\benable\s+secret\s+(?:\d\s+)?[^\s]+/gi, replacement: "enable secret [REDACTED]" },
  { name: "unix-password-hash", description: "Unix shadow / bcrypt password hashes ($1$/$5$/$6$/$2y$)", pattern: /\$(?:1|5|6|2[aby])\$[^\s:]{8,}/g, replacement: "[REDACTED:HASH]" },
  { name: "sim-auth-key", description: "SIM authentication keys (Ki / OPc / OP, 32 hex)", pattern: /\b(ki|opc?|auth[_-]?key)\s*[:=]\s*['"]?[0-9a-fA-F]{32}['"]?/gi, replacement: "$1: [REDACTED]" },
  { name: "snmp-community", description: "SNMP community strings", pattern: /\bsnmp[-_ ]server\s+community\s+\S+/gi, replacement: "snmp-server community [REDACTED]" },
  // Only match card-like numbers with separators (16-19 chars total). Raw
  // 13-16-digit runs would clobber IMSI/IMEI/MSISDN before pseudonymization.
  { name: "credit-card", description: "Credit-card numbers (with separators)", pattern: /\b(?:\d{4}[ -]){3}\d{3,4}\b/g, replacement: "[REDACTED:CARD]" },
  { name: "email", description: "Email addresses", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replacement: "[REDACTED:EMAIL]" },
  { name: "phone-e164", description: "E.164 phone numbers (+…)", pattern: /\+\d{7,15}\b/g, replacement: "[REDACTED:PHONE]" },
];

// Order matters: more-specific / labeled identifiers must run before the
// generic catch-alls so they win the match.
const PSEUDO_RULES: PseudoRule[] = [
  { name: "iccid", description: "SIM card serial numbers (ICCID, 89…)", prefix: "ICCID", pattern: /\b(?:iccid[:\s=]+)?(89\d{16,18})\b/gi },
  { name: "imei", description: "Device IMEI (labeled)", prefix: "IMEI", pattern: /\bimei[:\s=]+(\d{15})\b/gi },
  { name: "imsi", description: "Subscriber IMSI (14-15 digits)", prefix: "IMSI", pattern: /\b(?:imsi[:\s=]+)?(\d{14,15})\b/gi },
  { name: "msisdn", description: "Subscriber MSISDN", prefix: "MSISDN", pattern: /\b(?:msisdn[:\s=]+)?(\+?\d{10,15})\b/gi },
  { name: "subscriber-id", description: "5G/4G subscriber IDs (SUPI/SUCI/GUTI/TMSI)", prefix: "SUBID", pattern: /\b(?:supi|suci|5g-guti|guti|p-tmsi|m-tmsi|tmsi)[:\s=]+([0-9a-fA-F-]{4,})\b/gi },
  { name: "network-id", description: "Network identifiers (PLMN/TAC/LAC/RAC/eNB/gNB/APN)", prefix: "NETID", pattern: /\b(?:plmn|tac|lac|rac|enodeb|gnodeb|enb|gnb|apn)[:\s=]+([0-9a-zA-Z._-]{2,})\b/gi },
  { name: "ipv4", description: "Public IPv4 addresses", prefix: "IP", pattern: /\b((?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)){3})(?:\/\d{1,2})?\b/g },
  { name: "ipv6", description: "IPv6 addresses", prefix: "IP6", pattern: /\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b/g },
  { name: "mac", description: "MAC addresses", prefix: "MAC", pattern: /\b([0-9a-fA-F]{2}([:-])(?:[0-9a-fA-F]{2}\2){4}[0-9a-fA-F]{2})\b/g },
  { name: "cellid", description: "Cell identifiers (cell-id/cgi/eci/nci)", prefix: "CELL", pattern: /\b(?:cell[-_ ]?id|cgi|eci|nci)[:\s=]+([0-9a-fA-F]{4,16})\b/gi },
];

const HOSTNAME_RULE: BuiltinRuleMeta = {
  name: "hostname",
  category: "pseudonymize",
  description: "Public hostnames / FQDNs",
};

const PRIVATE_RANGES = [
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^127\./,
  /^169\.254\./,
  /^0\./,
  /^255\./,
];

const PSEUDONYMIZABLE_HOSTNAME = /\b((?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+(?:com|net|org|io|co|local|internal|corp|lan|private|gov|edu|info|telco|telecom))\b/g;

/** Public catalog of every built-in rule, for the admin toggle UI. */
export const BUILTIN_RULES: BuiltinRuleMeta[] = [
  ...STRIP_RULES.map((r) => ({ name: r.name, category: "strip" as const, description: r.description })),
  ...PSEUDO_RULES.map((r) => ({ name: r.name, category: "pseudonymize" as const, description: r.description })),
  HOSTNAME_RULE,
];

function isPrivateOrLoopbackIp(ip: string): boolean {
  return PRIVATE_RANGES.some((r) => r.test(ip));
}

function pseudonymForCounter(prefix: string, counter: number): string {
  return `${prefix}_${String(counter).padStart(3, "0")}`;
}

/** Normalize a label/prefix to an UPPER_SNAKE alias token. */
function aliasToken(raw: string | null | undefined, fallback: string): string {
  const t = (raw ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return t || fallback;
}

/**
 * Compile a guided custom rule into a global RegExp. The value is fully
 * regex-escaped first, so no user input reaches the regex engine as
 * metacharacters — wildcards are the ONLY special handling, and they expand to
 * bounded, single-quantifier constructs (no nesting → no catastrophic
 * backtracking).
 */
function compileCustom(rule: CustomRule): RegExp | null {
  const escaped = rule.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return null;
  let body = escaped;
  if (rule.match_type === "wildcard") {
    // The escape step turned `*` → `\*` and `?` → `\?`; expand those back to
    // bounded wildcards. `[^\s]*` is linear and cannot span tokens.
    body = body.replace(/\\\*/g, "[^\\s]*").replace(/\\\?/g, "[^\\s]");
  }
  const flags = `g${rule.case_insensitive ? "i" : ""}`;
  try {
    return new RegExp(body, flags);
  } catch {
    return null;
  }
}

export function sanitize(
  input: string,
  opts: SanitizeOptions = {},
  overlay?: SanitizerOverlay
): SanitizeResult {
  const { pseudonymize = true } = opts;
  const disabled = new Set(overlay?.disabledBuiltins ?? []);
  const custom = (overlay?.customRules ?? []).filter((r) => r.enabled);
  const customRedacts = custom.filter((r) => r.action === "redact");
  const customAliases = custom.filter((r) => r.action === "pseudonymize");

  let work = input;
  let redactions = 0;

  // 1) Custom redactions run first so admin intent (e.g. a customer name) wins
  //    over the generic built-ins.
  for (const rule of customRedacts) {
    const re = compileCustom(rule);
    if (!re) continue;
    const tag = `[REDACTED:${aliasToken(rule.label, "CUSTOM")}]`;
    const before = work;
    work = work.replace(re, tag);
    if (work !== before) redactions += (before.match(re) ?? []).length;
  }

  // 2) Built-in strip rules.
  for (const rule of STRIP_RULES) {
    if (disabled.has(rule.name)) continue;
    const before = work;
    work = work.replace(rule.pattern, rule.replacement);
    if (work !== before) {
      redactions += (before.match(rule.pattern) ?? []).length;
    }
  }

  const pseudonymMap: Record<string, string> = {};
  let pseudonymizations = 0;

  if (pseudonymize) {
    for (const rule of PSEUDO_RULES) {
      if (disabled.has(rule.name)) continue;
      const counters: Record<string, number> = {};
      work = work.replace(rule.pattern, (match, captured) => {
        const value = (captured ?? match).toString();
        if (rule.name === "ipv4" && isPrivateOrLoopbackIp(value)) {
          return match;
        }
        if (rule.name === "msisdn" && value.replace(/^\+/, "").length < 10) {
          return match;
        }
        if (pseudonymMap[`${rule.name}:${value}`]) {
          return match.replace(value, pseudonymMap[`${rule.name}:${value}`]);
        }
        counters[rule.name] = (counters[rule.name] ?? 0) + 1;
        const alias = pseudonymForCounter(rule.prefix, counters[rule.name]);
        pseudonymMap[`${rule.name}:${value}`] = alias;
        pseudonymizations += 1;
        return match.replace(value, alias);
      });
    }

    if (!disabled.has(HOSTNAME_RULE.name)) {
      let hostCounter = 0;
      work = work.replace(PSEUDONYMIZABLE_HOSTNAME, (match) => {
        const key = `host:${match.toLowerCase()}`;
        if (pseudonymMap[key]) return pseudonymMap[key];
        hostCounter += 1;
        const alias = pseudonymForCounter("HOST", hostCounter);
        pseudonymMap[key] = alias;
        pseudonymizations += 1;
        return alias;
      });
    }

    // 3) Custom pseudonymization rules — alias to a stable per-value token.
    for (const rule of customAliases) {
      const re = compileCustom(rule);
      if (!re) continue;
      const prefix = aliasToken(rule.alias_prefix ?? rule.label, "CUSTOM");
      let counter = 0;
      work = work.replace(re, (match) => {
        const key = `custom:${rule.id}:${match.toLowerCase()}`;
        if (pseudonymMap[key]) return pseudonymMap[key];
        counter += 1;
        const alias = pseudonymForCounter(prefix, counter);
        pseudonymMap[key] = alias;
        pseudonymizations += 1;
        return alias;
      });
    }
  }

  return {
    sanitized: work,
    redactions,
    pseudonymizations,
    pseudonymMap,
  };
}

/**
 * Quick check used to flag preview banners. Does not mutate input. Uses the
 * built-in baseline only (best-effort signal, not the authoritative pass).
 */
export function detectsSensitiveContent(input: string): boolean {
  for (const r of STRIP_RULES) {
    if (r.pattern.test(input)) {
      r.pattern.lastIndex = 0;
      return true;
    }
    r.pattern.lastIndex = 0;
  }
  return false;
}
