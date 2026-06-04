import { resolveNavigation } from "@/lib/navigation/navigation-resolver";
import { buildNavigationState } from "@/lib/navigation/build-state";
import { routes } from "@/utils/routes";
import { isLocalMode, hasAssistants } from "@/lib/local-mode";
import {
  readOnboardingCompleted,
  clearOnboardingCompleted,
} from "@/domains/onboarding/prefs";

export function resolveOnboardingRedirect({
  intendedDestination,
}: {
  intendedDestination: string;
}): string | null {
  // Best-effort stale flag cleanup
  if (isLocalMode() && !hasAssistants() && readOnboardingCompleted()) {
    clearOnboardingCompleted();
  }

  const decision = resolveNavigation(
    buildNavigationState(),
    { kind: "onboarding-intercept", intendedDestination },
  );
  return decision.action === "redirect" ? decision.to : null;
}

export function getOnboardingEntrypoint(): string {
  return isLocalMode() ? routes.onboarding.welcome : routes.onboarding.privacy;
}
