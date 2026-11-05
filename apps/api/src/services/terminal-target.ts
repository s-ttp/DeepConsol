import { config } from "../config.js";
import { buildTargetPolicy, resolveTarget, type TargetDecision } from "./target-policy.js";

/**
 * The process-wide terminal target policy, built from .env at startup. An
 * invalid CIDR in TERMINAL_ALLOWED_CIDRS / TERMINAL_DENIED_CIDRS throws here,
 * so the API refuses to start rather than running with a policy it can't parse.
 */
export const terminalPolicy = buildTargetPolicy({
  allowedCidrs: config.terminalAllowedCidrs,
  deniedCidrs: config.terminalDeniedCidrs,
});

export function checkTerminalTarget(host: string): Promise<TargetDecision> {
  return resolveTarget(terminalPolicy, host);
}
