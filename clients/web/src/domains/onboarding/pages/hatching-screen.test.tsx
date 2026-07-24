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

interface AssistantShape {
  id: string;
  status: string;
  machine_size: string | null;
  provisioned_storage_gib: number | null;
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

const getAssistantHealthzMock = mock(async (_id: string) => ({
  ok: true as const,
  status: 200,
  data: {},
}));

const hatchAssistantMock = mock(async () => ({
  ok: true as const,
  status: 201,
  data: { id: "asst-1", status: "provisioning" },
}));

const ensureProvisionedMock = mock(async () => ({
  data: { state: "started", reason: null, targets: {} },
}));

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
    data?: { status?: string };
  }) => {
    if (result?.ok && result.data?.status === "active") {
      return { kind: "active" };
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
    markExpectingFirstMessage: () => {},
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
  getPlatformRuntimeUrl: () => "https://runtime.example",
  loadLockfile: async () => {},
  primeLocalGatewayConnection: async () => {},
  probeLocalGatewayReady: async () => true,
  saveLockfileAssistant: async () => {},
}));

mock.module("@/lib/auth/gateway-session", () => ({
  clearGatewayToken: () => {},
}));

mock.module("@/lib/navigation/navigation-resolver", () => ({
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

mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => false,
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
  useOrganizationStore: {
    getState: () => ({ currentOrganizationId: null }),
  },
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
    assistant: "/assistant",
    onboarding: {
      research: "/onboarding/research",
      hosting: "/onboarding/hosting",
      privacy: "/onboarding/privacy",
    },
  },
}));

mock.module("@vellumai/design-library/components/button", () => ({
  Button: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));

mock.module("@vellumai/design-library/components/progress-bar", () => ({
  ProgressBar: () => <div data-testid="progress-bar" />,
}));

const { HatchingScreen } = await import(
  "@/domains/onboarding/pages/hatching-screen"
);

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
    searchParams = new URLSearchParams();
    isLocalModeValue = false;
    subscriptionPlanId = "base";
    subscriptionThrows = false;
    subscriptionNoData = false;
    opStatusInFlight = false;
    opStatusNoData = false;
    preflightActive = false;
    idPollCount = 0;
    resizePollClockStepMs = 0;
    subscriptionCallCount = 0;
    subscriptionPollClockStepMs = 0;
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

  test(
    "holds until actuals meet the purchased targets, then completes; reconcile fires once",
    async () => {
      subscriptionPlanId = "pro";
      onboardingData = { max_machine_tier: "xl", selected_storage_gib: 50 };

      render(<HatchingScreen />);

      // The resize wait is active — actuals (small/10) are below the purchased
      // ceiling (extra_large/50), so the screen holds without completing.
      await waitFor(() =>
        expect(screen.getByText(RESIZE_LABEL)).toBeTruthy(),
      );
      expect(ensureProvisionedMock).toHaveBeenCalledTimes(1);
      expect(navigateMock).not.toHaveBeenCalled();

      // The server-side resize lands: actuals now meet the targets.
      currentAssistant.machine_size = "extra_large";
      currentAssistant.provisioned_storage_gib = 50;

      await waitFor(() => expect(navigateMock).toHaveBeenCalled(), {
        timeout: 15000,
      });
      expect(ensureProvisionedMock).toHaveBeenCalledTimes(1);
    },
    20000,
  );

  test("free org with null targets completes with no added wait", async () => {
    subscriptionPlanId = "base";
    onboardingData = { max_machine_tier: null, selected_storage_gib: null };

    render(<HatchingScreen />);

    await waitFor(() => expect(navigateMock).toHaveBeenCalled(), {
      timeout: 5000,
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

  test(
    "a non-pro subscription completes immediately even when targets are present",
    async () => {
      // The free/no-wait decision is gated on plan_id, not on the targets: a
      // base plan completes at baseline even though onboarding names a ceiling.
      subscriptionPlanId = "base";
      onboardingData = { max_machine_tier: "xl", selected_storage_gib: 50 };

      render(<HatchingScreen />);

      await waitFor(() => expect(navigateMock).toHaveBeenCalled(), {
        timeout: 5000,
      });
      expect(screen.queryByText(RESIZE_LABEL)).toBeNull();
    },
  );

  test(
    "targets met but the resize operation still in flight holds until it clears",
    async () => {
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
    },
    20000,
  );

  test(
    "plan pro with lagging targets keeps waiting (not free) until targets appear",
    async () => {
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
      await waitFor(() =>
        expect(ensureProvisionedMock).toHaveBeenCalledTimes(1),
      );
      await waitFor(
        () =>
          expect(
            onboardingRetrieveMock.mock.calls.length,
          ).toBeGreaterThanOrEqual(2),
        { timeout: 15000 },
      );
      expect(navigateMock).not.toHaveBeenCalled();

      // Targets become visible; the flow now holds for and clears the resize.
      onboardingData = { max_machine_tier: "xl", selected_storage_gib: 50 };

      await waitFor(() => expect(navigateMock).toHaveBeenCalled(), {
        timeout: 15000,
      });
    },
    20000,
  );

  test(
    "a preflight-active reload runs the provisioning wait before completing",
    async () => {
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
    },
    20000,
  );

  test(
    "the wait exceeding the hard cap completes anyway",
    async () => {
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
    },
    20000,
  );

  test(
    "an unknown (no-data) subscription read during a paid hatch keeps waiting, never completing at baseline",
    async () => {
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
      await waitFor(() =>
        expect(ensureProvisionedMock).toHaveBeenCalledTimes(1),
      );
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
    },
    20000,
  );

  test(
    "an erroring subscription endpoint still completes at the hard cap",
    async () => {
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
    },
    20000,
  );

  test(
    "a failed operational-status read counts as in-flight and holds until a healthy read arrives",
    async () => {
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
    },
    20000,
  );

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
});
