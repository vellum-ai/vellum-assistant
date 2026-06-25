import { routes } from "@/utils/routes";

/**
 * Decide where the standard onboarding flow goes after the user accepts
 * consent on the privacy screen.
 *
 * When the research-onboarding flag is enabled AND we're on the web platform,
 * new users are dropped into the research flow (`/assistant/onboarding/research`),
 * which runs its own background hatch and walks the user to chat — so the
 * hatching screen is intentionally skipped. The redirect is web-only: native /
 * Electron-wrapped users always keep the standard hatching path. Otherwise we
 * keep the standard hatching path too.
 *
 * Local-mode onboarding (carrying `?hosting=local`/`docker`) also keeps the
 * standard hatching path: the research route only supports the managed hatch
 * (`useBackgroundHatch()` → managed `hatchAssistant()`) and never consumes the
 * `hosting` param, so routing a local/docker user there would bypass the local
 * provider-key/local hatch flow and provision the wrong assistant.
 *
 * Because the `research-onboarding` flag defaults to `false`, a `true` value
 * here already implies the LaunchDarkly response has landed, so no separate
 * hydration check is needed at the call site.
 */
export function onboardingDestinationAfterConsent({
  researchOnboardingEnabled,
  isNative,
  isLocalMode,
}: {
  researchOnboardingEnabled: boolean;
  isNative: boolean;
  isLocalMode: boolean;
}): string {
  return researchOnboardingEnabled && !isNative && !isLocalMode
    ? routes.onboarding.research
    : routes.onboarding.hatching;
}
