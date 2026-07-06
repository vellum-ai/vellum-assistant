import { routes } from "@/utils/routes";

/**
 * Decide where the standard onboarding flow goes after the user accepts
 * consent on the privacy screen.
 *
 * The research/personality flow is now THE onboarding — new web users are
 * dropped into it (`/assistant/onboarding/research`), which runs its own
 * background hatch and walks the user to chat. Local-mode users reach it a
 * different way (welcome → hosting → hatching → research; the hatching screen
 * redirects there), so this consent-time hop only covers the platform path.
 *
 * Native (iOS/Capacitor) keeps the standard hatching path: the research flow's
 * steps/hatch model aren't wired for the native shell yet.
 */
export function onboardingDestinationAfterConsent({
  isNative,
}: {
  isNative: boolean;
}): string {
  return isNative ? routes.onboarding.hatching : routes.onboarding.research;
}
