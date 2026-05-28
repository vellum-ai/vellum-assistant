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
import { routes } from "@/utils/routes";

import { isLocalMode, hasAssistants } from "@/lib/local-mode";
import {
  readOnboardingCompleted,
  clearOnboardingCompleted,
} from "@/domains/onboarding/prefs";

/**
 * Returns the path to redirect to when onboarding should intercept, or
 * `null` if the intended destination is fine as-is.
 *
 * Rules (short-circuit, top to bottom):
 *   1. In local mode with hatched assistants, let the user through.
 *   2. In local mode with zero assistants, clear any stale completion flag
 *      (lockfile was lost/emptied since last onboarding).
 *   3. If onboarding is already marked completed, let the user through.
 *   4. If the intended destination isn't the chat surface itself
 *      (`/assistant`), let them through — sibling paths
 *      `/assistant/settings/...`, `/assistant/onboarding/...`,
 *      `/admin/...` etc. shouldn't be gated.
 *   5. Otherwise, route them to welcome (local mode) or privacy (platform).
 */
export function resolveOnboardingRedirect({
  intendedDestination,
}: {
  intendedDestination: string;
}): string | null {
  if (isLocalMode() && hasAssistants()) return null;
  if (isLocalMode() && !hasAssistants() && readOnboardingCompleted()) {
    clearOnboardingCompleted();
  }
  if (readOnboardingCompleted()) return null;

  // `intendedDestination` may be a bare path or a raw `returnTo` value that
  // survived the callback as an absolute URL (`https://assistant.host/assistant`,
  // `//assistant.host/`). Parse out the pathname before matching so we
  // don't miss absolute URLs whose path is the assistant surface.
  const path = extractPathname(intendedDestination);
  if (path !== routes.assistant) return null;
  return getOnboardingEntrypoint();
}

/**
 * The first screen a user should see when entering the onboarding flow.
 * Local mode starts at the welcome/hosting selector; platform starts at
 * privacy/consent.
 */
export function getOnboardingEntrypoint(): string {
  return isLocalMode() ? routes.onboarding.welcome : routes.onboarding.privacy;
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
