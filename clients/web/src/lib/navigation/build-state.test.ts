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
const { useOrganizationStore } = await import("@/stores/organization-store");
const { useResolvedAssistantsStore } =
  await import("@/stores/resolved-assistants-store");

const initialAuthState = useAuthStore.getState();

beforeEach(() => {
  mockIsLocalMode = true;
  mockIsRemoteGatewayMode = false;
  useAuthStore.setState(initialAuthState, true);
  useOrganizationStore.setState({
    currentOrganizationId: null,
    persistedOrganizationId: null,
  });
  globalThis.sessionStorage?.clear();
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

describe("buildNavigationState — hasPlatformHostedAssistant", () => {
  // The post-checkout provisioning funnel asks a narrower question than
  // `hasAssistants`: does the ACTIVE ORG have an assistant a managed plan can
  // apply to? Local, Docker, and other-organization entries do not qualify.

  const ORG_A = "org-a";
  const ORG_B = "org-b";

  const local = { id: "local-1", isLocal: true, isPlatformHosted: false };
  const docker = { id: "docker-1", isLocal: false, isPlatformHosted: false };
  const managedInOrgA = {
    id: "managed-a",
    isLocal: false,
    isPlatformHosted: true,
    organizationId: ORG_A,
  };
  // API-sourced entries carry no org — the platform list is already org-scoped.
  const managedNoOrg = {
    id: "managed-api",
    isLocal: false,
    isPlatformHosted: true,
  };

  test("false with nothing resolved", () => {
    expect(buildNavigationState().hasPlatformHostedAssistant).toBe(false);
  });

  test("false when every entry is self-hosted", () => {
    useResolvedAssistantsStore.setState({ assistants: [local, docker] });

    const state = buildNavigationState();
    expect(state.hasAssistants).toBe(true);
    expect(state.hasPlatformHostedAssistant).toBe(false);
  });

  test("true for an org-scoped API entry that names no org", () => {
    useResolvedAssistantsStore.setState({ assistants: [managedNoOrg] });
    useOrganizationStore.setState({ currentOrganizationId: ORG_A });

    expect(buildNavigationState().hasPlatformHostedAssistant).toBe(true);
  });

  test("true for a lockfile entry owned by the active org", () => {
    useResolvedAssistantsStore.setState({ assistants: [local, managedInOrgA] });
    useOrganizationStore.setState({ currentOrganizationId: ORG_A });

    expect(buildNavigationState().hasPlatformHostedAssistant).toBe(true);
  });

  test("false when the only managed entry belongs to another org", () => {
    useResolvedAssistantsStore.setState({ assistants: [managedInOrgA] });
    useOrganizationStore.setState({ currentOrganizationId: ORG_B });

    const state = buildNavigationState();
    expect(state.hasAssistants).toBe(true);
    expect(state.hasPlatformHostedAssistant).toBe(false);
  });

  // The org resolves asynchronously. Narrowing against an unresolved org would
  // read an established user's own managed assistant as absent and funnel them
  // out of their billing page.
  test("does not narrow by org until the org resolves", () => {
    useResolvedAssistantsStore.setState({ assistants: [managedInOrgA] });

    expect(buildNavigationState().hasPlatformHostedAssistant).toBe(true);
  });

  test("falls back to the persisted org id when the store has not hydrated", () => {
    useResolvedAssistantsStore.setState({ assistants: [managedInOrgA] });
    globalThis.sessionStorage.setItem("vellum_active_organization_id", ORG_B);
    useOrganizationStore.setState({ persistedOrganizationId: ORG_B });

    expect(buildNavigationState().hasPlatformHostedAssistant).toBe(false);
  });
});
