/**
 * Tests for PlanCard.
 *
 * Mirrors the GracePeriodBanner test pattern: renders the component to a
 * static HTML string with `renderToStaticMarkup` and asserts on the markup.
 * The `useQuery` mock is keyed by query-key `_id` (same approach as
 * `AdjustPlanClient.test.tsx`) so the two queries can be stubbed
 * independently per test.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as realRQ from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  BasePlan,
  PlanListResponse,
  ProPlan,
} from "@/generated/api/types.gen.js";

// ---------------------------------------------------------------------------
// Module mocks — registered before the subject is imported.
// ---------------------------------------------------------------------------

interface SubscriptionData {
  plan_id: string;
  status: string | null;
  renewal_date: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  cancel_at: string | null;
}

type PlansData = PlanListResponse;

interface QueryStub<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
}

let subscriptionQuery: QueryStub<SubscriptionData> = {
  data: undefined,
  isLoading: false,
  isError: false,
};
let plansQuery: QueryStub<PlansData> = {
  data: undefined,
  isLoading: false,
  isError: false,
};

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
}));

mock.module("@/clients/platform/@tanstack/react-query.gen", () => ({
  organizationsBillingPlansRetrieveOptions: () => ({
    queryKey: [{ _id: "organizationsBillingPlansRetrieve" }],
  }),
  organizationsBillingSubscriptionRetrieveOptions: () => ({
    queryKey: [{ _id: "organizationsBillingSubscriptionRetrieve" }],
  }),
}));

// ---------------------------------------------------------------------------
// Subject (imported AFTER mocks)
// ---------------------------------------------------------------------------

import { PlanCard } from "@/components/app/settings/PlanCard.js";

const PRO_PLAN: ProPlan = {
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
};
const BASE_PLAN: BasePlan = {
  id: "base",
  name: "Base",
  price_cents: 0,
  billing_interval: "month",
  included_features: ["Pay-as-you-go credits", "Default machine size"],
};
const PLANS_DATA: PlansData = { plans: [BASE_PLAN, PRO_PLAN] };

const onManage = () => {};

beforeEach(() => {
  subscriptionQuery = {
    data: undefined,
    isLoading: false,
    isError: false,
  };
  plansQuery = { data: undefined, isLoading: false, isError: false };
});

// ---------------------------------------------------------------------------
// Loading + error states
// ---------------------------------------------------------------------------

describe("PlanCard — loading + error states", () => {
  test("renders a loading state when both queries are loading", () => {
    subscriptionQuery = { data: undefined, isLoading: true, isError: false };
    plansQuery = { data: undefined, isLoading: true, isError: false };
    const html = renderToStaticMarkup(
      createElement(PlanCard, { onManage }),
    );
    expect(html).toContain("Loading plan");
  });

  test("renders an error Notice when the subscription query errors", () => {
    subscriptionQuery = { data: undefined, isLoading: false, isError: true };
    plansQuery = { data: PLANS_DATA, isLoading: false, isError: false };
    const html = renderToStaticMarkup(
      createElement(PlanCard, { onManage }),
    );
    expect(html).toContain("Failed to load plan.");
  });
});

// ---------------------------------------------------------------------------
// Pro state — no cancellation pending
// ---------------------------------------------------------------------------

describe("PlanCard — Pro state without cancellation", () => {
  beforeEach(() => {
    subscriptionQuery = {
      data: {
        plan_id: "pro",
        status: "active",
        renewal_date: "2026-06-15T12:00:00Z",
        current_period_end: "2026-06-15T12:00:00Z",
        cancel_at_period_end: false,
        cancel_at: null,
      },
      isLoading: false,
      isError: false,
    };
    plansQuery = { data: PLANS_DATA, isLoading: false, isError: false };
  });

  test("renders the PRO Plan label, subtitle, Manage button, and Renews-on line", () => {
    const html = renderToStaticMarkup(
      createElement(PlanCard, { onManage }),
    );
    expect(html).toContain("PRO Plan");
    expect(html).toContain(
      "Custom domain (email, web, API), Static IP address, Priority support",
    );
    expect(html).toContain('data-testid="plan-card-manage-button"');
    expect(html).toContain('data-testid="plan-card-renews"');
    expect(html).toContain("Renews on");
    // Locale-stable: must contain the year and the day, even if month name
    // varies by runtime locale.
    expect(html).toContain("2026");
    expect(html).toContain("15");
  });
});

// ---------------------------------------------------------------------------
// Pro state — cancellation pending
// ---------------------------------------------------------------------------

describe("PlanCard — Pro state with cancellation pending", () => {
  test("renders Cancels-on line using cancel_at when set", () => {
    subscriptionQuery = {
      data: {
        plan_id: "pro",
        status: "active",
        renewal_date: "2026-07-01T12:00:00Z",
        current_period_end: "2026-06-15T12:00:00Z",
        cancel_at_period_end: true,
        cancel_at: "2026-07-01T12:00:00Z",
      },
      isLoading: false,
      isError: false,
    };
    plansQuery = { data: PLANS_DATA, isLoading: false, isError: false };

    const html = renderToStaticMarkup(
      createElement(PlanCard, { onManage }),
    );
    expect(html).toContain('data-testid="plan-card-cancels"');
    expect(html).toContain("Your plan ends on");
    expect(html).toContain("2026");
    expect(html).toContain("1");
    // Manage button should still render so the user can reactivate.
    expect(html).toContain('data-testid="plan-card-manage-button"');
    // Renews-on line must NOT render when cancellation is pending.
    expect(html).not.toContain('data-testid="plan-card-renews"');
  });

  test("falls back to current_period_end when cancel_at is null", () => {
    subscriptionQuery = {
      data: {
        plan_id: "pro",
        status: "active",
        renewal_date: "2026-07-01T12:00:00Z",
        current_period_end: "2026-07-01T12:00:00Z",
        cancel_at_period_end: true,
        cancel_at: null,
      },
      isLoading: false,
      isError: false,
    };
    plansQuery = { data: PLANS_DATA, isLoading: false, isError: false };

    const html = renderToStaticMarkup(
      createElement(PlanCard, { onManage }),
    );
    expect(html).toContain('data-testid="plan-card-cancels"');
    expect(html).toContain("Your plan ends on");
    expect(html).toContain("2026");
    expect(html).toContain("1");
    expect(html).toContain('data-testid="plan-card-manage-button"');
  });
});

// ---------------------------------------------------------------------------
// Pro state — canceled status (final canceled state)
// ---------------------------------------------------------------------------

describe("PlanCard — Pro, canceled status", () => {
  test("does NOT render 'Renews on' when status is canceled", () => {
    subscriptionQuery = {
      data: {
        plan_id: "pro",
        status: "canceled",
        renewal_date: null,
        current_period_end: "2026-06-15T12:00:00Z",
        cancel_at_period_end: false,
        cancel_at: null,
      },
      isLoading: false,
      isError: false,
    };
    plansQuery = { data: PLANS_DATA, isLoading: false, isError: false };

    const html = renderToStaticMarkup(
      createElement(PlanCard, { onManage }),
    );
    // Card and Manage button still render.
    expect(html).toContain("PRO Plan");
    expect(html).toContain('data-testid="plan-card-manage-button"');
    // Neither the renews nor cancels line should render.
    expect(html).not.toContain('data-testid="plan-card-renews"');
    expect(html).not.toContain('data-testid="plan-card-cancels"');
  });

  test("Pro, canceled status with cancel_at_period_end=true — does NOT render 'Cancels on'", () => {
    // Edge case: Stripe leaves cancel_at_period_end=true on a fully-canceled
    // subscription. Without the !isCanceled guard, PlanCard would render a
    // stale "Cancels on [past date]" line.
    subscriptionQuery = {
      data: {
        plan_id: "pro",
        status: "canceled",
        renewal_date: null,
        current_period_end: "2026-04-01T12:00:00Z",
        cancel_at_period_end: true,
        cancel_at: "2026-04-01T12:00:00Z",
      },
      isLoading: false,
      isError: false,
    };
    plansQuery = { data: PLANS_DATA, isLoading: false, isError: false };

    const html = renderToStaticMarkup(
      createElement(PlanCard, { onManage }),
    );
    // Card and Manage button still render.
    expect(html).toContain("PRO Plan");
    expect(html).toContain('data-testid="plan-card-manage-button"');
    // Neither the renews nor cancels line should render.
    expect(html).not.toContain('data-testid="plan-card-renews"');
    expect(html).not.toContain('data-testid="plan-card-cancels"');
  });
});

// ---------------------------------------------------------------------------
// Base state
// ---------------------------------------------------------------------------

describe("PlanCard — Base state", () => {
  test("renders Basic Plan label, Upgrade button, and no renews/cancels copy", () => {
    subscriptionQuery = {
      data: {
        plan_id: "base",
        status: "active",
        renewal_date: null,
        current_period_end: null,
        cancel_at_period_end: false,
        cancel_at: null,
      },
      isLoading: false,
      isError: false,
    };
    plansQuery = { data: PLANS_DATA, isLoading: false, isError: false };

    const html = renderToStaticMarkup(
      createElement(PlanCard, { onManage }),
    );
    expect(html).toContain("Basic Plan");
    expect(html).toContain('data-testid="plan-card-upgrade-button"');
    expect(html).not.toContain('data-testid="plan-card-renews"');
    expect(html).not.toContain('data-testid="plan-card-cancels"');
  });
});

// ---------------------------------------------------------------------------
// Source-pinning — locks load-bearing expressions the unit tests above
// can't reach without a DOM. Mirrors GracePeriodBanner.test.tsx.
// ---------------------------------------------------------------------------

describe("PlanCard — source pinning", () => {
  let source = "";

  beforeEach(async () => {
    if (source) return;
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    source = await fs.readFile(
      path.join(import.meta.dir, "PlanCard.tsx"),
      "utf-8",
    );
  });

  test("falls back from cancel_at to current_period_end via ?? operator", () => {
    expect(source).toContain("getEffectiveCancelDate(subscription)");
  });
});
