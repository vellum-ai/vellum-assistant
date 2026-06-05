import { useAuthStore } from "@/stores/auth-store";
import { isSessionSettled, isAuthenticated } from "@/stores/session-status";
import { isGatewayAuthMode } from "@/lib/auth/gateway-session";
import { isLocalMode, hasAssistants } from "@/lib/local-mode";
import {
  readOnboardingCompleted,
  readTosAccepted,
  readAiDataConsent,
} from "@/domains/onboarding/prefs";
import type { NavigationState } from "./navigation-resolver";

export function buildNavigationState(
  overrides?: Partial<NavigationState>,
): NavigationState {
  const { sessionStatus, platformSession } = useAuthStore.getState();
  return {
    isLocalMode: isLocalMode(),
    isGatewayAuth: isGatewayAuthMode(),
    hasAssistants: hasAssistants(),
    sessionSettled: isSessionSettled(sessionStatus),
    isAuthenticated: isAuthenticated(sessionStatus),
    platformSession,
    onboardingCompleted: readOnboardingCompleted(),
    tosAccepted: readTosAccepted(),
    aiDataConsent: readAiDataConsent(),
    isReplay: false,
    ...overrides,
  };
}
