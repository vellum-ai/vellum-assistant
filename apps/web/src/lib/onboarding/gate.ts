/**
 * Onboarding gate.
 *
 * Single decision point for "should we bounce this user into the onboarding
 * flow before letting them reach `/assistant`?". Kept deliberately pure +
 * synchronous so it can be called from React effects, route callbacks, and
 * unit tests alike. Reads the onboarding completion flag directly from
 * `localStorage` via `readOnboardingCompleted()` — no React, no hooks.
 *
 * Callers:
 *   - `/assistant` AssistantPageClient (auto-hatch branch for new signups)
 */
import { routes } from "@/utils/routes.js";

import { readOnboardingCompleted } from "@/lib/onboarding/prefs.js";

/**
 * Returns the path to redirect to when onboarding should intercept, or
 * `null` if the intended destination is fine as-is.
 *
 * Rules (short-circuit, top to bottom):
 *   1. If onboarding is already marked completed, let the user through.
 *   2. If the intended destination isn't the chat surface itself
 *      (`/assistant`), let them through — sibling paths
 *      `/assistant/settings/...`, `/assistant/onboarding/...`,
 *      `/admin/...` etc. shouldn't be gated.
 *   3. Otherwise, route them to `routes.onboarding.privacy`.
 */
export function resolveOnboardingRedirect({
  intendedDestination,
}: {
  intendedDestination: string;
}): string | null {
  if (readOnboardingCompleted()) return null;

  // `intendedDestination` may be a bare path or a raw `returnTo` value that
  // survived the callback as an absolute URL (`https://assistant.host/assistant`,
  // `//assistant.host/`). Parse out the pathname before matching so we
  // don't miss absolute URLs whose path is the assistant surface.
  const path = extractPathname(intendedDestination);
  if (path !== routes.assistant) return null;
  return routes.onboarding.privacy;
}

function extractPathname(destination: string): string {
  if (
    destination.startsWith("http://") ||
    destination.startsWith("https://") ||
    destination.startsWith("//")
  ) {
    try {
      // The base URL is only used when `destination` is protocol-relative; a
      // `//host/path` input will resolve against it. An opaque placeholder is
      // sufficient because we only consume the resulting `pathname`.
      return new URL(destination, "http://placeholder.invalid").pathname;
    } catch {
      // Malformed URL — fall through and treat the raw string as a path. The
      // exact-match check against `routes.assistant` will reject it, which
      // is the safe default (don't intercept ambiguous destinations).
      return destination;
    }
  }
  return destination;
}
