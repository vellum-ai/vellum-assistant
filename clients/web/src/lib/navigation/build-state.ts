import { useAuthStore } from "@/stores/auth-store";
import { isSessionSettled, isAuthenticated } from "@/stores/session-status";
import { isGatewayAuthMode } from "@/lib/auth/gateway-session";
import { remoteGatewayPublicPathPrefix } from "@/lib/auth/remote-gateway-session";
import {
  isLocalMode,
  isPlatformDisabled,
  isRemoteGatewayMode,
} from "@/lib/local-mode";
import {
  readTosAccepted,
  readPrivacyConsent,
  readAnalyticsConsentCurrent,
  readDiagnosticsConsentCurrent,
  readConsentHydrated,
} from "@/domains/onboarding/prefs";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import type { NavigationState } from "./navigation-resolver";

export function buildNavigationState(
  overrides?: Partial<NavigationState>,
): NavigationState {
  const { sessionStatus, platformSession } = useAuthStore.getState();
  const { assistants, assistantsHydrated } =
    useResolvedAssistantsStore.getState();
  const isRemoteGateway = isRemoteGatewayMode();
  return {
    isLocalMode: isLocalMode(),
    isPlatformDisabled: isPlatformDisabled(),
    isRemoteGateway,
    remoteGatewayPublicPathPrefix: isRemoteGateway
      ? remoteGatewayPublicPathPrefix()
      : "",
    isGatewayAuth: isGatewayAuthMode(),
    hasAssistants: assistants.length > 0,
    sessionSettled: isSessionSettled(sessionStatus),
    // `isAuthenticated` mirrors `sessionStatus`. The local gateway is the sole
    // session authority (#35152), so a reachable local user is already
    // `"authenticated"` — a platform `getSession()` 401 drops only
    // `platformSession`, never `sessionStatus` (see `probePlatformSession`).
    // Reading the one source keeps this from drifting from `useIsAuthenticated()`.
    isAuthenticated: isAuthenticated(sessionStatus),
    platformSession,
    tosAccepted: readTosAccepted(),
    privacyConsent: readPrivacyConsent(),
    analyticsConsentCurrent: readAnalyticsConsentCurrent(),
    diagnosticsConsentCurrent: readDiagnosticsConsentCurrent(),
    consentHydrated: readConsentHydrated(),
    assistantsHydrated,
    ...overrides,
  };
}
