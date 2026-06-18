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
import {
  isLocalMode,
  getSelectedAssistant,
  getActiveAssistant,
} from "@/lib/local-mode";
import {
  readTosAccepted,
  readAiDataConsent,
} from "@/domains/onboarding/prefs";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import type { NavigationState } from "./navigation-resolver";

/**
 * Whether the selected assistant is reachable right now, composed imperatively
 * (no hooks) for the middleware/route-resolver context. Mirrors the reactive
 * `useCanReachAssistant`, but reads the gateway token and the selected
 * assistant directly: the route guard runs once per navigation rather than
 * across renders, so it can read the non-reactive sources. Returns false when
 * no assistant resolves.
 */
function canReachSelectedAssistant(
  platformSession: PlatformSessionStatus,
): boolean {
  const selected = getSelectedAssistant() ?? getActiveAssistant();
  if (!selected) return false;
  return canReachAssistant(selected, {
    gatewayTokenPresent: getGatewayToken() !== null,
    platformSession,
  });
}

export function buildNavigationState(
  overrides?: Partial<NavigationState>,
): NavigationState {
  const { sessionStatus, platformSession } = useAuthStore.getState();
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
    isGatewayAuth: isGatewayAuthMode(),
    hasAssistants: useResolvedAssistantsStore.getState().assistants.length > 0,
    sessionSettled: isSessionSettled(sessionStatus),
    // Route admission ORs in app access, but in-app auth consumers (the
    // QueryClient cache scope in providers.tsx, gated UI like PreferencesMenu)
    // read `useIsAuthenticated()` directly. These never disagree: a reachable
    // session is always `sessionStatus: "authenticated"` — the gateway is the
    // sole authority for a local session, and a platform user without a session
    // has `canReachSelected === false`. So `canAccessApp` implies authenticated
    // today; the OR is a forward-looking guard. If local sessions ever stop
    // being authenticated (the `user: null` follow-up), those in-app consumers
    // must move onto app access too — otherwise an admitted user falls into the
    // anonymous cache scope with gated UI hidden.
    isAuthenticated: isAuthenticated(sessionStatus) || canAccessApp,
    platformSession,
    tosAccepted: readTosAccepted(),
    aiDataConsent: readAiDataConsent(),
    ...overrides,
  };
}
