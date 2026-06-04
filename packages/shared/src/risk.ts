import type { RiskAssessment, RiskLevel } from "./types.js";

const CRITICAL_PATTERNS = [
  /\bwrite\s+erase\b/i,
  /\bformat\s+(?:flash|disk|drive|c:|\/)/i,
  /\bmkfs(\.\w+)?\b/i,
  /\bdd\s+if=/i,
  /\brm\s+-rf\s+\//i,
  /\b(?:halt|shutdown|poweroff)\b(?!\s+-c\b)/i,
  /\breload\s+(?:in|at)\b/i,
  /\bfactory[- ]?reset\b/i,
  /\bdrop\s+(?:database|schema|table)\b/i,
  /\btruncate\s+table\b/i,
];

const HIGH_PATTERNS = [
  /\bcommit\b/i,
  /\b(?:no\s+)?shutdown\b/i,
  /\bclear\s+(?:counters|interface|arp|mac|ip|line|log|config|crypto)\b/i,
  /\breset\b/i,
  /\bdelete\b/i,
  /\bremove\b/i,
  /\berase\b/i,
  /\bcopy\s+running-config\s+startup-config\b/i,
  /\breboot\b/i,
  /\brestart\b/i,
  /\bset\s+system\s+/i,
  /\bconfigure\b/i,
  /\bconf\s+t\b/i,
  /\bsudo\s+/i,
  /\bsystemctl\s+(?:stop|disable|mask)\b/i,
  /\bkill(?:all)?\s+-9\b/i,
  /\biptables\s+-[FXZ]/i,
];

const MEDIUM_PATTERNS = [
  /\bdebug\b/i,
  /\btest\s+/i,
  /\bmonitor\s+/i,
  /\bcapture\b/i,
  /\btcpdump\b/i,
  /\bping\s+-f\b/i,
  /\btraceroute\s+-r\b/i,
  /\bsnmpset\b/i,
];

const LOW_PATTERNS = [
  /^\s*show\b/im,
  /^\s*display\b/im,
  /^\s*get\b/im,
  /^\s*list\b/im,
  /\bping\s+/i,
  /\btraceroute\s+/i,
  /\bnslookup\b/i,
  /\bdig\s+/i,
  /\bnetstat\b/i,
  /\bss\s+-/i,
  /\bls\s+/i,
  /\bcat\s+/i,
  /\btail\b/i,
  /\bgrep\b/i,
];

interface PatternCheck {
  patterns: RegExp[];
  level: RiskLevel;
  reason: string;
  read_only: boolean;
  state_changing: boolean;
}

const CHECKS: PatternCheck[] = [
  { patterns: CRITICAL_PATTERNS, level: "critical", reason: "Destructive or service-disrupting operation detected.", read_only: false, state_changing: true },
  { patterns: HIGH_PATTERNS, level: "high", reason: "State-changing or configuration command detected.", read_only: false, state_changing: true },
  { patterns: MEDIUM_PATTERNS, level: "medium", reason: "Diagnostic or test command — may impact load or trigger debug logging.", read_only: false, state_changing: false },
  { patterns: LOW_PATTERNS, level: "low", reason: "Read-only or informational command.", read_only: true, state_changing: false },
];

export function classifyRisk(command: string): RiskAssessment {
  const matched: string[] = [];
  for (const check of CHECKS) {
    for (const p of check.patterns) {
      if (p.test(command)) {
        matched.push(p.source);
        return {
          level: check.level,
          reason: check.reason,
          matched,
          read_only: check.read_only,
          state_changing: check.state_changing,
        };
      }
    }
  }
  return {
    level: "medium",
    reason: "Could not classify; defaulting to medium pending manual review.",
    matched: [],
    read_only: false,
    state_changing: false,
  };
}

export function classifyBlock(block: string): RiskAssessment {
  const lines = block.split(/\r?\n/).filter((l) => l.trim().length > 0);
  let worst: RiskAssessment | null = null;
  const order: RiskLevel[] = ["low", "medium", "high", "critical"];
  for (const line of lines) {
    const r = classifyRisk(line);
    if (!worst || order.indexOf(r.level) > order.indexOf(worst.level)) {
      worst = r;
    }
  }
  return (
    worst ?? {
      level: "low",
      reason: "Empty block.",
      matched: [],
      read_only: true,
      state_changing: false,
    }
  );
}

export function requiresTypedConfirmation(level: RiskLevel): boolean {
  return level === "high" || level === "critical";
}
