import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realRQ from "@tanstack/react-query";
import type { PlanListResponse } from "@/generated/api/types.gen.js";
import { cleanup, render, screen } from "@/test-utils.js";
import userEvent from "@testing-library/user-event";

// ---------------------------------------------------------------------------
// Query / mutation stubs
// ---------------------------------------------------------------------------

const PLANS_DATA: PlanListResponse = {
  plans: [
    {
      id: "base",
      name: "Base",
      price_cents: 0,
      billing_interval: "month",
      included_features: ["Pay-as-you-go credits", "Default machine size"],
    },
    {
      id: "pro",
      name: "Pro",
      base_price_cents: 1000,
      base_lookup_key: "vellum_pro_base",
      billing_interval: "month",
      machine_tiers: [
        {
          tier: "medium",
          label: "medium",
          price_cents: 3500,
          lookup_key: "vellum_pro_machine_m",
          cpu_limit: "2500m",
          memory_gib: 5,
          description: "Medium machine (2.5 vCPU, 5 GiB)",
        },
      ],
      storage_tiers: [
        {
          tier: "xs",
          label: "10 GiB",
          storage_gib: 10,
          price_cents: 500,
          lookup_key: "vellum_pro_storage_10gib",
        },
      ],
      included_features: [
        "Custom domain (email, web, API)",
        "Static IP address",
        "Priority support",
      ],
    },
  ],
};

const baseSubscription = {
  plan_id: "base",
  status: "active",
  renewal_date: null,
  current_period_end: null,
  cancel_at_period_end: false,
  cancel_at: null,
};
const proSubscription = { ...baseSubscription, plan_id: "pro" };
const proCancellingSubscription = {
  ...baseSubscription,
  plan_id: "pro",
  cancel_at_period_end: true,
  cancel_at: null,
  current_period_end: "2026-07-01T00:00:00Z",
};

interface QueryStub<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
}

let plansQuery: QueryStub<unknown> = {
  data: PLANS_DATA,
  isLoading: false,
  isError: false,
};
let subscriptionQuery: QueryStub<unknown> = {
  data: baseSubscription,
  isLoading: false,
  isError: false,
};

interface MutationCall {
  variables: unknown;
  callbacks: {
    onSuccess?: (data: unknown) => void;
    onError?: (error: unknown) => void;
  };
}

interface MutationStub {
  calls: MutationCall[];
  isPending: boolean;
}

let upgradeMutation: MutationStub = { calls: [], isPending: false };

interface PortalCall {
  variables: unknown;
}
let portalMutation: { calls: PortalCall[]; isPending: boolean } = {
  calls: [],
  isPending: false,
};

const invalidateQueries = mock((..._args: unknown[]) => {});

mock.module("@tanstack/react-query", () => ({
  ...realRQ,
  useQuery: (opts: { queryKey?: unknown[] }) => {
    const key = Array.isArray(opts?.queryKey) ? opts.queryKey[0] : undefined;
    const id =
      typeof key === "object" && key !== null && "_id" in key
        ? (key as { _id: string })._id
        : undefined;
    if (id === "organizationsBillingPlansRetrieve") {
      return plansQuery;
    }
    if (id === "organizationsBillingSubscriptionRetrieve") {
      return subscriptionQuery;
    }
    return { data: undefined, isLoading: false, isError: false };
  },
  useMutation: (_opts: unknown) => ({
    mutate: (
      variables: unknown,
      callbacks?: {
        onSuccess?: (data: unknown) => void;
        onError?: (error: unknown) => void;
      },
    ) => {
      upgradeMutation.calls.push({ variables, callbacks: callbacks ?? {} });
    },
    isPending: upgradeMutation.isPending,
  }),
  useQueryClient: () => ({
    invalidateQueries,
  }),
}));

mock.module("@/clients/platform/@tanstack/react-query.gen", () => ({
  organizationsBillingPlansRetrieveOptions: () => ({
    queryKey: [{ _id: "organizationsBillingPlansRetrieve" }],
  }),
  organizationsBillingPlansRetrieveQueryKey: () => [
    { _id: "organizationsBillingPlansRetrieve" },
  ],
  organizationsBillingSubscriptionRetrieveOptions: () => ({
    queryKey: [{ _id: "organizationsBillingSubscriptionRetrieve" }],
  }),
  organizationsBillingSubscriptionRetrieveQueryKey: () => [
    { _id: "organizationsBillingSubscriptionRetrieve" },
  ],
  organizationsBillingSubscriptionUpgradeCreateMutation: () => ({
    _mutationId: "upgrade",
  }),
}));

mock.module("@/lib/billing/use-billing-portal-session.js", () => ({
  // NOTE: bun:test `mock.module` mocks persist across files in the same
  // process. These stubs must mirror the real implementations in
  // `web/src/lib/billing/use-billing-portal-session.ts` so that other test
  // files (e.g. GracePeriodBanner.test.tsx) which load AFTER this one don't
  // observe broken behaviour.
  buildPortalReturnSnapshot: (
    data:
      | {
          cancel_at_period_end: boolean;
          cancel_at: string | null | undefined;
          plan_id: string;
        }
      | undefined,
  ) => {
    if (!data) return null;
    return {
      cancel_at_period_end: data.cancel_at_period_end,
      cancel_at: data.cancel_at ?? null,
      plan_id: data.plan_id,
    };
  },
  formatGraceDate: (iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  },
  useBillingPortalSession: (_snapshot: unknown) => ({
    mutate: (variables: unknown) => {
      portalMutation.calls.push({ variables });
    },
    isPending: portalMutation.isPending,
  }),
}));

const toastInfo = mock((..._args: unknown[]) => {});
const toastError = mock((..._args: unknown[]) => {});

mock.module("@/components/app/core/Toast", () => ({
  toast: {
    info: toastInfo,
    error: toastError,
    success: () => {},
    warning: () => {},
  },
}));

const openUrl = mock((..._args: unknown[]) => Promise.resolve());

let capturedBrowserFinishedListener: (() => void) | undefined;
const browserFinishedCleanup = mock(() => {});

mock.module("@/lib/browser.js", () => ({
  openUrl,
  openUrlFinishedListener: (callback: () => void) => {
    capturedBrowserFinishedListener = callback;
    return browserFinishedCleanup;
  },
}));

// ---------------------------------------------------------------------------
// Subject under test (imported AFTER mocks above).
// ---------------------------------------------------------------------------

import { AdjustPlanModal } from "@/components/app/settings/AdjustPlanModal.js";

// ---------------------------------------------------------------------------
// Per-test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  plansQuery = { data: PLANS_DATA, isLoading: false, isError: false };
  subscriptionQuery = {
    data: baseSubscription,
    isLoading: false,
    isError: false,
  };
  upgradeMutation = { calls: [], isPending: false };
  portalMutation = { calls: [], isPending: false };
  capturedBrowserFinishedListener = undefined;
  toastInfo.mockClear();
  toastError.mockClear();
  openUrl.mockClear();
  invalidateQueries.mockClear();
  browserFinishedCleanup.mockClear();
  document.body.removeAttribute("style");
  document.body.removeAttribute("data-scroll-locked");
});

afterEach(() => {
  cleanup();
  document.body.removeAttribute("style");
  document.body.removeAttribute("data-scroll-locked");
});

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

describe("AdjustPlanModal — visibility", () => {
  test("renders nothing visible when open=false", () => {
    const onClose = mock(() => {});
    render(<AdjustPlanModal open={false} onClose={onClose} />);
    expect(screen.queryByText("Upgrade Plan")).toBeNull();
    expect(screen.queryByTestId("modal-upgrade-to-pro-button")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Loading / error states
// ---------------------------------------------------------------------------

describe("AdjustPlanModal — loading + error states", () => {
  test("renders a spinner inside the modal while loading", () => {
    plansQuery = { data: undefined, isLoading: true, isError: false };
    subscriptionQuery = { data: undefined, isLoading: true, isError: false };
    const onClose = mock(() => {});
    render(<AdjustPlanModal open={true} onClose={onClose} />);
    expect(screen.getByText("Loading plans...")).toBeTruthy();
    expect(screen.queryByTestId("modal-upgrade-to-pro-button")).toBeNull();
  });

  test("renders an error Notice inside the modal when a query errors", () => {
    plansQuery = { data: undefined, isLoading: false, isError: true };
    const onClose = mock(() => {});
    render(<AdjustPlanModal open={true} onClose={onClose} />);
    expect(
      screen.getByText("Failed to load plans. Please try again later."),
    ).toBeTruthy();
    expect(screen.queryByTestId("modal-upgrade-to-pro-button")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Upgrade flow (Base user)
// ---------------------------------------------------------------------------

describe("AdjustPlanModal — Upgrade flow", () => {
  test("clicking Get PRO Plan calls upgrade with target_plan_id='pro' and confirm=true; onSuccess opens checkout URL", async () => {
    subscriptionQuery = {
      data: baseSubscription,
      isLoading: false,
      isError: false,
    };
    const onClose = mock(() => {});
    render(<AdjustPlanModal open={true} onClose={onClose} />);

    await userEvent.click(screen.getByTestId("modal-upgrade-to-pro-button"));

    expect(upgradeMutation.calls).toHaveLength(1);
    expect(upgradeMutation.calls[0]!.variables).toEqual({
      body: {
        target_plan_id: "pro",
        confirm: true,
        machine_tier: "medium",
        storage_tier: "xs",
      },
    });

    upgradeMutation.calls[0]!.callbacks.onSuccess?.({
      status: "redirect",
      checkout_url: "https://stripe.example/x",
      message: "Redirecting",
    });

    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl.mock.calls[0]![0]).toBe("https://stripe.example/x");
    expect(toastInfo).not.toHaveBeenCalled();
  });

  test("Upgrade onSuccess with no_op status calls onClose and shows info toast", async () => {
    subscriptionQuery = {
      data: baseSubscription,
      isLoading: false,
      isError: false,
    };
    const onClose = mock(() => {});
    render(<AdjustPlanModal open={true} onClose={onClose} />);
    await userEvent.click(screen.getByTestId("modal-upgrade-to-pro-button"));
    upgradeMutation.calls[0]!.callbacks.onSuccess?.({
      status: "no_op",
      checkout_url: null,
      message: "Already on Pro.",
    });

    expect(toastInfo).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });

  test("Upgrade onError with DRF machine_tier field error surfaces the real message (not the generic fallback)", async () => {
    subscriptionQuery = {
      data: baseSubscription,
      isLoading: false,
      isError: false,
    };
    const onClose = mock(() => {});
    render(<AdjustPlanModal open={true} onClose={onClose} />);
    await userEvent.click(screen.getByTestId("modal-upgrade-to-pro-button"));
    upgradeMutation.calls[0]!.callbacks.onError?.({
      machine_tier: ['"foo" is not a valid choice.'],
    });

    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError.mock.calls[0]![0]).toBe(
      '"foo" is not a valid choice.',
    );
  });
});

// ---------------------------------------------------------------------------
// Downgrade flow (Pro user, not cancelling)
// ---------------------------------------------------------------------------

describe("AdjustPlanModal — Downgrade flow (Pro user, not cancelling)", () => {
  test("Downgrade button visible; opens reconfirm modal; confirming triggers portal mutation", async () => {
    subscriptionQuery = {
      data: proSubscription,
      isLoading: false,
      isError: false,
    };
    const onClose = mock(() => {});
    render(<AdjustPlanModal open={true} onClose={onClose} />);

    expect(screen.getByTestId("modal-downgrade-to-base-button")).toBeTruthy();

    await userEvent.click(screen.getByTestId("modal-downgrade-to-base-button"));
    await userEvent.click(screen.getByTestId("confirm-downgrade-button"));

    expect(portalMutation.calls).toHaveLength(1);
    expect(portalMutation.calls[0]!.variables).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Cancellation matrix (Pro user with cancel_at_period_end=true)
// ---------------------------------------------------------------------------

describe("AdjustPlanModal — cancellation matrix", () => {
  test("Pro card shows ends-on copy + Keep your Plan; Base card has no CTA; clicking Keep your Plan calls portal mutation", async () => {
    subscriptionQuery = {
      data: proCancellingSubscription,
      isLoading: false,
      isError: false,
    };
    const onClose = mock(() => {});
    render(<AdjustPlanModal open={true} onClose={onClose} />);

    expect(screen.getByTestId("modal-cancels-on")).toBeTruthy();
    expect(screen.getByTestId("modal-cancels-on").textContent).toContain(
      "Your plan ends on",
    );
    expect(screen.getByTestId("modal-keep-plan-button")).toBeTruthy();
    expect(screen.queryByTestId("modal-downgrade-to-base-button")).toBeNull();

    await userEvent.click(screen.getByTestId("modal-keep-plan-button"));
    expect(portalMutation.calls).toHaveLength(1);
    expect(portalMutation.calls[0]!.variables).toEqual({});
  });

  test("Pro, canceled status with cancel_at_period_end=true — does NOT render cancellation UI", () => {
    // Stripe edge case: a fully canceled subscription can still carry
    // cancellation metadata (cancel_at_period_end=true, cancel_at, etc).
    // The cancellation UI ("Your plan ends on …" / "Keep your Plan") is only
    // meaningful for non-canceled subscriptions — for a terminal sub, those
    // CTAs would point users at an action Stripe cannot perform.
    subscriptionQuery = {
      data: {
        ...baseSubscription,
        plan_id: "pro",
        status: "canceled",
        cancel_at_period_end: true,
        cancel_at: "2026-04-01T00:00:00Z",
        current_period_end: "2026-04-01T00:00:00Z",
      },
      isLoading: false,
      isError: false,
    };
    const onClose = mock(() => {});
    render(<AdjustPlanModal open={true} onClose={onClose} />);

    // Modal still renders normally.
    expect(screen.getByText("Upgrade Plan")).toBeTruthy();
    // But the cancellation-state UI is gated off.
    expect(screen.queryByTestId("modal-cancels-on")).toBeNull();
    expect(screen.queryByTestId("modal-keep-plan-button")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Closing the modal
// ---------------------------------------------------------------------------

describe("AdjustPlanModal — closing", () => {
  test("footer docs link points to www.vellum.ai/docs", () => {
    const onClose = mock(() => {});
    render(<AdjustPlanModal open={true} onClose={onClose} />);
    const link = screen.getByText("Read our Docs.").closest("a");
    expect(link?.getAttribute("href")).toBe("https://www.vellum.ai/docs");
  });

  test("clicking the footer Cancel button calls onClose", async () => {
    const onClose = mock(() => {});
    render(<AdjustPlanModal open={true} onClose={onClose} />);

    await userEvent.click(screen.getByTestId("modal-cancel-button"));
    expect(onClose).toHaveBeenCalled();
  });

  test("pressing Escape (Radix onOpenChange(false)) calls onClose", async () => {
    const onClose = mock(() => {});
    render(<AdjustPlanModal open={true} onClose={onClose} />);

    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Browser-finished listener wiring (Capacitor iOS)
// ---------------------------------------------------------------------------

describe("AdjustPlanModal — openUrlFinishedListener wiring", () => {
  test("registers a listener on mount; firing it invalidates both query keys and calls onClose", () => {
    const onClose = mock(() => {});
    render(<AdjustPlanModal open={true} onClose={onClose} />);
    expect(capturedBrowserFinishedListener).toBeDefined();

    capturedBrowserFinishedListener!();

    const subscriptionInvalidations = invalidateQueries.mock.calls.filter(
      (call) => {
        const arg = call[0] as { queryKey?: unknown[] } | undefined;
        const key = Array.isArray(arg?.queryKey) ? arg.queryKey[0] : undefined;
        return (
          typeof key === "object" &&
          key !== null &&
          "_id" in key &&
          (key as { _id: string })._id ===
            "organizationsBillingSubscriptionRetrieve"
        );
      },
    );
    const plansInvalidations = invalidateQueries.mock.calls.filter((call) => {
      const arg = call[0] as { queryKey?: unknown[] } | undefined;
      const key = Array.isArray(arg?.queryKey) ? arg.queryKey[0] : undefined;
      return (
        typeof key === "object" &&
        key !== null &&
        "_id" in key &&
        (key as { _id: string })._id === "organizationsBillingPlansRetrieve"
      );
    });
    expect(subscriptionInvalidations.length).toBeGreaterThan(0);
    expect(plansInvalidations.length).toBeGreaterThan(0);
    expect(onClose).toHaveBeenCalled();
  });
});
