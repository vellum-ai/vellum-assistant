import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { LockfileAssistant } from "@/lib/local-mode";

// Spread the real `@/lib/local-mode` so every other export the dependency
// graph pulls in stays available; override only the hosting-mode flags and the
// selected-assistant resolver the route fork branches on.
let mockIsLocalMode = true;
let mockIsRemoteGatewayMode = false;
let mockSelectedAssistant: LockfileAssistant | undefined;

const localModeActual = await import("@/lib/local-mode");

mock.module("@/lib/local-mode", () => ({
  ...localModeActual,
  isLocalMode: () => mockIsLocalMode,
  isRemoteGatewayMode: () => mockIsRemoteGatewayMode,
  isLocalAssistant: (a: {
    cloud?: string;
    resources?: { gatewayPort?: number };
  }) => a.cloud !== "vellum" && a.resources?.gatewayPort != null,
  isPlatformAssistant: (a: { cloud?: string }) => a.cloud === "vellum",
  getSelectedAssistant: () => mockSelectedAssistant,
  getActiveAssistant: () => mockSelectedAssistant,
}));

// The gateway token is non-reactive module state; drive it off a flag.
let mockGatewayTokenPresent = false;
const gatewaySessionActual = await import("@/lib/auth/gateway-session");
mock.module("@/lib/auth/gateway-session", () => ({
  ...gatewaySessionActual,
  getGatewayToken: () => (mockGatewayTokenPresent ? "gw-token" : null),
  isGatewayAuthMode: () => false,
}));

// Consent prefs read storage; pin them so the access decision is isolated.
mock.module("@/domains/onboarding/prefs", () => ({
  readTosAccepted: () => true,
  readAiDataConsent: () => true,
  readAnalyticsConsentCurrent: () => true,
  readDiagnosticsConsentCurrent: () => true,
}));

const { buildNavigationState } = await import("./build-state");
const { useAuthStore } = await import("@/stores/auth-store");
const { useResolvedAssistantsStore } = await import(
  "@/stores/resolved-assistants-store"
);

const localAssistant: LockfileAssistant = {
  assistantId: "local-a",
  cloud: "local",
  resources: { gatewayPort: 51234, daemonPort: 51235 },
};
const platformAssistant: LockfileAssistant = {
  assistantId: "platform-a",
  cloud: "vellum",
};

const initialAuthState = useAuthStore.getState();

beforeEach(() => {
  mockIsLocalMode = true;
  mockIsRemoteGatewayMode = false;
  mockSelectedAssistant = undefined;
  mockGatewayTokenPresent = false;
  useAuthStore.setState(initialAuthState, true);
  useResolvedAssistantsStore.setState({ assistants: [] });
});

afterEach(() => {
  useAuthStore.setState(initialAuthState, true);
});

describe("buildNavigationState — app-access admit predicate", () => {
  test("a local-only user (no platform session, gateway-reachable assistant) is admitted", () => {
    // No platform identity at all: the probe settled absent and the session
    // status is not 'authenticated'.
    mockSelectedAssistant = localAssistant;
    mockGatewayTokenPresent = true;
    useAuthStore.setState({
      sessionStatus: "unauthenticated",
      platformSession: "absent",
    });

    expect(buildNavigationState().isAuthenticated).toBe(true);
  });

  test("a platform 401 mid-session does not evict a local user (session flips, token stays)", () => {
    // Simulate the platform getSession() 401: platformSession drops to absent
    // and sessionStatus flips to unauthenticated, but the gateway connection to
    // the selected local assistant is still live.
    mockSelectedAssistant = localAssistant;
    mockGatewayTokenPresent = true;
    useAuthStore.setState({
      sessionStatus: "unauthenticated",
      platformSession: "absent",
    });

    expect(buildNavigationState().isAuthenticated).toBe(true);
  });

  test("a logged-out user with no reachable assistant is not admitted", () => {
    // No platform identity, no gateway token, and no resolvable assistant.
    mockSelectedAssistant = undefined;
    mockGatewayTokenPresent = false;
    useAuthStore.setState({
      sessionStatus: "unauthenticated",
      platformSession: "absent",
    });

    expect(buildNavigationState().isAuthenticated).toBe(false);
  });

  test("a logged-out user whose only assistant is platform-hosted (no live session) is not admitted", () => {
    mockSelectedAssistant = platformAssistant;
    mockGatewayTokenPresent = true; // gateway token irrelevant for platform host
    useAuthStore.setState({
      sessionStatus: "unauthenticated",
      platformSession: "absent",
    });

    expect(buildNavigationState().isAuthenticated).toBe(false);
  });

  test("a local user without a gateway token yet is not admitted on reachability alone", () => {
    mockSelectedAssistant = localAssistant;
    mockGatewayTokenPresent = false;
    useAuthStore.setState({
      sessionStatus: "unauthenticated",
      platformSession: "absent",
    });

    expect(buildNavigationState().isAuthenticated).toBe(false);
  });

  test("a platform user with a live session is admitted exactly as today", () => {
    mockIsLocalMode = false;
    mockSelectedAssistant = platformAssistant;
    useAuthStore.setState({
      sessionStatus: "authenticated",
      platformSession: "present",
    });

    expect(buildNavigationState().isAuthenticated).toBe(true);
  });

  test("a platform user whose session has not settled keeps today's authenticated read", () => {
    // sessionStatus authenticated but probe unsettled: bare identity still
    // admits, so the OR must not regress this to a redirect.
    mockIsLocalMode = false;
    mockSelectedAssistant = platformAssistant;
    useAuthStore.setState({
      sessionStatus: "authenticated",
      platformSession: "unknown",
    });

    expect(buildNavigationState().isAuthenticated).toBe(true);
  });

  test("platformSession is still surfaced verbatim for the onboarding fork", () => {
    // The route fork's onboarding wait keys off platformSession === 'unknown';
    // folding app-access into isAuthenticated must not disturb that field.
    useAuthStore.setState({
      sessionStatus: "authenticated",
      platformSession: "unknown",
    });

    expect(buildNavigationState().platformSession).toBe("unknown");
  });
});
