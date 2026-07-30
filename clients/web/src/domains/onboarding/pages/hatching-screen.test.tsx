/**
 * Behavioral tests for the post-payment provisioning wait behind the onboarding
 * hatching screen.
 *
 * A Pro user hatches a small warm-pool assistant; the screen fires the
 * idempotent ensure-provisioned reconcile once and holds completion until the
 * machine/storage resize to the purchased specs converges (then re-probes
 * healthz). Failures, free orgs, and the hard cap all fall through to completion
 * so the user is never trapped. Local hatches never enter this path.
 *
 * The screen keeps module-level hatch guards, so every test drives the flow to a
 * genuine completion (which releases them) to stay isolated. Self-contained
 * mocks — run this file solo (`mock.module` leaks across a shared `bun test`
 * run).
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";
import type { ReactNode } from "react";

const RESIZE_LABEL = "Setting up your machine…";

// --- Mutable per-test state, reset in beforeEach ------------------------------

const navigateMock = mock((_to: string, _opts?: unknown) => {});
let searchParams = new URLSearchParams();

let isLocalModeValue = false;

// The observed subscription plan gates the free/no-wait decision (Fix 2).
let subscriptionPlanId = "base";
// Whether the subscription read is uncertain: a throw, or a resolved response
// with no data (a 5xx under throwOnError:false). Either is "unknown", not "free".
let subscriptionThrows = false;
let subscriptionNoData = false;
// Whether a resize operation reads as still in flight (Fix 1).
let opStatusInFlight = false;
// Whether the operational-status read resolves with no data (a 5xx under
// throwOnError:false) — an uncertain read that must count as in-flight.
let opStatusNoData = false;
// Whether the no-id pre-flight getAssistant resolves an already-active
// assistant (the reload path, Fix 3).
let preflightActive = false;
// Whether the no-id pre-flight resolves the SELECTED LOCKFILE assistant, which
// is what `getAssistant()` answers with under gateway auth in a local-mode
// build: always `status: "active", is_local: true`.
let preflightGatewaySelectedLocal = false;

const GATEWAY_SELECTED_LOCAL_ID = "local-selected-1";

interface AssistantShape {
  id: string;
  status: string;
  machine_size: string | null;
  provisioned_storage_gib: number | null;
  is_local?: boolean;
}
let currentAssistant: AssistantShape;

// The active-detection poll is the first id-keyed getAssistant; later id-polls
// are the resize loop and may advance the fake clock so the cap-expiry path is
// exercised without a real 90s wait.
let idPollCount = 0;
let resizePollClockStepMs = 0;

// The subscription/targets loop runs before the resize loop, so a cap-expiry
// test that never reaches a confirmed-Pro read advances the clock here instead.
let subscriptionCallCount = 0;
let subscriptionPollClockStepMs = 0;

interface OnboardingShape {
  max_machine_tier: string | null;
  selected_storage_gib: number | null;
}
let onboardingData: OnboardingShape | null = null;
let onboardingThrows = false;

// --- Mocks --------------------------------------------------------------------

const getAssistantMock = mock(async (id?: string) => {
  if (!id) {
    if (preflightGatewaySelectedLocal) {
      return {
        ok: true as const,
        status: 200,
        data: {
          id: GATEWAY_SELECTED_LOCAL_ID,
          status: "active",
          is_local: true,
          machine_size: null,
          provisioned_storage_gib: null,
        },
      };
    }
    if (preflightActive) {
      // Reload onto an already-active assistant.
      return { ok: true as const, status: 200, data: { ...currentAssistant } };
    }
    // Pre-flight with no id: no assistant exists yet (auto_hatch).
    return { ok: false as const, status: 404, error: {} };
  }
  idPollCount += 1;
  if (idPollCount >= 2 && resizePollClockStepMs > 0) {
    setSystemTime(new Date(Date.now() + resizePollClockStepMs));
  }
  return { ok: true as const, status: 200, data: { ...currentAssistant } };
});

// Healthz is probed twice per paid hatch: once in the connecting phase, once
// after the provisioning wait. `healthzUnhealthyFromCall` makes every probe from
// that 1-based ordinal onward answer unhealthy, so the post-provisioning probe
// can be failed without also stalling the connecting phase.
let healthzCallCount = 0;
let healthzUnhealthyFromCall = Number.POSITIVE_INFINITY;
let healthzPollClockStepMs = 0;

const getAssistantHealthzMock = mock(async (_id: string) => {
  healthzCallCount += 1;
  if (healthzCallCount >= healthzUnhealthyFromCall) {
    if (healthzPollClockStepMs > 0) {
      setSystemTime(new Date(Date.now() + healthzPollClockStepMs));
    }
    return { ok: false as const, status: 503, data: {} };
  }
  return { ok: true as const, status: 200, data: {} };
});

const hatchAssistantMock = mock(async () => ({
  ok: true as const,
  status: 201,
  data: { id: "asst-1", status: "provisioning" },
}));

// How many leading reconcile calls resolve with NO data — a 503 "nothing
// queued" / network blip under throwOnError:false — before one succeeds. 0 =
// always succeed. Infinity = never succeeds.
let ensureProvisionedFailFirstN = 0;
// How many leading reconcile calls answer with a race body: a 200 that queues
// nothing because the platform cannot see the entitlement yet, or has no
// settled assistant to provision.
let ensureProvisionedRaceFirstN = 0;
let ensureProvisionedRaceReason = "no_active_pro";
let ensureProvisionedCallCount = 0;

const ensureProvisionedMock = mock(async () => {
  ensureProvisionedCallCount += 1;
  if (ensureProvisionedCallCount <= ensureProvisionedFailFirstN) {
    return { data: undefined };
  }
  if (ensureProvisionedCallCount <= ensureProvisionedRaceFirstN) {
    return {
      data: {
        state: "not_applicable",
        reason: ensureProvisionedRaceReason,
        targets: {},
      },
    };
  }
  return { data: { state: "started", reason: null, targets: {} } };
});

const onboardingRetrieveMock = mock(async () => {
  if (onboardingThrows) {
    throw new Error("onboarding fetch failed");
  }
  return { data: onboardingData };
});

const subscriptionRetrieveMock = mock(async () => {
  subscriptionCallCount += 1;
  if (subscriptionCallCount >= 2 && subscriptionPollClockStepMs > 0) {
    setSystemTime(new Date(Date.now() + subscriptionPollClockStepMs));
  }
  if (subscriptionThrows) {
    throw new Error("subscription fetch failed");
  }
  if (subscriptionNoData) {
    return { data: undefined };
  }
  return { data: { plan_id: subscriptionPlanId } };
});

const operationalStatusReadMock = mock(async () => {
  if (opStatusNoData) {
    return { data: undefined };
  }
  return {
    data: {
      state: opStatusInFlight ? "resizing_machine" : "active",
      active_operation: null,
    },
  };
});

const hatchLocalAssistantMock = mock(async () => ({
  ok: true as const,
  assistantId: "local-1",
}));

const saveLockfileAssistantMock = mock(
  async (_entry: {
    assistantId: string;
    cloud: string;
    name?: string;
    runtimeUrl?: string;
    hatchedAt?: string;
    organizationId?: string;
  }) => {},
);
const clearGatewayTokenMock = mock(() => {});
const setSelfHostedConnectionMock = mock((_connection: unknown) => {});

mock.module("react-router", () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () => [searchParams],
}));

mock.module("@/lib/sentry/capture-error", () => ({
  captureError: () => {},
}));

mock.module("@sentry/react", () => ({
  captureMessage: () => {},
}));

const stableQueryClient = {};
mock.module("@tanstack/react-query", () => ({
  useQueryClient: () => stableQueryClient,
}));

mock.module("@/assistant/api", () => ({
  getAssistant: getAssistantMock,
  getAssistantHealthz: getAssistantHealthzMock,
  hatchAssistant: hatchAssistantMock,
}));

mock.module("@/generated/api/sdk.gen", () => ({
  assistantsOperationalStatusDetailRead: operationalStatusReadMock,
  organizationsBillingSubscriptionOnboardingEnsureProvisionedCreate:
    ensureProvisionedMock,
  organizationsBillingSubscriptionOnboardingRetrieve: onboardingRetrieveMock,
  organizationsBillingSubscriptionRetrieve: subscriptionRetrieveMock,
}));

mock.module("@/assistant/seed-hatch-avatar", () => ({
  seedHatchAvatar: async () => {},
}));

mock.module("@/assistant/lifecycle", () => ({
  isPlatformHostedDisabled: () => false,
  PLATFORM_HOSTED_DISABLED_MESSAGE: "disabled",
  shouldRecoverFromHatchFailure: () => true,
  resolveAssistantLifecycleState: (result: {
    ok?: boolean;
    status?: number;
    data?: { status?: string; is_local?: boolean };
  }) => {
    if (result?.ok && result.data?.status === "active") {
      // Mirrors the real projection: an active assistant flagged `is_local`
      // is self-hosted, never the managed `active` the hatch is waiting for.
      return result.data.is_local
        ? { kind: "self_hosted" }
        : { kind: "active" };
    }
    if (!result?.ok && result.status === 404) {
      return { kind: "auto_hatch" };
    }
    return { kind: "provisioning" };
  },
}));

mock.module("@/assistant/lifecycle-service", () => ({
  lifecycleService: {
    checkAssistant: async () => {},
  },
}));

mock.module("@/domains/onboarding/components/onboarding-layout", () => ({
  OnboardingLayout: ({ children }: { children: ReactNode }) => children,
}));

mock.module("@/domains/onboarding/prefs", () => ({
  readSelectedVersion: () => "",
  writeSelectedVersion: () => {},
}));

mock.module("@/domains/onboarding/provider-key", () => ({
  applyPendingProviderKey: async () => {},
}));

mock.module("@/domains/onboarding/plugin-attribution", () => ({
  ATTRIBUTED_PLUGIN_PARAM: "attributed_plugin",
}));

mock.module("@/lib/local-mode", () => ({
  isLocalMode: () => isLocalModeValue,
  loadLockfile: async () => {},
  primeLocalGatewayConnection: async () => {},
  probeLocalGatewayReady: async () => true,
  // Stands in for the real helper (whose payload `local-mode.test.ts` pins) so
  // the lockfile entry the hatch writes stays visible to the assertions below.
  saveManagedLockfileAssistant: async (
    assistantId: string,
    name: string | undefined,
    organizationId: string | undefined,
  ): Promise<void> => {
    await saveLockfileAssistantMock({
      assistantId,
      name,
      cloud: "vellum",
      runtimeUrl: "https://runtime.example",
      hatchedAt: new Date().toISOString(),
      organizationId,
    });
  },
}));

mock.module("@/lib/auth/gateway-session", () => ({
  clearGatewayToken: clearGatewayTokenMock,
}));

mock.module("@/lib/self-hosted/connection", () => ({
  setSelfHostedConnection: setSelfHostedConnectionMock,
}));

mock.module("@/lib/navigation/navigation-resolver", () => ({
  POST_CHECKOUT_HATCH_PARAM: "post_checkout",
  resolveNavigation: () => ({ action: "proceed" }),
}));

mock.module("@/lib/navigation/build-state", () => ({
  buildNavigationState: () => ({}),
}));

mock.module("@/runtime/local-mode-host", () => ({
  hatchLocalAssistant: hatchLocalAssistantMock,
}));

mock.module("@/runtime/is-electron", () => ({
  isElectron: () => false,
}));

mock.module("@/assistant/selection", () => ({
  setSelectedAssistant: () => {},
}));

mock.module("@/stores/auth-store", () => ({
  useAuthStore: {
    use: {
      sessionStatus: () => "authenticated",
    },
    getState: () => ({
      connectLocalAssistant: async () => {},
    }),
  },
}));

mock.module("@/stores/organization-store", () => ({
  getActiveOrganizationIdForRequests: () => null,
}));

mock.module("@/stores/resolved-assistants-store", () => ({
  useResolvedAssistantsStore: {
    getState: () => ({ upsertFromApi: () => {} }),
  },
}));

mock.module("@/stores/session-status", () => ({
  isSessionSettled: () => true,
}));

mock.module("@/utils/api-errors", () => ({
  extractErrorMessage: (_error: unknown, _detail: unknown, fallback: string) =>
    fallback,
}));

mock.module("@/utils/avatar-bundled-components", () => ({
  BUNDLED_COMPONENTS: {},
}));

mock.module("@/utils/avatar-random", () => ({
  randomCharacterTraits: () => ({
    bodyShape: "a",
    eyeStyle: "b",
    color: "c",
  }),
}));

mock.module("@/utils/avatar-svg-compositor", () => ({
  composeSvg: () => "<svg></svg>",
}));

mock.module("@/utils/routes", () => ({
  routes: {
    onboarding: {
      research: "/onboarding/research",
      hosting: "/onboarding/hosting",
      privacy: "/onboarding/privacy",
    },
  },
}));

mock.module("@vellumai/design-library/components/button", () => ({
  Button: ({ children }: { children: ReactNode }) => (
    <button>{children}</button>
  ),
}));

mock.module("@vellumai/design-library/components/progress-bar", () => ({
  ProgressBar: () => <div data-testid="progress-bar" />,
}));

const { HatchingScreen } =
  await import("@/domains/onboarding/pages/hatching-screen");

// --- Suite --------------------------------------------------------------------

describe("HatchingScreen — post-payment provisioning wait", () => {
  beforeEach(() => {
    setSystemTime();
    navigateMock.mockClear();
    getAssistantMock.mockClear();
    getAssistantHealthzMock.mockClear();
    hatchAssistantMock.mockClear();
    ensureProvisionedMock.mockClear();
    onboardingRetrieveMock.mockClear();
    subscriptionRetrieveMock.mockClear();
    operationalStatusReadMock.mockClear();
    hatchLocalAssistantMock.mockClear();
    saveLockfileAssistantMock.mockClear();
    clearGatewayTokenMock.mockClear();
    setSelfHostedConnectionMock.mockClear();
    searchParams = new URLSearchParams();
    isLocalModeValue = false;
    subscriptionPlanId = "base";
    subscriptionThrows = false;
    subscriptionNoData = false;
    opStatusInFlight = false;
    opStatusNoData = false;
    preflightActive = false;
    preflightGatewaySelectedLocal = false;
    idPollCount = 0;
    resizePollClockStepMs = 0;
    subscriptionCallCount = 0;
    subscriptionPollClockStepMs = 0;
    ensureProvisionedFailFirstN = 0;
    ensureProvisionedRaceFirstN = 0;
    ensureProvisionedRaceReason = "no_active_pro";
    ensureProvisionedCallCount = 0;
    healthzCallCount = 0;
    healthzUnhealthyFromCall = Number.POSITIVE_INFINITY;
    healthzPollClockStepMs = 0;
    onboardingThrows = false;
    onboardingData = null;
    currentAssistant = {
      id: "asst-1",
      status: "active",
      machine_size: "small",
      provisioned_storage_gib: 10,
    };
  });

  afterEach(() => {
    cleanup();
    setSystemTime();
  });

  test("holds until actuals meet the purchased targets, then completes; reconcile fires once", async () => {
    subscriptionPlanId = "pro";
    onboardingData = { max_machine_tier: "xl", selected_storage_gib: 50 };

    render(<HatchingScreen />);

    // The resize wait is active — actuals (small/10) are below the purchased
    // ceiling (extra_large/50), so the screen holds without completing.
    await waitFor(() => expect(screen.getByText(RESIZE_LABEL)).toBeTruthy());
    expect(ensureProvisionedMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).not.toHaveBeenCalled();

    // The server-side resize lands: actuals now meet the targets.
    currentAssistant.machine_size = "extra_large";
    currentAssistant.provisioned_storage_gib = 50;

    await waitFor(() => expect(navigateMock).toHaveBeenCalled(), {
      timeout: 15000,
    });
    expect(ensureProvisionedMock).toHaveBeenCalledTimes(1);
  }, 20000);

  test("free org with null targets completes with no added wait", async () => {
    subscriptionPlanId = "base";
    onboardingData = { max_machine_tier: null, selected_storage_gib: null };

    render(<HatchingScreen />);

    await waitFor(() => expect(navigateMock).toHaveBeenCalled(), {
      timeout: 5000,
    });
    expect(navigateMock).toHaveBeenCalledWith("/onboarding/research", {
      replace: true,
    });
    // Not a Pro subscription: the resize phase is never entered.
    expect(screen.queryByText(RESIZE_LABEL)).toBeNull();
  });

  test("a base plan whose targets fetch fails still completes, never trapping", async () => {
    subscriptionPlanId = "base";
    onboardingThrows = true;

    render(<HatchingScreen />);

    await waitFor(() => expect(navigateMock).toHaveBeenCalled(), {
      timeout: 5000,
    });
    expect(screen.queryByText(RESIZE_LABEL)).toBeNull();
  });

  test("a non-pro subscription completes immediately even when targets are present", async () => {
    // The free/no-wait decision is gated on plan_id, not on the targets: a
    // base plan completes at baseline even though onboarding names a ceiling.
    subscriptionPlanId = "base";
    onboardingData = { max_machine_tier: "xl", selected_storage_gib: 50 };

    render(<HatchingScreen />);

    await waitFor(() => expect(navigateMock).toHaveBeenCalled(), {
      timeout: 5000,
    });
    expect(screen.queryByText(RESIZE_LABEL)).toBeNull();
  });

  test("targets met but the resize operation still in flight holds until it clears", async () => {
    subscriptionPlanId = "pro";
    onboardingData = { max_machine_tier: "xl", selected_storage_gib: 50 };
    // Actuals already sit at the purchased ceiling, but the resize operation
    // is still rolling out — completion must wait for the operation, not just
    // targets-met, so the screen holds.
    currentAssistant.machine_size = "extra_large";
    currentAssistant.provisioned_storage_gib = 50;
    opStatusInFlight = true;

    render(<HatchingScreen />);

    await waitFor(() => expect(screen.getByText(RESIZE_LABEL)).toBeTruthy());
    // The resize loop keeps polling operational status while it holds.
    await waitFor(
      () =>
        expect(
          operationalStatusReadMock.mock.calls.length,
        ).toBeGreaterThanOrEqual(2),
      { timeout: 15000 },
    );
    expect(navigateMock).not.toHaveBeenCalled();

    // The resize operation clears.
    opStatusInFlight = false;

    await waitFor(() => expect(navigateMock).toHaveBeenCalled(), {
      timeout: 15000,
    });
  }, 20000);

  test("plan pro with lagging targets keeps waiting (not free) until targets appear", async () => {
    subscriptionPlanId = "pro";
    // Targets aren't visible yet — the entitlement/targets race.
    onboardingData = null;
    // Actuals already meet the eventual ceiling so completion is prompt once
    // the targets land.
    currentAssistant.machine_size = "extra_large";
    currentAssistant.provisioned_storage_gib = 50;

    render(<HatchingScreen />);

    // The reconcile fires, and the subscription/targets poll keeps re-fetching
    // rather than concluding "free" and completing at baseline.
    await waitFor(() => expect(ensureProvisionedMock).toHaveBeenCalledTimes(1));
    await waitFor(
      () =>
        expect(onboardingRetrieveMock.mock.calls.length).toBeGreaterThanOrEqual(
          2,
        ),
      { timeout: 15000 },
    );
    expect(navigateMock).not.toHaveBeenCalled();

    // Targets become visible; the flow now holds for and clears the resize.
    onboardingData = { max_machine_tier: "xl", selected_storage_gib: 50 };

    await waitFor(() => expect(navigateMock).toHaveBeenCalled(), {
      timeout: 15000,
    });
  }, 20000);

  test("a preflight-active reload runs the provisioning wait before completing", async () => {
    // The baseline assistant is already active on reload; the preflight path
    // must still reconcile and hold for the purchased resize.
    preflightActive = true;
    subscriptionPlanId = "pro";
    onboardingData = { max_machine_tier: "xl", selected_storage_gib: 50 };
    currentAssistant.machine_size = "small";
    currentAssistant.provisioned_storage_gib = 10;

    render(<HatchingScreen />);

    await waitFor(() => expect(screen.getByText(RESIZE_LABEL)).toBeTruthy(), {
      timeout: 15000,
    });
    // The preflight short-circuits the hatch request but still provisions.
    expect(hatchAssistantMock).not.toHaveBeenCalled();
    expect(ensureProvisionedMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).not.toHaveBeenCalled();

    // The resize lands.
    currentAssistant.machine_size = "extra_large";
    currentAssistant.provisioned_storage_gib = 50;

    await waitFor(() => expect(navigateMock).toHaveBeenCalled(), {
      timeout: 15000,
    });
  }, 20000);

  test("the wait exceeding the hard cap completes anyway", async () => {
    subscriptionPlanId = "pro";
    onboardingData = { max_machine_tier: "xl", selected_storage_gib: 50 };
    // Actuals stay below the targets; the resize poll jumps the clock past the
    // RESIZE_WAIT_MAX_MS cap so completion falls through at baseline.
    resizePollClockStepMs = 91_000;

    render(<HatchingScreen />);

    await waitFor(() => expect(navigateMock).toHaveBeenCalled(), {
      timeout: 15000,
    });
    // Never met the targets — completion came from the cap, not convergence.
    expect(currentAssistant.machine_size).toBe("small");
    expect(ensureProvisionedMock).toHaveBeenCalledTimes(1);
  }, 20000);

  test("an unknown (no-data) subscription read during a paid hatch keeps waiting, never completing at baseline", async () => {
    // The subscription endpoint resolves with no data (a 5xx under
    // throwOnError:false) — an UNKNOWN result. Even with onboarding targets
    // present and actuals already at the ceiling, an unknown read must not be
    // mistaken for "free" and skip the purchased resize by completing early.
    subscriptionNoData = true;
    onboardingData = { max_machine_tier: "xl", selected_storage_gib: 50 };
    currentAssistant.machine_size = "extra_large";
    currentAssistant.provisioned_storage_gib = 50;

    render(<HatchingScreen />);

    // The reconcile fires and the subscription poll keeps retrying rather than
    // concluding "free" and navigating away.
    await waitFor(() => expect(ensureProvisionedMock).toHaveBeenCalledTimes(1));
    await waitFor(
      () =>
        expect(
          subscriptionRetrieveMock.mock.calls.length,
        ).toBeGreaterThanOrEqual(2),
      { timeout: 15000 },
    );
    expect(navigateMock).not.toHaveBeenCalled();

    // A definitive Pro read now lands; with targets met the resize completes.
    subscriptionNoData = false;
    subscriptionPlanId = "pro";

    await waitFor(() => expect(navigateMock).toHaveBeenCalled(), {
      timeout: 15000,
    });
  }, 20000);

  test("an erroring subscription endpoint still completes at the hard cap", async () => {
    // The subscription read persistently throws (always "unknown"). It never
    // completes early, but the RESIZE_WAIT_MAX_MS cap is the ultimate escape
    // so the user is not trapped.
    subscriptionThrows = true;
    onboardingData = { max_machine_tier: "xl", selected_storage_gib: 50 };
    // The subscription loop's poll jumps the clock past the cap so completion
    // falls through without a real 90s wait.
    subscriptionPollClockStepMs = 91_000;

    render(<HatchingScreen />);

    await waitFor(() => expect(navigateMock).toHaveBeenCalled(), {
      timeout: 15000,
    });
    // Never entered the resize phase: the cap fired before a confirmed Pro read.
    expect(screen.queryByText(RESIZE_LABEL)).toBeNull();
  }, 20000);

  test("a failed operational-status read counts as in-flight and holds until a healthy read arrives", async () => {
    subscriptionPlanId = "pro";
    onboardingData = { max_machine_tier: "xl", selected_storage_gib: 50 };
    // Actuals already sit at the purchased ceiling, but the operational-status
    // read returns no data (a 5xx under throwOnError:false). That uncertain
    // read must count as in-flight so the screen does not navigate onto a pod
    // that is still restarting.
    currentAssistant.machine_size = "extra_large";
    currentAssistant.provisioned_storage_gib = 50;
    opStatusNoData = true;

    render(<HatchingScreen />);

    await waitFor(() => expect(screen.getByText(RESIZE_LABEL)).toBeTruthy());
    // The resize loop keeps polling operational status while it holds.
    await waitFor(
      () =>
        expect(
          operationalStatusReadMock.mock.calls.length,
        ).toBeGreaterThanOrEqual(2),
      { timeout: 15000 },
    );
    expect(navigateMock).not.toHaveBeenCalled();

    // A healthy status read (data present, no resize in flight) finally lands.
    opStatusNoData = false;

    await waitFor(() => expect(navigateMock).toHaveBeenCalled(), {
      timeout: 15000,
    });
  }, 20000);

  test("a reconcile that fails on the first attempt re-fires on a later poll and provisioning proceeds", async () => {
    subscriptionPlanId = "pro";
    onboardingData = { max_machine_tier: "xl", selected_storage_gib: 50 };
    // The first reconcile fails (a 503 "nothing queued" resolves with no data
    // under throwOnError:false); a failed reconcile must not permanently
    // consume the fire-once guard, so a later poll re-fires it and it lands.
    ensureProvisionedFailFirstN = 1;
    // Actuals already sit at the ceiling so the resize completes promptly once
    // the reconcile lands.
    currentAssistant.machine_size = "extra_large";
    currentAssistant.provisioned_storage_gib = 50;

    render(<HatchingScreen />);

    // The reconcile is re-fired after the first failure (called more than once).
    await waitFor(
      () =>
        expect(ensureProvisionedMock.mock.calls.length).toBeGreaterThanOrEqual(
          2,
        ),
      { timeout: 15000 },
    );
    // Provisioning still converges and the screen completes.
    await waitFor(() => expect(navigateMock).toHaveBeenCalled(), {
      timeout: 15000,
    });
  }, 20000);

  test("a persistently-failing reconcile still completes at the hard cap", async () => {
    subscriptionPlanId = "pro";
    onboardingData = { max_machine_tier: "xl", selected_storage_gib: 50 };
    // The reconcile never succeeds (always resolves with no data), so it
    // re-fires on every poll — but the RESIZE_WAIT_MAX_MS cap is the ultimate
    // escape so the user is never trapped.
    ensureProvisionedFailFirstN = Number.POSITIVE_INFINITY;
    // Actuals stay below the ceiling; the resize poll jumps the clock past the
    // cap so completion falls through at baseline.
    resizePollClockStepMs = 91_000;

    render(<HatchingScreen />);

    await waitFor(() => expect(navigateMock).toHaveBeenCalled(), {
      timeout: 15000,
    });
    // Re-fired more than once before the cap released it.
    expect(ensureProvisionedMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Completion came from the cap, not convergence.
    expect(currentAssistant.machine_size).toBe("small");
  }, 20000);

  test("the resize deadline expiring while still in flight still health-probes before completing", async () => {
    subscriptionPlanId = "pro";
    onboardingData = { max_machine_tier: "xl", selected_storage_gib: 50 };
    // The resize never converges: the operation reads as perpetually in
    // flight, so the loop can exit only via the RESIZE_WAIT_MAX_MS cap. Even
    // on that deadline-expiry path a healthz probe must run before completion
    // so the user is never routed onto a pod mid-restart.
    currentAssistant.machine_size = "extra_large";
    currentAssistant.provisioned_storage_gib = 50;
    opStatusInFlight = true;
    // The resize poll jumps the clock past the cap so the deadline fires
    // without a real 90s wait.
    resizePollClockStepMs = 91_000;

    render(<HatchingScreen />);

    await waitFor(() => expect(navigateMock).toHaveBeenCalled(), {
      timeout: 15000,
    });
    // The connecting phase probes healthz once; the post-resize probe on the
    // deadline path is the second — proving completion went through a health
    // check even when the cap fired.
    expect(getAssistantHealthzMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  }, 20000);

  test("the entitlement deadline expiring health-probes before completing", async () => {
    // The subscription read never resolves an answer, so the entitlement wait
    // can exit only on its deadline. The reconcile has been nudged on every
    // iteration by then, so a resize may already have restarted the pod —
    // completion must still go through a health check.
    subscriptionThrows = true;
    onboardingData = { max_machine_tier: "xl", selected_storage_gib: 50 };
    subscriptionPollClockStepMs = 91_000;

    render(<HatchingScreen />);

    await waitFor(() => expect(navigateMock).toHaveBeenCalled(), {
      timeout: 15000,
    });
    // The resize phase was never entered — the deadline fired before a
    // confirmed Pro read — yet healthz was probed a second time.
    expect(screen.queryByText(RESIZE_LABEL)).toBeNull();
    expect(getAssistantHealthzMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  }, 20000);

  test("a post-resize daemon that never recovers fails the hatch instead of completing", async () => {
    // The resize converges but the restarted daemon never answers healthz.
    // Exhausting MAX_HATCH_WAIT_MS on that probe is a failed hatch: completing
    // would navigate the user onto an unreachable assistant.
    subscriptionPlanId = "pro";
    onboardingData = { max_machine_tier: "xl", selected_storage_gib: 50 };
    currentAssistant.machine_size = "extra_large";
    currentAssistant.provisioned_storage_gib = 50;
    // The connecting-phase probe (call 1) passes; every post-resize probe
    // fails and jumps the clock past MAX_HATCH_WAIT_MS.
    healthzUnhealthyFromCall = 2;
    healthzPollClockStepMs = 301_000;

    render(<HatchingScreen />);

    await waitFor(
      () =>
        expect(
          screen.getByText(
            "Your assistant is taking longer than expected. Please try again.",
          ),
        ).toBeTruthy(),
      { timeout: 15000 },
    );
    expect(navigateMock).not.toHaveBeenCalled();
  }, 20000);

  test("a free hatch never runs the post-resize health probe", async () => {
    // The free path returns before the resize and health phases, so the only
    // healthz probe is the connecting one — unchanged by the failure plumbing.
    subscriptionPlanId = "base";
    onboardingData = { max_machine_tier: "xl", selected_storage_gib: 50 };

    render(<HatchingScreen />);

    await waitFor(() => expect(navigateMock).toHaveBeenCalled(), {
      timeout: 5000,
    });
    expect(getAssistantHealthzMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(RESIZE_LABEL)).toBeNull();
  });

  test("local hatches never provision", async () => {
    isLocalModeValue = true;
    searchParams = new URLSearchParams("hosting=docker");

    render(<HatchingScreen />);

    await waitFor(() => expect(navigateMock).toHaveBeenCalled(), {
      timeout: 5000,
    });
    expect(ensureProvisionedMock).not.toHaveBeenCalled();
    expect(onboardingRetrieveMock).not.toHaveBeenCalled();
    expect(subscriptionRetrieveMock).not.toHaveBeenCalled();
    expect(operationalStatusReadMock).not.toHaveBeenCalled();
  });

  test("a local-mode preflight-active reload completes without provisioning", async () => {
    // A local-mode session with no hosting param makes useLocalHatch false, so
    // a reload onto an already-active assistant flows through the platform
    // preflight path into finishActiveHatch. Without the managed marker the
    // provisioning wait short-circuits — no billing reads, no resize wait.
    isLocalModeValue = true;
    preflightActive = true;

    render(<HatchingScreen />);

    await waitFor(() => expect(navigateMock).toHaveBeenCalled(), {
      timeout: 5000,
    });
    expect(ensureProvisionedMock).not.toHaveBeenCalled();
    expect(subscriptionRetrieveMock).not.toHaveBeenCalled();
    expect(onboardingRetrieveMock).not.toHaveBeenCalled();
    expect(operationalStatusReadMock).not.toHaveBeenCalled();
  });

  // -- managed hatch in a local-mode build --------------------------------
  //
  // The post-checkout funnel sends a local-mode client here with
  // `hosting=vellum-cloud`: the plan was bought for a managed assistant the
  // org does not have yet, so the assistant is provisioned on the platform and
  // the purchased machine and storage must land before the screen completes.

  test("a managed hatch in local mode waits for the purchased provisioning", async () => {
    isLocalModeValue = true;
    searchParams = new URLSearchParams("hosting=vellum-cloud");
    subscriptionPlanId = "pro";
    onboardingData = { max_machine_tier: "xl", selected_storage_gib: 50 };

    render(<HatchingScreen />);

    // The purchased ceiling is read and held for, exactly as in platform mode.
    await waitFor(() => expect(screen.getByText(RESIZE_LABEL)).toBeTruthy());
    expect(ensureProvisionedMock).toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();

    currentAssistant.machine_size = "extra_large";
    currentAssistant.provisioned_storage_gib = 50;

    await waitFor(() => expect(navigateMock).toHaveBeenCalled(), {
      timeout: 15000,
    });
  }, 20000);

  test("a managed hatch never adopts or reclassifies the gateway-selected local assistant", async () => {
    // Under gateway auth `getAssistant()` answers from the selected lockfile
    // entry. That entry is self-hosted, so it is never mistaken for the
    // managed assistant being hatched: the hatch still runs, and the only
    // lockfile write names the managed id.
    isLocalModeValue = true;
    searchParams = new URLSearchParams("hosting=vellum-cloud");
    preflightGatewaySelectedLocal = true;
    subscriptionPlanId = "base";

    render(<HatchingScreen />);

    await waitFor(() => expect(navigateMock).toHaveBeenCalled(), {
      timeout: 5000,
    });

    expect(hatchAssistantMock).toHaveBeenCalled();
    const savedIds = saveLockfileAssistantMock.mock.calls.map(
      ([entry]) => entry.assistantId,
    );
    expect(savedIds).not.toContain(GATEWAY_SELECTED_LOCAL_ID);
    expect(savedIds).toEqual(["asst-1"]);
    // The local gateway is dropped up front so the hatch, its polls and its
    // healthz probes address the platform.
    expect(clearGatewayTokenMock).toHaveBeenCalled();
    expect(setSelfHostedConnectionMock).toHaveBeenCalledWith(null);
  });

  test("a local hatch keeps its gateway session", async () => {
    isLocalModeValue = true;
    searchParams = new URLSearchParams("hosting=docker");

    render(<HatchingScreen />);

    await waitFor(() => expect(navigateMock).toHaveBeenCalled(), {
      timeout: 5000,
    });
    // The local hatch's own handoff re-primes the connection; the managed
    // teardown must not have run ahead of it.
    expect(setSelfHostedConnectionMock).not.toHaveBeenCalled();
  });

  // -- post-checkout return -----------------------------------------------
  //
  // Stripe redirects the moment payment succeeds, which can beat the subscribe
  // webhook that flips the org to Pro. On the return leg of a completed
  // checkout — marked by `post_checkout=1`, set only by the funnel — a
  // still-base plan read means the webhook is lagging, not that the org is
  // free. `hosting=vellum-cloud` alone never carries that meaning: it is a
  // hosting choice a free user can make.

  const POST_CHECKOUT_PARAMS = "hosting=vellum-cloud&post_checkout=1";

  test("a post-checkout return whose plan still reads base waits, then applies the purchased targets", async () => {
    searchParams = new URLSearchParams(POST_CHECKOUT_PARAMS);
    // The webhook has not landed: the org still reports its pre-checkout plan
    // with no targets, and the assistant sits at the warm-pool baseline.
    subscriptionPlanId = "base";
    onboardingData = null;

    render(<HatchingScreen />);

    // The subscription is re-read rather than accepted as a free entitlement.
    await waitFor(
      () =>
        expect(
          subscriptionRetrieveMock.mock.calls.length,
        ).toBeGreaterThanOrEqual(2),
      { timeout: 15000 },
    );
    expect(navigateMock).not.toHaveBeenCalled();

    // The webhook lands, carrying the purchased ceiling.
    subscriptionPlanId = "pro";
    onboardingData = { max_machine_tier: "xl", selected_storage_gib: 50 };

    await waitFor(() => expect(screen.getByText(RESIZE_LABEL)).toBeTruthy(), {
      timeout: 15000,
    });
    expect(navigateMock).not.toHaveBeenCalled();

    // The resize lands and the screen completes at the purchased size.
    currentAssistant.machine_size = "extra_large";
    currentAssistant.provisioned_storage_gib = 50;

    await waitFor(() => expect(navigateMock).toHaveBeenCalled(), {
      timeout: 15000,
    });
  }, 30000);

  test("a post-checkout return whose plan never flips still completes at the hard cap", async () => {
    searchParams = new URLSearchParams(POST_CHECKOUT_PARAMS);
    subscriptionPlanId = "base";
    onboardingData = null;
    // The subscription loop's poll jumps the clock past RESIZE_WAIT_MAX_MS so
    // the cap fires without a real 90s wait.
    subscriptionPollClockStepMs = 91_000;

    render(<HatchingScreen />);

    await waitFor(() => expect(navigateMock).toHaveBeenCalled(), {
      timeout: 15000,
    });
    // The cap released it at baseline: the resize phase was never entered.
    expect(screen.queryByText(RESIZE_LABEL)).toBeNull();
  }, 20000);

  test("a hatch with no post-checkout marker completes on the first non-pro read", async () => {
    // The free path is untouched — one subscription read, no resize phase, no
    // added poll — even with a stale onboarding ceiling on record.
    subscriptionPlanId = "base";
    onboardingData = { max_machine_tier: "xl", selected_storage_gib: 50 };

    render(<HatchingScreen />);

    await waitFor(() => expect(navigateMock).toHaveBeenCalled(), {
      timeout: 5000,
    });
    expect(subscriptionRetrieveMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(RESIZE_LABEL)).toBeNull();
  });

  test("a managed hatch without the post-checkout marker completes on the first non-pro read", async () => {
    // Picking Vellum Cloud is not a purchase: a free managed hatch must never
    // be parked on the post-checkout wait.
    isLocalModeValue = true;
    searchParams = new URLSearchParams("hosting=vellum-cloud");
    subscriptionPlanId = "base";
    onboardingData = { max_machine_tier: "xl", selected_storage_gib: 50 };

    render(<HatchingScreen />);

    await waitFor(() => expect(navigateMock).toHaveBeenCalled(), {
      timeout: 5000,
    });
    expect(subscriptionRetrieveMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(RESIZE_LABEL)).toBeNull();
  });

  test("a no_active_pro reconcile is re-fired on a later poll instead of consuming the fire-once guard", async () => {
    // The entitlement race answers with a 200 body but queues nothing.
    // Consuming the guard on it would spend the nudge for the whole hatch, so
    // the purchased resize would land only if the webhook's own resize did.
    subscriptionPlanId = "pro";
    onboardingData = null;
    ensureProvisionedRaceFirstN = 1;
    // Actuals already sit at the eventual ceiling so completion is prompt
    // once the targets land.
    currentAssistant.machine_size = "extra_large";
    currentAssistant.provisioned_storage_gib = 50;

    render(<HatchingScreen />);

    await waitFor(
      () =>
        expect(ensureProvisionedMock.mock.calls.length).toBeGreaterThanOrEqual(
          2,
        ),
      { timeout: 15000 },
    );

    // The entitlement becomes visible and provisioning converges.
    onboardingData = { max_machine_tier: "xl", selected_storage_gib: 50 };

    await waitFor(() => expect(navigateMock).toHaveBeenCalled(), {
      timeout: 15000,
    });
  }, 20000);

  test("a no_provisionable_assistants reconcile is re-fired instead of consuming the fire-once guard", async () => {
    // The reason a hatch hits most: the org holds the entitlement but its
    // assistant hasn't settled yet, so the reconcile queues nothing. Spending
    // the guard here would lose the nudge for the whole hatch — exactly the
    // window where the assistant is about to become provisionable.
    subscriptionPlanId = "pro";
    onboardingData = null;
    ensureProvisionedRaceFirstN = 1;
    ensureProvisionedRaceReason = "no_provisionable_assistants";
    currentAssistant.machine_size = "extra_large";
    currentAssistant.provisioned_storage_gib = 50;

    render(<HatchingScreen />);

    await waitFor(
      () =>
        expect(ensureProvisionedMock.mock.calls.length).toBeGreaterThanOrEqual(
          2,
        ),
      { timeout: 15000 },
    );

    // The assistant settles and provisioning converges.
    onboardingData = { max_machine_tier: "xl", selected_storage_gib: 50 };

    await waitFor(() => expect(navigateMock).toHaveBeenCalled(), {
      timeout: 15000,
    });
  }, 20000);
});
