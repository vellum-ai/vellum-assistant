import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import * as realRQ from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@/test-utils.js";

// ---------------------------------------------------------------------------
// Subscription query stub — controlled per-test.
// ---------------------------------------------------------------------------

interface SubscriptionData {
  plan_id: string;
  status: string;
  renewal_date: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  cancel_at: string | null;
}

interface QueryStub {
  data: SubscriptionData | undefined;
  isError: boolean;
}

let subscriptionQuery: QueryStub = {
  data: { plan_id: "base", status: "incomplete", renewal_date: null, current_period_end: null, cancel_at_period_end: false, cancel_at: null },
  isError: false,
};

let lastUseQueryOpts: { refetchInterval?: unknown } | undefined;
const invalidateQueries = mock((..._args: unknown[]) => {});

mock.module("@tanstack/react-query", () => ({
  ...realRQ,
  useQuery: (opts: { refetchInterval?: unknown }) => {
    lastUseQueryOpts = opts;
    return subscriptionQuery;
  },
  useQueryClient: () => ({
    invalidateQueries,
  }),
}));

mock.module("@/clients/platform/@tanstack/react-query.gen", () => ({
  organizationsBillingSubscriptionRetrieveOptions: () => ({
    queryKey: [{ _id: "organizationsBillingSubscriptionRetrieve" }],
  }),
  organizationsBillingSubscriptionRetrieveQueryKey: () => [
    { _id: "organizationsBillingSubscriptionRetrieve" },
  ],
}));

// ---------------------------------------------------------------------------
// Router stub.
// ---------------------------------------------------------------------------

const routerReplace = mock((..._args: unknown[]) => {});

mock.module("next/navigation", () => ({
  useRouter: () => ({
    push: () => {},
    replace: routerReplace,
    back: () => {},
    prefetch: () => {},
    refresh: () => {},
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));

// ---------------------------------------------------------------------------
// Subject under test (imported AFTER mocks above).
// ---------------------------------------------------------------------------

import { routes } from "@/lib/routes.js";

import UpgradeSuccessPage, {
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
  SUCCESS_REDIRECT_DELAY_MS,
} from "@/domains/settings/billing/upgrade/success/page.js";

// ---------------------------------------------------------------------------
// Per-test setup: capture timer registrations.
// ---------------------------------------------------------------------------

interface TimerCall {
  callback: () => void;
  delay: number;
}

let timerCalls: TimerCall[] = [];
let originalSetTimeout: typeof globalThis.setTimeout;
let originalClearTimeout: typeof globalThis.clearTimeout;

beforeEach(() => {
  routerReplace.mockClear();
  invalidateQueries.mockClear();
  lastUseQueryOpts = undefined;
  timerCalls = [];

  originalSetTimeout = globalThis.setTimeout;
  originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = ((callback: () => void, delay: number) => {
    timerCalls.push({ callback, delay });
    return timerCalls.length as unknown;
  }) as typeof globalThis.setTimeout;
  globalThis.clearTimeout = (() => {}) as typeof globalThis.clearTimeout;
});

afterEach(() => {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
  cleanup();
});

// Helper: pick the captured timer registered for a specific delay.
function timerFor(delayMs: number): TimerCall | undefined {
  return timerCalls.find((t) => t.delay === delayMs);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("UpgradeSuccessPage", () => {
  test("invalidates the subscription query on mount", () => {
    subscriptionQuery = {
      data: {
        plan_id: "base",
        status: "incomplete",
        renewal_date: null,
        current_period_end: null,
        cancel_at_period_end: false,
        cancel_at: null,
      },
      isError: false,
    };

    render(<UpgradeSuccessPage />);

    const subInvalidations = invalidateQueries.mock.calls.filter((call) => {
      const arg = call[0] as { queryKey?: unknown[] } | undefined;
      const key = Array.isArray(arg?.queryKey) ? arg.queryKey[0] : undefined;
      return (
        typeof key === "object" &&
        key !== null &&
        "_id" in key &&
        (key as { _id: string })._id ===
          "organizationsBillingSubscriptionRetrieve"
      );
    });
    expect(subInvalidations.length).toBeGreaterThan(0);
  });

  test("renders pending state when plan_id is base", () => {
    subscriptionQuery = {
      data: {
        plan_id: "base",
        status: "incomplete",
        renewal_date: null,
        current_period_end: null,
        cancel_at_period_end: false,
        cancel_at: null,
      },
      isError: false,
    };

    render(<UpgradeSuccessPage />);
    expect(screen.getByText(/Finalizing your upgrade/)).toBeTruthy();
  });

  test("renders success state when plan_id flips to pro", () => {
    subscriptionQuery = {
      data: {
        plan_id: "pro",
        status: "active",
        renewal_date: null,
        current_period_end: null,
        cancel_at_period_end: false,
        cancel_at: null,
      },
      isError: false,
    };

    render(<UpgradeSuccessPage />);
    expect(screen.getByText("Welcome to Pro")).toBeTruthy();
  });

  test("renders fallback state after poll timeout when plan_id is still base", () => {
    subscriptionQuery = {
      data: {
        plan_id: "base",
        status: "incomplete",
        renewal_date: null,
        current_period_end: null,
        cancel_at_period_end: false,
        cancel_at: null,
      },
      isError: false,
    };

    render(<UpgradeSuccessPage />);
    const timeoutTimer = timerFor(POLL_TIMEOUT_MS);
    expect(timeoutTimer).toBeDefined();
    act(() => {
      timeoutTimer!.callback();
    });

    expect(screen.getByText(/We're processing your upgrade/)).toBeTruthy();
  });

  test("renders fetch error state when the subscription query errors", () => {
    subscriptionQuery = {
      data: undefined,
      isError: true,
    };

    render(<UpgradeSuccessPage />);
    expect(screen.getByText(/Couldn't reach billing/)).toBeTruthy();
  });

  test("auto-redirects to billing settings after observing plan_id === pro", () => {
    subscriptionQuery = {
      data: {
        plan_id: "pro",
        status: "active",
        renewal_date: null,
        current_period_end: null,
        cancel_at_period_end: false,
        cancel_at: null,
      },
      isError: false,
    };

    render(<UpgradeSuccessPage />);

    const redirectTimer = timerFor(SUCCESS_REDIRECT_DELAY_MS);
    expect(redirectTimer).toBeDefined();
    redirectTimer!.callback();

    expect(routerReplace).toHaveBeenCalledWith(routes.settings.billing);
  });

  test("Go to billing button on success state navigates immediately", () => {
    subscriptionQuery = {
      data: {
        plan_id: "pro",
        status: "active",
        renewal_date: null,
        current_period_end: null,
        cancel_at_period_end: false,
        cancel_at: null,
      },
      isError: false,
    };

    render(<UpgradeSuccessPage />);
    // userEvent uses setTimeout internally; use fireEvent (synchronous) since
    // globalThis.setTimeout is patched in this test suite.
    fireEvent.click(screen.getByTestId("upgrade-success-go-to-billing"));

    expect(routerReplace).toHaveBeenCalledWith(routes.settings.billing);
  });

  test("polling refetchInterval is gated correctly", () => {
    subscriptionQuery = { data: undefined, isError: false };
    render(<UpgradeSuccessPage />);

    const refetchInterval = lastUseQueryOpts?.refetchInterval as
      | ((q: { state: { data: SubscriptionData | undefined } }) => number | false)
      | undefined;
    expect(typeof refetchInterval).toBe("function");

    // Undefined data: still loading first response — keep polling.
    expect(refetchInterval!({ state: { data: undefined } })).toBe(
      POLL_INTERVAL_MS,
    );

    // plan_id === "base" + pollExpired false: keep polling.
    expect(
      refetchInterval!({
        state: {
          data: {
            plan_id: "base",
            status: "incomplete",
            renewal_date: null,
            current_period_end: null,
            cancel_at_period_end: false,
            cancel_at: null,
          },
        },
      }),
    ).toBe(POLL_INTERVAL_MS);

    // plan_id === "pro": stop polling.
    expect(
      refetchInterval!({
        state: {
          data: {
            plan_id: "pro",
            status: "active",
            renewal_date: null,
            current_period_end: null,
            cancel_at_period_end: false,
            cancel_at: null,
          },
        },
      }),
    ).toBe(false);

    // Flip pollExpired by firing the captured 10s timer, then let React
    // re-render with pollExpired=true and capture the fresh refetchInterval
    // closure from the updated useQuery call.
    const timeoutTimer = timerFor(POLL_TIMEOUT_MS);
    expect(timeoutTimer).toBeDefined();
    act(() => {
      timeoutTimer!.callback();
    });

    const refetchInterval2 = lastUseQueryOpts?.refetchInterval as
      | ((q: { state: { data: SubscriptionData | undefined } }) => number | false)
      | undefined;
    expect(typeof refetchInterval2).toBe("function");

    // pollExpired === true: stop polling regardless of plan_id.
    expect(
      refetchInterval2!({
        state: {
          data: {
            plan_id: "base",
            status: "incomplete",
            renewal_date: null,
            current_period_end: null,
            cancel_at_period_end: false,
            cancel_at: null,
          },
        },
      }),
    ).toBe(false);
  });
});
