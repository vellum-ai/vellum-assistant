/**
 * Tests for `CurrentPlanCard`.
 *
 * Strategy mirrors `BillingPanel.test.tsx` — `bun test` cannot drive a real
 * DOM, so we mock `useQuery` per-test via `renderToStaticMarkup` and assert
 * on the resulting HTML.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realRQ from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";

// ---------------------------------------------------------------------------
// Module mocks — registered before the subject is imported.
// ---------------------------------------------------------------------------

interface QueryStub<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
}

let subscriptionQuery: QueryStub<unknown> = {
  data: undefined,
  isLoading: true,
  isError: false,
};

mock.module("@tanstack/react-query", () => ({
  ...realRQ,
  useQuery: () => subscriptionQuery,
}));

mock.module("@/clients/platform/@tanstack/react-query.gen", () => ({
  organizationsBillingSubscriptionRetrieveOptions: () => ({
    queryKey: [{ _id: "organizationsBillingSubscriptionRetrieve" }],
  }),
}));

// ---------------------------------------------------------------------------
// Subject (imported AFTER mocks)
// ---------------------------------------------------------------------------

import { CurrentPlanCard } from "@/components/app/settings/CurrentPlanCard.js";

// ---------------------------------------------------------------------------
// Per-test setup — pin Intl.DateTimeFormat for deterministic date output and
// reset the per-test query stub.
// ---------------------------------------------------------------------------

const realDateTimeFormat = globalThis.Intl.DateTimeFormat;

beforeEach(() => {
  subscriptionQuery = {
    data: undefined,
    isLoading: true,
    isError: false,
  };
  globalThis.Intl.DateTimeFormat = function () {
    return { format: () => "Apr 30, 2026" };
  } as unknown as typeof Intl.DateTimeFormat;
});

afterEach(() => {
  globalThis.Intl.DateTimeFormat = realDateTimeFormat;
});

// ---------------------------------------------------------------------------
// Render-state tests
// ---------------------------------------------------------------------------

describe("CurrentPlanCard — render states", () => {
  test("renders loading state while query is loading", () => {
    subscriptionQuery = { data: undefined, isLoading: true, isError: false };
    const html = renderToStaticMarkup(<CurrentPlanCard />);
    expect(html).toContain("Loading plan");
  });

  test("renders error notice when query errors", () => {
    subscriptionQuery = { data: undefined, isLoading: false, isError: true };
    const html = renderToStaticMarkup(<CurrentPlanCard />);
    expect(html).toContain("Failed to load your plan");
  });

  test("renders 'Base' name and no renewal/status for a base-plan org", () => {
    subscriptionQuery = {
      data: {
        plan_id: "base",
        status: null,
        renewal_date: null,
        current_period_end: null,
        cancel_at_period_end: false,
        cancel_at: null,
      },
      isLoading: false,
      isError: false,
    };
    const html = renderToStaticMarkup(<CurrentPlanCard />);
    expect(html).toContain("Current Plan");
    expect(html).toContain(">Base<");
    expect(html).not.toContain('data-testid="current-plan-renewal"');
    expect(html).not.toContain('data-testid="current-plan-status"');
  });

  test("renders 'Pro' name + renewal date + status badge for an active Pro org", () => {
    subscriptionQuery = {
      data: {
        plan_id: "pro",
        status: "active",
        renewal_date: "2026-05-30T00:00:00Z",
        current_period_end: "2026-05-30T00:00:00Z",
        cancel_at_period_end: false,
        cancel_at: null,
      },
      isLoading: false,
      isError: false,
    };
    const html = renderToStaticMarkup(<CurrentPlanCard />);
    expect(html).toContain(">Pro<");
    expect(html).toContain("Renews on Apr 30, 2026");
    expect(html).toContain(">Active<");
  });

  test("renders 'Past due' label for past_due Pro org", () => {
    subscriptionQuery = {
      data: {
        plan_id: "pro",
        status: "past_due",
        renewal_date: "2026-05-30T00:00:00Z",
        current_period_end: "2026-05-30T00:00:00Z",
        cancel_at_period_end: false,
        cancel_at: null,
      },
      isLoading: false,
      isError: false,
    };
    const html = renderToStaticMarkup(<CurrentPlanCard />);
    expect(html).toContain(">Past due<");
  });

  test("falls back to 'Unknown' for unrecognized plan_id", () => {
    subscriptionQuery = {
      data: {
        plan_id: "future_plan",
        status: null,
        renewal_date: null,
        current_period_end: null,
        cancel_at_period_end: false,
        cancel_at: null,
      },
      isLoading: false,
      isError: false,
    };
    const html = renderToStaticMarkup(<CurrentPlanCard />);
    expect(html).toContain(">Unknown<");
  });

  test("does not render the renewal line when current_period_end is null", () => {
    subscriptionQuery = {
      data: {
        plan_id: "pro",
        status: "active",
        renewal_date: null,
        current_period_end: null,
        cancel_at_period_end: false,
        cancel_at: null,
      },
      isLoading: false,
      isError: false,
    };
    const html = renderToStaticMarkup(<CurrentPlanCard />);
    expect(html).not.toContain('data-testid="current-plan-renewal"');
  });

  test("suppresses the renewal line when cancel_at_period_end is true", () => {
    subscriptionQuery = {
      data: {
        plan_id: "pro",
        status: "active",
        renewal_date: "2026-05-30T00:00:00Z",
        current_period_end: "2026-05-30T00:00:00Z",
        cancel_at_period_end: true,
        cancel_at: "2026-05-30T00:00:00Z",
      },
      isLoading: false,
      isError: false,
    };
    const html = renderToStaticMarkup(<CurrentPlanCard />);
    // Renewal line is the misleading one — must not render when cancellation is scheduled.
    expect(html).not.toContain('data-testid="current-plan-renewal"');
    expect(html).not.toContain("Renews on");
    // Status badge still renders (ATL-228 owns the grace banner; the badge is in scope).
    expect(html).toContain(">Active<");
  });

  test("suppresses the renewal line when status is canceled", () => {
    subscriptionQuery = {
      data: {
        plan_id: "pro",
        status: "canceled",
        renewal_date: "2026-05-30T00:00:00Z",
        current_period_end: "2026-05-30T00:00:00Z",
        cancel_at_period_end: false,
        cancel_at: null,
      },
      isLoading: false,
      isError: false,
    };
    const html = renderToStaticMarkup(<CurrentPlanCard />);
    // After cancellation finalizes, current_period_end may still hold a date —
    // showing "Renews on …" alongside a "Canceled" badge is self-contradictory.
    expect(html).not.toContain('data-testid="current-plan-renewal"');
    expect(html).not.toContain("Renews on");
    // The status badge still renders so users see the terminal state.
    expect(html).toContain(">Canceled<");
  });
});
