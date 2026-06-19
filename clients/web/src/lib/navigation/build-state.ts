import { useAuthStore } from "@/stores/auth-store";
import { isSessionSettled, isAuthenticated } from "@/stores/session-status";
import { isGatewayAuthMode } from "@/lib/auth/gateway-session";
import { remoteGatewayPublicPathPrefix } from "@/lib/auth/remote-gateway-session";
import { isLocalMode, isPlatformDisabled, isRemoteGatewayMode } from "@/lib/local-mode";
import {
  readTosAccepted,
  readPrivacyConsent,
  readAnalyticsConsentCurrent,
  readDiagnosticsConsentCurrent,
} from "@/domains/onboarding/prefs";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import type { NavigationState } from "./navigation-resolver";

export function buildNavigationState(
  overrides?: Partial<NavigationState>,
): NavigationState {
  const { sessionStatus, platformSession } = useAuthStore.getState();
  const isRemoteGateway = isRemoteGatewayMode();
  return {
    isLocalMode: isLocalMode(),
    isPlatformDisabled: isPlatformDisabled(),
    isRemoteGateway,
    remoteGatewayPublicPathPrefix: isRemoteGateway
      ? remoteGatewayPublicPathPrefix()
      : "",
    isGatewayAuth: isGatewayAuthMode(),
    hasAssistants: useResolvedAssistantsStore.getState().assistants.length > 0,
    sessionSettled: isSessionSettled(sessionStatus),
    isAuthenticated: isAuthenticated(sessionStatus),
    platformSession,
    tosAccepted: readTosAccepted(),
    privacyConsent: readPrivacyConsent(),
    analyticsConsentCurrent: readAnalyticsConsentCurrent(),
    diagnosticsConsentCurrent: readDiagnosticsConsentCurrent(),
    ...overrides,
  };
}
