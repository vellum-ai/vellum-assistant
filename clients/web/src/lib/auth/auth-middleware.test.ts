import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createMemoryRouter } from "react-router";

import type { LockfileAssistant } from "@/lib/local-mode";

const isLocalClientMock = mock(() => true);
const hasAssistantsMock = mock(() => false);
let mockSelectedAssistant: LockfileAssistant | undefined;

// Spread the real module so the resolvers the route fork pulls in
// (`getSelectedAssistant`/`isLocalAssistant`/…) stay available; override only
// the hosting-mode flags and the selected-assistant resolver per case.
const localModeActual = await import("@/lib/local-mode");
mock.module("@/lib/local-mode", () => ({
  ...localModeActual,
  isLocalClient: isLocalClientMock,
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
let mockGatewayAuthMode = false;
const gatewaySessionActual = await import("@/lib/auth/gateway-session");
mock.module("@/lib/auth/gateway-session", () => ({
  ...gatewaySessionActual,
  getGatewayToken: () => (mockGatewayTokenPresent ? "gw-token" : null),
  isGatewayAuthMode: () => mockGatewayAuthMode,
}));

// Consent prefs are read by buildNavigationState; pinned current by default so
// the consent gate doesn't interfere with the session-admission assertions
// below. `consentPrefs` lets a case drive the boot defaults instead.
const consentPrefs = {
  tos: true,
  privacy: true,
  analytics: true,
  diagnostics: true,
};
const prefsActual = await import("@/domains/onboarding/prefs");
mock.module("@/domains/onboarding/prefs", () => ({
  ...prefsActual,
  readTosAccepted: () => consentPrefs.tos,
  readPrivacyConsent: () => consentPrefs.privacy,
  readAnalyticsConsentCurrent: () => consentPrefs.analytics,
  readDiagnosticsConsentCurrent: () => consentPrefs.diagnostics,
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

// The guard re-runs itself through the router when a timed-out probe reports
// late. Most cases stub the route tree so the assertion is on the re-run being
// armed, not on routing. `liveRouter` swaps in a real React Router instance so
// one case can assert what `revalidate()` actually does to the guard.
const revalidateMock = mock(() => {});
let liveRouter: { revalidate: () => Promise<void> } | null = null;
mock.module("@/routes", () => ({
  router: {
    revalidate: (): Promise<void> => {
      revalidateMock();
      return liveRouter?.revalidate() ?? Promise.resolve();
    },
  },
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

// The platform hardcodes the non-native Stripe `success_url` to this path, and
// the pricing funnel has a brand-new user pay before an assistant exists.
// Billing lives under `ActiveAssistantGate`, so admitting the return strands
// the (paying) user on "Connecting to your assistant…" forever.
const postCheckoutBilling = `${routes.settings.root}/billing?session_id=cs_test_123`;

// The funnel entry carries the managed-hatch marker so a local-mode client
// provisions on the platform rather than letting its own gateway answer for
// the assistant. Every client lands on the headless research onboarding, which
// runs the purchased-provisioning wait behind the form.
const managedFunnel = `${routes.onboarding.research}?hosting=vellum-cloud&post_checkout=1`;

/**
 * A checkout return on a local-mode client whose lockfile already holds a
 * self-hosted assistant. `hasAssistants()` is true, so the cold-boot probe wait
 * does not apply, yet the funnel decision still hangs on the probe.
 */
function makeSelfHostedLocalReturn(): void {
  isLocalClientMock.mockImplementation(() => true);
  hasAssistantsMock.mockImplementation(() => true);
  mockGatewayAuthMode = true;
  mockSelectedAssistant = localAssistant;
  useAuthStore.setState({
    sessionStatus: "authenticated",
    user: fakeUser,
    platformSession: "unknown",
  });
  useOnboardingStore.setState({ consentHydrated: true });
  useResolvedAssistantsStore.setState({
    assistants: [
      {
        id: localAssistant.assistantId,
        isLocal: true,
        isPlatformHosted: false,
      },
    ] as never[],
    assistantsHydrated: true,
  });
}

/** Poll until `predicate` holds, giving router-driven work room to settle. */
async function waitUntil(
  predicate: () => boolean,
  label: string,
): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

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
  isLocalClientMock.mockImplementation(() => true);
  hasAssistantsMock.mockImplementation(() => false);
  consentPrefs.tos = true;
  consentPrefs.privacy = true;
  consentPrefs.analytics = true;
  consentPrefs.diagnostics = true;
  mockSelectedAssistant = undefined;
  mockGatewayTokenPresent = false;
  mockGatewayAuthMode = false;
  revalidateMock.mockClear();
  liveRouter = null;
  useAuthStore.setState(initialAuthState, true);
  useResolvedAssistantsStore.setState({
    assistants: [],
    activeAssistantId: null,
  });
  useAssistantLifecycleStore.setState({
    assistantState: { kind: "error", message: "no assistant" },
  });
});

afterEach(async () => {
  // Settle the probe so a re-run armed by a timed-out wait fires and detaches
  // here instead of in the next test, then drain its lazy router import.
  useAuthStore.setState({ platformSession: "absent" });
  await tick();
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

  test("a probe that never settles routes to welcome instead of looping", async () => {
    useAuthStore.setState({
      sessionStatus: "authenticated",
      user: fakeUser,
      platformSession: "unknown",
    });

    // The probe stays "unknown" for the whole (clamped) wait, so the guard
    // decides on a settled-absent session rather than re-entering the wait.
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
    isLocalClientMock.mockImplementation(() => false);
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

describe("authMiddleware — post-checkout return with nothing provisioned", () => {
  function makePaidPlatformReturn(): void {
    isLocalClientMock.mockImplementation(() => false);
    useAuthStore.setState({
      sessionStatus: "authenticated",
      user: fakeUser,
      platformSession: "present",
    });
    useOnboardingStore.setState({ consentHydrated: true });
    useResolvedAssistantsStore.setState({
      assistants: [],
      assistantsHydrated: true,
    });
  }

  test("funnels the paid return into provisioning", async () => {
    makePaidPlatformReturn();

    const res = await runMiddleware(postCheckoutBilling);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(managedFunnel);
  });

  test("funnels it under a gateway session too, which otherwise bypasses the pipeline", async () => {
    makePaidPlatformReturn();
    isLocalClientMock.mockImplementation(() => true);
    mockGatewayAuthMode = true;

    const res = await runMiddleware(postCheckoutBilling);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(managedFunnel);
  });

  // A local assistant satisfies `hasAssistants`, so the gateway-auth bypass
  // admits the return — but a managed plan has no target in an org whose only
  // entries are self-hosted. Provision the managed assistant; the lockfile
  // entry is untouched.
  test("funnels a local-mode return whose only assistant is self-hosted", async () => {
    makePaidPlatformReturn();
    isLocalClientMock.mockImplementation(() => true);
    mockGatewayAuthMode = true;
    mockSelectedAssistant = localAssistant;
    useResolvedAssistantsStore.setState({
      assistants: [
        {
          id: localAssistant.assistantId,
          isLocal: true,
          isPlatformHosted: false,
          isPaired: false,
        },
      ],
      assistantsHydrated: true,
    });
    useAssistantLifecycleStore.setState({
      assistantState: { kind: "active", isLocal: true },
    });

    const res = await runMiddleware(postCheckoutBilling);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(managedFunnel);
  });

  // A local-mode client is "authenticated" on its gateway session alone. With
  // no platform session there is no account to provision into, so the return
  // stays on billing, whose login notice carries `session_id` through sign-in.
  test("admits a local-mode return with no platform session", async () => {
    makePaidPlatformReturn();
    isLocalClientMock.mockImplementation(() => true);
    mockGatewayAuthMode = true;
    mockSelectedAssistant = localAssistant;
    useAuthStore.setState({ platformSession: "absent" });
    useResolvedAssistantsStore.setState({
      assistants: [
        {
          id: localAssistant.assistantId,
          isLocal: true,
          isPlatformHosted: false,
          isPaired: false,
        },
      ],
      assistantsHydrated: true,
    });

    const outcome = await runMiddlewareOutcome(postCheckoutBilling);
    expect(outcome.admitted).toBe(true);
  });

  test("admits the return once a platform-hosted assistant exists", async () => {
    makePaidPlatformReturn();
    useResolvedAssistantsStore.setState({
      assistants: [
        { id: "a-1", isLocal: false, isPlatformHosted: true, isPaired: false },
      ],
    });
    useAssistantLifecycleStore.setState({
      assistantState: { kind: "active", isLocal: false },
    });

    const outcome = await runMiddlewareOutcome(postCheckoutBilling);
    expect(outcome.admitted).toBe(true);
  });
});

describe("authMiddleware — local-mode post-checkout platform probe", () => {
  test("holds the return until the probe settles, then funnels it", async () => {
    makeSelfHostedLocalReturn();

    let settled: Response | null = null;
    const pending = runMiddleware(postCheckoutBilling).then((res) => {
      settled = res;
    });

    // Probe still in flight: deciding now would strand the purchase on a
    // billing page with nothing to apply it to.
    await tick();
    expect(settled).toBeNull();

    useAuthStore.setState({ platformSession: "present" });
    await pending;

    expect(settled).not.toBeNull();
    expect(settled!.status).toBe(302);
    expect(settled!.headers.get("Location")).toBe(managedFunnel);
  });

  test("leaves the return on billing once the probe settles absent", async () => {
    makeSelfHostedLocalReturn();

    let decided = false;
    const pending = runMiddlewareOutcome(postCheckoutBilling).then((res) => {
      decided = true;
      return res;
    });

    await tick();
    expect(decided).toBe(false);

    useAuthStore.setState({ platformSession: "absent" });
    expect((await pending).admitted).toBe(true);
  });

  test("a probe that never settles degrades to a decision instead of looping", async () => {
    makeSelfHostedLocalReturn();

    // The probe stays "unknown", so the wait runs out its (clamped) timeout and
    // the guard decides on a settled-absent session: the return stays on
    // billing, whose login notice carries `session_id` through sign-in.
    const outcome = await runMiddlewareOutcome(postCheckoutBilling);
    expect(outcome.admitted).toBe(true);
  });

  test("a probe that succeeds after the timeout re-runs the guard", async () => {
    makeSelfHostedLocalReturn();

    // The probe outruns the (clamped) wait, so the guard decides on the forced
    // "absent" and admits the return to billing.
    const outcome = await runMiddlewareOutcome(postCheckoutBilling);
    expect(outcome.admitted).toBe(true);
    expect(revalidateMock).not.toHaveBeenCalled();

    // The probe lands "present" afterwards. Nothing else re-runs route
    // middleware on a store change, so without this the paid return is stranded
    // on billing with no managed assistant to apply the purchase to.
    useAuthStore.setState({ platformSession: "present" });
    await tick();
    expect(revalidateMock).toHaveBeenCalledTimes(1);

    // The re-run reads the settled session and funnels the return.
    const redirected = await runMiddleware(postCheckoutBilling);
    expect(redirected.status).toBe(302);
    expect(redirected.headers.get("Location")).toBe(managedFunnel);
  });

  test("the re-run is armed once and fires once", async () => {
    makeSelfHostedLocalReturn();

    await runMiddlewareOutcome(postCheckoutBilling);
    await runMiddlewareOutcome(postCheckoutBilling);

    useAuthStore.setState({ platformSession: "present" });
    await tick();
    expect(revalidateMock).toHaveBeenCalledTimes(1);

    // A settled probe never reopens "unknown", so no later change re-triggers
    // the re-run — the correction cannot loop.
    useAuthStore.setState({ platformSession: "absent" });
    await tick();
    expect(revalidateMock).toHaveBeenCalledTimes(1);
  });
});

describe("authMiddleware — late-probe re-run through a real router", () => {
  // The cases above stub `@/routes`, so they pin that a re-run is *armed* —
  // not that `router.revalidate()` re-runs middleware. The re-run is a React
  // Router behavior: a matched route carrying middleware defeats the no-op
  // revalidation short-circuit. The correction rests entirely on it, and it
  // degrades silently — the guard keeps its forced "absent" decision and the
  // paid return stays stranded on billing. These cases drive a real router so
  // that degradation fails loudly.
  //
  // `/assistant` carries the guard exactly as `routes.tsx` wires it. The funnel
  // target is a middleware-free sibling (same pattern as `/assistant/about`)
  // so the redirect settles there instead of re-entering the guard.
  function createGuardedRouter(): ReturnType<typeof createMemoryRouter> {
    return createMemoryRouter(
      [
        { path: routes.onboarding.research, Component: () => null },
        {
          path: "/assistant",
          middleware: [authMiddleware],
          children: [{ path: "settings/billing", Component: () => null }],
        },
        { path: "*", Component: () => null },
      ] as never,
      { initialEntries: ["/"], future: { v8_middleware: true } },
    );
  }

  function currentHref(router: ReturnType<typeof createMemoryRouter>): string {
    return router.state.location.pathname + router.state.location.search;
  }

  test("a probe that settles after the timeout re-decides the route", async () => {
    makeSelfHostedLocalReturn();
    const router = createGuardedRouter();
    liveRouter = router;

    try {
      // The probe outruns the (clamped) wait, so the guard decides on the
      // forced "absent" and the router lands on billing.
      await router.navigate(postCheckoutBilling);
      expect(currentHref(router)).toBe(postCheckoutBilling);
      expect(revalidateMock).not.toHaveBeenCalled();

      // The probe lands "present" afterwards. The guard has to re-run for the
      // return to reach provisioning — asserting the redirect, not the call,
      // is what pins that `revalidate()` still re-runs middleware.
      useAuthStore.setState({ platformSession: "present" });
      await waitUntil(
        () => currentHref(router) === managedFunnel,
        "the re-run guard to funnel the paid return",
      );
      expect(revalidateMock).toHaveBeenCalledTimes(1);
    } finally {
      liveRouter = null;
      router.dispose();
    }
  });

  test("the re-run fires once and does not re-decide on later transitions", async () => {
    makeSelfHostedLocalReturn();
    const router = createGuardedRouter();
    liveRouter = router;

    try {
      await router.navigate(postCheckoutBilling);
      useAuthStore.setState({ platformSession: "present" });
      await waitUntil(
        () => currentHref(router) === managedFunnel,
        "the re-run guard to funnel the paid return",
      );

      // A settled probe never reopens "unknown", so no later transition
      // re-arms the subscription — the correction cannot loop.
      useAuthStore.setState({ platformSession: "absent" });
      await tick();
      await tick();
      expect(revalidateMock).toHaveBeenCalledTimes(1);
      expect(currentHref(router)).toBe(managedFunnel);
    } finally {
      liveRouter = null;
      router.dispose();
    }
  });
});

describe("authMiddleware — hydration timeout", () => {
  test("a hung hydration degrades to a decision instead of re-entering the wait", async () => {
    isLocalClientMock.mockImplementation(() => false);
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

  // The research entry waits for consent to hydrate. Forcing the hydration flag
  // after the timeout leaves the consent flags at their boot `false`, so the
  // funnel's own gate would read a consented user as un-onboarded and evict
  // them into privacy — losing a paid return's markers, restarting a free
  // user's onboarding. It admits instead. The assistants list is hydrated here,
  // so the fail-open rests on the consent wait alone.
  test("admits a research funnel entry whose consent hydration hung", async () => {
    isLocalClientMock.mockImplementation(() => false);
    useAuthStore.setState({
      sessionStatus: "authenticated",
      user: fakeUser,
      platformSession: "present",
    });
    // The boot state a cold deep link sees: nothing read back from the server
    // yet, and the fetch that would never reports.
    consentPrefs.tos = false;
    consentPrefs.privacy = false;
    const priorConsentHydrated = useOnboardingStore.getState().consentHydrated;
    useOnboardingStore.setState({ consentHydrated: false });
    useResolvedAssistantsStore.setState({
      assistants: [],
      assistantsHydrated: true,
    });

    try {
      const outcome = await runMiddlewareOutcome(managedFunnel);
      expect(outcome.admitted).toBe(true);
    } finally {
      useOnboardingStore.setState({ consentHydrated: priorConsentHydrated });
    }
  });

  // Fail-open is scoped to the unhydrated read: consent that actually hydrated
  // on an unconsented user still bounces, carrying the funnel URL so the paid
  // markers survive the privacy screen.
  test("bounces the same entry once consent hydrates unconsented", async () => {
    isLocalClientMock.mockImplementation(() => false);
    useAuthStore.setState({
      sessionStatus: "authenticated",
      user: fakeUser,
      platformSession: "present",
    });
    consentPrefs.tos = false;
    consentPrefs.privacy = false;
    const priorConsentHydrated = useOnboardingStore.getState().consentHydrated;
    useOnboardingStore.setState({ consentHydrated: true });
    useResolvedAssistantsStore.setState({
      assistants: [],
      assistantsHydrated: true,
    });

    try {
      const res = await runMiddleware(managedFunnel);
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(
        `${routes.onboarding.privacy}?returnTo=${encodeURIComponent(managedFunnel)}`,
      );
    } finally {
      useOnboardingStore.setState({ consentHydrated: priorConsentHydrated });
    }
  });

  // The fail-open belongs to the consent wait alone. Consent that hydrates on
  // time reports a settled "not consented" whatever the assistants list is
  // doing, so a stalled list must not launder an unconsented user past the gate
  // and into a hatch they would be charged for.
  test("bounces an unconsented research entry when only the assistants list stalls", async () => {
    isLocalClientMock.mockImplementation(() => false);
    useAuthStore.setState({
      sessionStatus: "authenticated",
      user: fakeUser,
      platformSession: "present",
    });
    consentPrefs.tos = false;
    consentPrefs.privacy = false;
    const priorConsentHydrated = useOnboardingStore.getState().consentHydrated;
    const priorAssistantsHydrated =
      useResolvedAssistantsStore.getState().assistantsHydrated;
    useOnboardingStore.setState({ consentHydrated: false });
    useResolvedAssistantsStore.setState({
      assistants: [],
      assistantsHydrated: false,
    });

    try {
      const pending = runMiddleware(managedFunnel);
      // Consent lands well inside its (clamped) wait; the assistants fetch
      // never reports, so only that second wait runs out.
      setTimeout(() => {
        useOnboardingStore.setState({ consentHydrated: true });
      }, 10);

      const res = await pending;
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(
        `${routes.onboarding.privacy}?returnTo=${encodeURIComponent(managedFunnel)}`,
      );
    } finally {
      useOnboardingStore.setState({ consentHydrated: priorConsentHydrated });
      useResolvedAssistantsStore.setState({
        assistantsHydrated: priorAssistantsHydrated,
      });
    }
  });

  // The consent wait runs first, so a fetch that reports just after it — while
  // the assistants wait is still running — leaves a settled "not consented" by
  // the time the guard recurses. Carrying the expired stall forward would fail
  // the gate open on a hydration that has since landed.
  test("bounces an unconsented research entry when consent lands during the assistants wait", async () => {
    isLocalClientMock.mockImplementation(() => false);
    useAuthStore.setState({
      sessionStatus: "authenticated",
      user: fakeUser,
      platformSession: "present",
    });
    consentPrefs.tos = false;
    consentPrefs.privacy = false;
    const priorConsentHydrated = useOnboardingStore.getState().consentHydrated;
    const priorAssistantsHydrated =
      useResolvedAssistantsStore.getState().assistantsHydrated;
    useOnboardingStore.setState({ consentHydrated: false });
    useResolvedAssistantsStore.setState({
      assistants: [],
      assistantsHydrated: false,
    });

    try {
      const pending = runMiddleware(managedFunnel);
      // Past the (clamped) consent wait but inside the assistants one, which
      // never reports.
      setTimeout(() => {
        useOnboardingStore.setState({ consentHydrated: true });
      }, WAIT_TIMEOUT_CLAMP_MS + 30);

      const res = await pending;
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(
        `${routes.onboarding.privacy}?returnTo=${encodeURIComponent(managedFunnel)}`,
      );
    } finally {
      useOnboardingStore.setState({ consentHydrated: priorConsentHydrated });
      useResolvedAssistantsStore.setState({
        assistantsHydrated: priorAssistantsHydrated,
      });
    }
  });

  // Both fetches hang, so the consent wait times out on its own account and the
  // entry falls back to its unconditional admission.
  test("admits the research entry when both hydration waits stall", async () => {
    isLocalClientMock.mockImplementation(() => false);
    useAuthStore.setState({
      sessionStatus: "authenticated",
      user: fakeUser,
      platformSession: "present",
    });
    consentPrefs.tos = false;
    consentPrefs.privacy = false;
    const priorConsentHydrated = useOnboardingStore.getState().consentHydrated;
    const priorAssistantsHydrated =
      useResolvedAssistantsStore.getState().assistantsHydrated;
    useOnboardingStore.setState({ consentHydrated: false });
    useResolvedAssistantsStore.setState({
      assistants: [],
      assistantsHydrated: false,
    });

    try {
      const outcome = await runMiddlewareOutcome(managedFunnel);
      expect(outcome.admitted).toBe(true);
    } finally {
      useOnboardingStore.setState({ consentHydrated: priorConsentHydrated });
      useResolvedAssistantsStore.setState({
        assistantsHydrated: priorAssistantsHydrated,
      });
    }
  });
});
