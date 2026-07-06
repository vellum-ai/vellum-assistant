import { routes } from "@/utils/routes";

/**
 * Decide where the standard onboarding flow goes after the user accepts
 * consent on the privacy screen.
 *
 * The research/personality flow is now THE onboarding, but HOW the assistant is
 * provisioned differs by hosting:
 *
 * - **Platform / Vellum-Cloud** → straight to `/assistant/onboarding/research`,
 *   which runs its own managed background hatch and walks the user to chat.
 * - **Local hosting** (`hosting=local`/`docker` in a local-mode build) → the
 *   `hatching` screen first, so the FOREGROUND local hatch (daemon spawn →
 *   gateway readyz → provider key) runs; the hatching screen then redirects into
 *   the research flow, which adopts that just-hatched assistant. Skipping
 *   hatching here would leave the research flow with no assistant to adopt.
 * - **Native** (iOS/Capacitor) → hatching, then chat: the research flow isn't
 *   wired for the native shell yet.
 */
export function onboardingDestinationAfterConsent({
  isNative,
  isLocalHatch,
}: {
  isNative: boolean;
  /** A local-hosting onboarding that must run the foreground local hatch. */
  isLocalHatch: boolean;
}): string {
  return isNative || isLocalHatch
    ? routes.onboarding.hatching
    : routes.onboarding.research;
}
