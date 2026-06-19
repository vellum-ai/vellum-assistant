import { useAuthStore } from "@/stores/auth-store";
import {
  isSessionSettled,
  isAuthenticated,
  hasAppAccess,
  hasLivePlatformSession,
  type PlatformSessionStatus,
} from "@/stores/session-status";
import { canReachAssistant } from "@/assistant/can-reach-assistant";
import { isGatewayAuthMode, getGatewayToken } from "@/lib/auth/gateway-session";
import { remoteGatewayPublicPathPrefix } from "@/lib/auth/remote-gateway-session";
import {
  isLocalMode,
  isPlatformDisabled,
  isRemoteGatewayMode,
  getSelectedAssistant,
} from "@/lib/local-mode";
import {
  readTosAccepted,
  readPrivacyConsent,
  readAnalyticsConsentCurrent,
  readDiagnosticsConsentCurrent,
} from "@/domains/onboarding/prefs";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import type { NavigationState } from "./navigation-resolver";

/**
 * Whether the selected assistant is reachable right now, composed imperatively
 * (no hooks) for the middleware/route-resolver context. The route guard runs
 * once per navigation rather than across renders, so it reads the non-reactive
 * gateway token and selection directly. Returns false when no assistant
 * resolves.
 */
function canReachSelectedAssistant(
  platformSession: PlatformSessionStatus,
): boolean {
  // getSelectedAssistant() already falls back to the active assistant when no
  // valid selection is stored, so it is the single resolver here.
  const selected = getSelectedAssistant();
  if (!selected) return false;
  // The gateway token is global; `canReachAssistant` requires it as a
  // per-assistant signal. A token minted for the active assistant must not make
  // a different selected local assistant report reachable, so gate it by active
  // id. Remote-gateway mode shares one gateway (active id "self"), so its
  // assistants always match.
  const { activeAssistantId } = useResolvedAssistantsStore.getState();
  const tokenBelongsToSelected =
    isRemoteGatewayMode() || activeAssistantId === selected.assistantId;
  return canReachAssistant(selected, {
    gatewayTokenPresent: tokenBelongsToSelected && getGatewayToken() !== null,
    platformSession,
  });
}

export function buildNavigationState(
  overrides?: Partial<NavigationState>,
): NavigationState {
  const { sessionStatus, platformSession } = useAuthStore.getState();
  const isRemoteGateway = isRemoteGatewayMode();
  // The route guard admits on app access — a real platform identity OR a
  // reachable selected assistant — not on bare platform identity. So a
  // local-only user (no platform session, gateway-reachable assistant) is
  // admitted, and a platform `getSession()` 401 that drops `platformSession`
  // cannot redirect them to login while their assistant is still reachable.
  const canAccessApp = hasAppAccess({
    hasPlatformIdentity: hasLivePlatformSession(platformSession),
    canReachSelected: canReachSelectedAssistant(platformSession),
  });
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
    // Route admission ORs in app access, but in-app auth consumers (the
    // QueryClient cache scope in providers.tsx, gated UI like PreferencesMenu)
    // read `useIsAuthenticated()` directly. These never disagree: a reachable
    // session is always `sessionStatus: "authenticated"` — the gateway is the
    // sole authority for a local session, and a platform user without a session
    // has `canReachSelected === false`, so `canAccessApp` implies authenticated.
    isAuthenticated: isAuthenticated(sessionStatus) || canAccessApp,
    platformSession,
    tosAccepted: readTosAccepted(),
    privacyConsent: readPrivacyConsent(),
    analyticsConsentCurrent: readAnalyticsConsentCurrent(),
    diagnosticsConsentCurrent: readDiagnosticsConsentCurrent(),
    ...overrides,
  };
}
