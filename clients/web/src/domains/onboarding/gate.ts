import { resolveNavigation } from "@/lib/navigation/navigation-resolver";
import { buildNavigationState } from "@/lib/navigation/build-state";
import { routes } from "@/utils/routes";
import { isLocalMode } from "@/lib/local-mode";

export function resolveOnboardingRedirect({
  intendedDestination,
}: {
  intendedDestination: string;
}): string | null {
  const decision = resolveNavigation(
    buildNavigationState(),
    { kind: "onboarding-intercept", intendedDestination },
  );
  return decision.action === "redirect" ? decision.to : null;
}

export function getOnboardingEntrypoint(): string {
  return isLocalMode() ? routes.welcome : routes.onboarding.privacy;
}
