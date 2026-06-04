/**
 * Client-side sanitizer overlay.
 *
 * The shared `sanitize()` is pure and takes an optional admin overlay (disabled
 * built-ins + custom rules). This module fetches that overlay once and exposes
 * a `sanitize()` wrapper bound to it, so the existing call sites don't have to
 * thread the overlay through props.
 *
 * The overlay is held in a module singleton. Until it loads — or if the fetch
 * fails — the wrapper passes `undefined`, which runs the FULL hardcoded
 * baseline. Sanitization is therefore never weaker than the baseline on the
 * client, and the server re-sanitizes with the authoritative overlay anyway.
 */

import {
  sanitize as baseSanitize,
  type SanitizeOptions,
  type SanitizeResult,
  type SanitizerOverlay,
} from "@deepconsol/shared/sanitizer";
import { api } from "./api";

let overlay: SanitizerOverlay | undefined;

/** Load (or refresh) the overlay from the API. Safe to call repeatedly. */
export async function loadSanitizerOverlay(): Promise<void> {
  try {
    overlay = await api.get<SanitizerOverlay>("/sanitizer/rules");
  } catch {
    // Keep whatever we had (possibly undefined → baseline). Never throw.
  }
}

export function sanitize(input: string, opts: SanitizeOptions = {}): SanitizeResult {
  return baseSanitize(input, opts, overlay);
}
