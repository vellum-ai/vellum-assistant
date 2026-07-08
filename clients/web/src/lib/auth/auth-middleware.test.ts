import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { LockfileAssistant } from "@/lib/local-mode";

const isLocalModeMock = mock(() => true);
const hasAssistantsMock = mock(() => false);
let mockSelectedAssistant: LockfileAssistant | undefined;

// Spread the real module so the resolvers the route fork pulls in
// (`getSelectedAssistant`/`isLocalAssistant`/…) stay available; override only
// the hosting-mode flags and the selected-assistant resolver per case.
const localModeActual = await import("@/lib/local-mode");
mock.module("@/lib/local-mode", () => ({
  ...localModeActual,
  isLocalMode: isLocalModeMock,
  hasAssistants: hasAssistantsMock,
  getLocalGatewayUrl: () => undefined,
  getSelectedAssistant: () => mockSelectedAssistant,
  getActiveAssistant: () => mockSelectedAssistant,
  isLocalAssistant: (a: {
    cloud?: string;
    resources?: { gatewayPort?: number };
  }) => a.cloud !== "vellum" && a.resources?.gatewayPort != null,
  isPlatformAssistant: (a: { cloud?: string }) => a.cloud === "vellum",
  isRemoteGatewayMode: () => false,
}));

// Drive the non-reactive gateway token off a flag.
let mockGatewayTokenPresent = false;
const gatewaySessionActual = await import("@/lib/auth/gateway-session");
mock.module("@/lib/auth/gateway-session", () => ({
  ...gatewaySessionActual,
  getGatewayToken: () => (mockGatewayTokenPresent ? "gw-token" : null),
  isGatewayAuthMode: () => false,
}));

// Consent prefs are read by buildNavigationState; pin them current so the
// consent gate doesn't interfere with the session-admission assertions below.
const prefsActual = await import("@/domains/onboarding/prefs");
mock.module("@/domains/onboarding/prefs", () => ({
  ...prefsActual,
  readTosAccepted: () => true,
  readPrivacyConsent: () => true,
  readAnalyticsConsentCurrent: () => true,
  readDiagnosticsConsentCurrent: () => true,
}));

// Clamp whenStoreState timeouts so hydration-timeout paths are testable
// without real 5s waits; untimed waits and predicate semantics are the real
// implementation's. Bind the real function BEFORE registering the mock —
// mock.module patches the imported namespace object in place, so a call-time
// `actual.whenStoreState` lookup would resolve to this wrapper and recurse.
const WAIT_TIMEOUT_CLAMP_MS = 100;
const whenStoreStateReal = (await import("@/utils/when-store-state"))
  .whenStoreState;
mock.module("@/utils/when-store-state", () => ({
  whenStoreState: ((store, predicate, options) =>
    whenStoreStateReal(store, predicate, {
      ...options,
      ...(options?.timeoutMs !== undefined
        ? { timeoutMs: Math.min(options.timeoutMs, WAIT_TIMEOUT_CLAMP_MS) }
        : {}),
    })) as typeof whenStoreStateReal,
}));

import { authMiddleware } from "./auth-middleware";
import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import { useOnboardingStore } from "@/domains/onboarding/onboarding-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useAuthStore, type AuthUser } from "@/stores/auth-store";
import { routes } from "@/utils/routes";

const initialAuthState = useAuthStore.getState();
const fakeUser = { id: "user-123" } as AuthUser;

const localAssistant: LockfileAssistant = {
  assistantId: "local-a",
  cloud: "local",
  resources: { gatewayPort: 51234, daemonPort: 51235 },
};

/**
 * Run the middleware and report whether it admitted (called `next`) or threw a
 * redirect Response — so admit-path assertions don't have to special-case the
 * thrown-Response contract.
 */
async function runMiddlewareOutcome(
  pathname: string,
): Promise<{ admitted: true } | { admitted: false; response: Response }> {
  const args = {
    request: new Request(`http://localhost${pathname}`),
    context: { set: () => {}, get: () => null },
  } as unknown as Parameters<typeof authMiddleware>[0];
  const next = (async () => new Response()) as Parameters<
    typeof authMiddleware
  >[1];
  try {
    await authMiddleware(args, next);
    return { admitted: true };
  } catch (thrown) {
    if (thrown instanceof Response) {
      return { admitted: false, response: thrown };
    }
    throw thrown;
  }
}

async function runMiddleware(pathname: string): Promise<Response> {
  const args = {
    request: new Request(`http://localhost${pathname}`),
    context: { set: () => {}, get: () => null },
  } as unknown as Parameters<typeof authMiddleware>[0];
  const next = (async () => new Response()) as Parameters<
    typeof authMiddleware
  >[1];
  // The middleware signals an unauthenticated/onboarding redirect by *throwing*
  // a Response, so surface that as the resolved value for assertions.
  try {
    await authMiddleware(args, next);
  } catch (thrown) {
    if (thrown instanceof Response) {
      return thrown;
    }
    throw thrown;
  }
  throw new Error("expected a redirect to be thrown");
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  isLocalModeMock.mockImplementation(() => true);
  hasAssistantsMock.mockImplementation(() => false);
  mockSelectedAssistant = undefined;
  mockGatewayTokenPresent = false;
  useAuthStore.setState(initialAuthState, true);
  useResolvedAssistantsStore.setState({ assistants: [], activeAssistantId: null });
  useAssistantLifecycleStore.setState({ assistantState: { kind: "error", message: "no assistant" } });
});

afterEach(() => {
  useAuthStore.setState(initialAuthState, true);
});

describe("authMiddleware — local-mode onboarding fork", () => {
  test("waits for the platform-session probe before choosing hosting vs welcome", async () => {
    useAuthStore.setState({
      sessionStatus: "authenticated",
      user: fakeUser,
      platformSession: "unknown",
    });

    let settled: Response | null = null;
    const pending = runMiddleware(routes.home).then((res) => {
      settled = res;
    });

    // Probe still in flight: the middleware must not have decided yet, so a
    // returning platform user isn't prematurely sent to the welcome flow.
    await tick();
    expect(settled).toBeNull();

    // Probe settles with a live platform session.
    useAuthStore.setState({ platformSession: "present" });
    await pending;

    expect(settled).not.toBeNull();
    expect(settled!.status).toBe(302);
    expect(settled!.headers.get("Location")).toBe(routes.onboarding.hosting);
  });

  test("routes to welcome once resolved with no platform session", async () => {
    useAuthStore.setState({
      sessionStatus: "authenticated",
      user: fakeUser,
      platformSession: "absent",
    });

    const res = await runMiddleware(routes.home);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(routes.welcome);
  });

  test("routes to hosting when a resolved platform session exists", async () => {
    useAuthStore.setState({
      sessionStatus: "authenticated",
      user: fakeUser,
      platformSession: "present",
    });

    const res = await runMiddleware(routes.home);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(routes.onboarding.hosting);
  });
});

describe("authMiddleware — app-access admit gate", () => {
  // A local user with at least one assistant resolved and a reachable gateway
  // connection, but no platform identity.
  function makeLocalUserReachable(): void {
    hasAssistantsMock.mockImplementation(() => true);
    mockSelectedAssistant = localAssistant;
    mockGatewayTokenPresent = true;
    useResolvedAssistantsStore.setState({
      assistants: [localAssistant] as never[],
      // The selected local assistant is the one the lifecycle activated, so its
      // gateway token counts as a per-assistant reachability signal.
      activeAssistantId: localAssistant.assistantId,
    });
  }

  test("admits a local-only user (no platform session) instead of redirecting to login", async () => {
    makeLocalUserReachable();
    // A local desktop user with no platform identity: the gateway is the sole
    // session authority (#35152), so the local session is 'authenticated' even
    // though the platform probe settled absent.
    useAuthStore.setState({
      sessionStatus: "authenticated",
      user: null,
      platformSession: "absent",
    });

    const outcome = await runMiddlewareOutcome(routes.home);
    expect(outcome.admitted).toBe(true);
  });

  test("a platform 401 mid-session does not redirect a local user", async () => {
    makeLocalUserReachable();
    // Start admitted as a local user.
    useAuthStore.setState({
      sessionStatus: "authenticated",
      user: null,
      platformSession: "present",
    });
    expect((await runMiddlewareOutcome(routes.home)).admitted).toBe(true);

    // Platform getSession() returns 401 mid-session: platformSession flips to
    // absent, but the local gateway keeps sessionStatus 'authenticated' (the
    // sole session authority, #35152 — asserted in auth-store.test.ts). So the
    // user is not evicted.
    useAuthStore.setState({
      platformSession: "absent",
    });

    const outcome = await runMiddlewareOutcome(routes.home);
    expect(outcome.admitted).toBe(true);
  });

  test("still redirects a logged-out platform user with no reachable assistant to login", async () => {
    isLocalModeMock.mockImplementation(() => false);
    hasAssistantsMock.mockImplementation(() => false);
    mockSelectedAssistant = undefined;
    mockGatewayTokenPresent = false;
    useAuthStore.setState({
      sessionStatus: "unauthenticated",
      user: null,
      platformSession: "absent",
    });

    const outcome = await runMiddlewareOutcome("/assistant/home");
    expect(outcome.admitted).toBe(false);
    if (!outcome.admitted) {
      expect(outcome.response.status).toBe(302);
      expect(outcome.response.headers.get("Location")).toBe(
        `${routes.account.login}?returnTo=${encodeURIComponent("/assistant/home")}`,
      );
    }
  });
});

describe("authMiddleware — hydration timeout", () => {
  test("a hung hydration degrades to a decision instead of re-entering the wait", async () => {
    isLocalModeMock.mockImplementation(() => false);
    useAuthStore.setState({
      sessionStatus: "authenticated",
      user: fakeUser,
      platformSession: "present",
    });
    // Simulate consent/assistants fetches that hang: neither store ever
    // reports hydration, so both waits run out their (clamped) timeouts.
    const priorConsentHydrated = useOnboardingStore.getState().consentHydrated;
    const priorAssistantsHydrated =
      useResolvedAssistantsStore.getState().assistantsHydrated;
    useOnboardingStore.setState({ consentHydrated: false });
    useResolvedAssistantsStore.setState({
      assistants: [],
      assistantsHydrated: false,
    });

    try {
      // Must settle (the consent prefs are pinned current above, so with the
      // hydration flags forced after the timeout, requireAssistant lands on
      // the consented no-assistant branch) — pre-guard this recursed into the
      // identical wait forever.
      const res = await runMiddleware(routes.home);
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(routes.onboarding.hatching);
    } finally {
      useOnboardingStore.setState({ consentHydrated: priorConsentHydrated });
      useResolvedAssistantsStore.setState({
        assistantsHydrated: priorAssistantsHydrated,
      });
    }
  });
});
