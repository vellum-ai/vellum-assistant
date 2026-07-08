import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Spread the real `@/lib/local-mode` so every other export the dependency graph
// pulls in stays available; override only the hosting-mode flags build-state
// branches on.
let mockIsLocalMode = true;
let mockIsRemoteGatewayMode = false;

const localModeActual = await import("@/lib/local-mode");
mock.module("@/lib/local-mode", () => ({
  ...localModeActual,
  isLocalMode: () => mockIsLocalMode,
  isRemoteGatewayMode: () => mockIsRemoteGatewayMode,
}));

const gatewaySessionActual = await import("@/lib/auth/gateway-session");
mock.module("@/lib/auth/gateway-session", () => ({
  ...gatewaySessionActual,
  isGatewayAuthMode: () => false,
}));

// Consent prefs read storage; pin them so the access decision is isolated.
mock.module("@/domains/onboarding/prefs", () => ({
  readTosAccepted: () => true,
  readPrivacyConsent: () => true,
  readAnalyticsConsentCurrent: () => true,
  readDiagnosticsConsentCurrent: () => true,
  readConsentHydrated: () => true,
}));

const { buildNavigationState } = await import("./build-state");
const { useAuthStore } = await import("@/stores/auth-store");
const { useResolvedAssistantsStore } = await import(
  "@/stores/resolved-assistants-store"
);

const initialAuthState = useAuthStore.getState();

beforeEach(() => {
  mockIsLocalMode = true;
  mockIsRemoteGatewayMode = false;
  useAuthStore.setState(initialAuthState, true);
  useResolvedAssistantsStore.setState({
    assistants: [],
    activeAssistantId: null,
  });
});

afterEach(() => {
  useAuthStore.setState(initialAuthState, true);
});

describe("buildNavigationState — isAuthenticated mirrors sessionStatus", () => {
  // `isAuthenticated` is decided entirely by `sessionStatus`: the local gateway
  // is the sole session authority (#35152), so a reachable local user is already
  // `"authenticated"`. The "a platform 401 does not evict a local user" guarantee
  // is asserted at the store layer — see auth-store.test.ts, "refreshSession
  // keeps the local gateway session but clears stale platform state on a settled
  // 401".

  test("an authenticated session is admitted", () => {
    useAuthStore.setState({
      sessionStatus: "authenticated",
      platformSession: "present",
    });

    expect(buildNavigationState().isAuthenticated).toBe(true);
  });

  test("a local-only user (authenticated via the gateway, no platform session) is admitted", () => {
    // The realistic post-probe state for a local desktop user: the gateway
    // authenticated the session and the platform probe settled absent.
    useAuthStore.setState({
      sessionStatus: "authenticated",
      platformSession: "absent",
    });

    expect(buildNavigationState().isAuthenticated).toBe(true);
  });

  test("an unauthenticated session is not admitted", () => {
    useAuthStore.setState({
      sessionStatus: "unauthenticated",
      platformSession: "absent",
    });

    expect(buildNavigationState().isAuthenticated).toBe(false);
  });

  test("an initializing session is not yet admitted", () => {
    useAuthStore.setState({
      sessionStatus: "initializing",
      platformSession: "unknown",
    });

    expect(buildNavigationState().isAuthenticated).toBe(false);
  });

  test("platformSession is surfaced verbatim for the onboarding fork", () => {
    // The route fork's onboarding wait keys off platformSession === 'unknown';
    // surfacing isAuthenticated must not disturb that field.
    useAuthStore.setState({
      sessionStatus: "authenticated",
      platformSession: "unknown",
    });

    expect(buildNavigationState().platformSession).toBe("unknown");
  });
});
