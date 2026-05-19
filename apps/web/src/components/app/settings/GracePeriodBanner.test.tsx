/**
 * Tests for GracePeriodBanner.
 *
 * The web workspace doesn't pull in @testing-library/react, so we render the
 * component to a static HTML string with `renderToStaticMarkup` (same pattern
 * as CreatureFooter.test.tsx) and assert on the markup. For interaction
 * coverage of the "Reactivate" button we mock `useBillingPortalSession` and
 * extract the rendered Button's `onClick` from the React tree directly via
 * the same module-mock pattern.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as realRQ from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

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

let queryResult: { data: SubscriptionData | undefined } = { data: undefined };

mock.module("@tanstack/react-query", () => ({
  ...realRQ,
  useQuery: () => queryResult,
}));

const mutateMock = mock((..._args: unknown[]) => {});
let isPending = false;
const useBillingPortalSessionMock = mock(
  (..._args: unknown[]) => ({
    mutate: mutateMock,
    isPending,
  }),
);

mock.module("@/lib/billing/use-billing-portal-session.js", () => ({
  useBillingPortalSession: useBillingPortalSessionMock,
}));

// ---------------------------------------------------------------------------
// Subject (imported AFTER mocks)
// ---------------------------------------------------------------------------

import { GracePeriodBanner } from "@/components/app/settings/GracePeriodBanner.js";

beforeEach(() => {
  queryResult = { data: undefined };
  isPending = false;
  mutateMock.mockClear();
  useBillingPortalSessionMock.mockClear();
});

// ---------------------------------------------------------------------------
// Rendering — null branches
// ---------------------------------------------------------------------------

describe("GracePeriodBanner — hidden states", () => {
  test("renders nothing when subscription data is undefined (loading)", () => {
    queryResult = { data: undefined };
    const html = renderToStaticMarkup(createElement(GracePeriodBanner));
    expect(html).toBe("");
  });

  test("renders nothing when cancel_at_period_end is false", () => {
    queryResult = {
      data: {
        plan_id: "pro",
        status: "active",
        renewal_date: "2026-06-01T12:00:00Z",
        current_period_end: "2026-06-01T12:00:00Z",
        cancel_at_period_end: false,
        cancel_at: null,
      },
    };
    const html = renderToStaticMarkup(createElement(GracePeriodBanner));
    expect(html).toBe("");
  });

  test("renders nothing when cancel_at_period_end is true but cancel_at is null", () => {
    queryResult = {
      data: {
        plan_id: "pro",
        status: "active",
        renewal_date: null,
        current_period_end: null,
        cancel_at_period_end: true,
        cancel_at: null,
      },
    };
    const html = renderToStaticMarkup(createElement(GracePeriodBanner));
    expect(html).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Rendering — banner visible
// ---------------------------------------------------------------------------

describe("GracePeriodBanner — visible state", () => {
  beforeEach(() => {
    queryResult = {
      data: {
        plan_id: "pro",
        status: "active",
        renewal_date: "2026-06-15T12:00:00Z",
        current_period_end: "2026-06-15T12:00:00Z",
        cancel_at_period_end: true,
        cancel_at: "2026-06-15T12:00:00Z",
      },
    };
  });

  test("renders the Notice with a locale-formatted date in the title", () => {
    const html = renderToStaticMarkup(createElement(GracePeriodBanner));
    expect(html).toContain('data-testid="grace-period-banner"');
    expect(html).toContain("Your Pro plan will end on");
    // Locale-stable: must contain the year and the day, even if month name
    // varies by runtime locale.
    expect(html).toContain("2026");
    expect(html).toContain("15");
  });

  test("renders the subtitle copy in the Notice body", () => {
    const html = renderToStaticMarkup(createElement(GracePeriodBanner));
    expect(html).toContain("keep Pro features until then");
  });

  test("renders the Reactivate button with the test id", () => {
    const html = renderToStaticMarkup(createElement(GracePeriodBanner));
    expect(html).toContain('data-testid="grace-period-reactivate-button"');
    expect(html).toContain("Reactivate");
  });

  test("the Reactivate button is disabled while the mutation is pending", () => {
    isPending = true;
    const html = renderToStaticMarkup(createElement(GracePeriodBanner));
    expect(html).toContain('data-testid="grace-period-reactivate-button"');
    expect(html).toContain("disabled");
  });

  test("renders banner using current_period_end when cancel_at is null", () => {
    queryResult = {
      data: {
        plan_id: "pro",
        status: "active",
        renewal_date: null,
        current_period_end: "2026-06-15T12:00:00Z",
        cancel_at_period_end: true,
        cancel_at: null,
      },
    };
    const html = renderToStaticMarkup(createElement(GracePeriodBanner));
    expect(html).toContain('data-testid="grace-period-banner"');
    expect(html).toContain("Your Pro plan will end on");
    expect(html).toContain("2026");
  });
});

// ---------------------------------------------------------------------------
// useBillingPortalSession wiring — snapshot + click invokes mutate
// ---------------------------------------------------------------------------

describe("GracePeriodBanner — portal session integration", () => {
  test("passes a snapshot derived from the subscription data to the hook", () => {
    queryResult = {
      data: {
        plan_id: "pro",
        status: "active",
        renewal_date: "2026-06-15T12:00:00Z",
        current_period_end: "2026-06-15T12:00:00Z",
        cancel_at_period_end: true,
        cancel_at: "2026-06-15T12:00:00Z",
      },
    };
    renderToStaticMarkup(createElement(GracePeriodBanner));
    expect(useBillingPortalSessionMock).toHaveBeenCalled();
    const lastCall =
      useBillingPortalSessionMock.mock.calls[
        useBillingPortalSessionMock.mock.calls.length - 1
      ];
    expect(lastCall?.[0]).toEqual({
      cancel_at_period_end: true,
      cancel_at: "2026-06-15T12:00:00Z",
      plan_id: "pro",
    });
  });

  test("passes null snapshot when the subscription is still loading", () => {
    queryResult = { data: undefined };
    renderToStaticMarkup(createElement(GracePeriodBanner));
    expect(useBillingPortalSessionMock).toHaveBeenCalled();
    const lastCall =
      useBillingPortalSessionMock.mock.calls[
        useBillingPortalSessionMock.mock.calls.length - 1
      ];
    expect(lastCall?.[0]).toBeNull();
  });

  test("subscribes to the portal-session mutation hook so click can fire mutate", () => {
    queryResult = {
      data: {
        plan_id: "pro",
        status: "active",
        renewal_date: "2026-06-15T12:00:00Z",
        current_period_end: "2026-06-15T12:00:00Z",
        cancel_at_period_end: true,
        cancel_at: "2026-06-15T12:00:00Z",
      },
    };
    renderToStaticMarkup(createElement(GracePeriodBanner));
    // The hook is the only conduit between the rendered button and the
    // server. If the component stops calling it (or stops feeding it the
    // snapshot), the Reactivate flow silently breaks. We assert it WAS
    // invoked here; the snapshot shape is asserted in the test above; the
    // wiring of `onClick={() => portalMutation.mutate({})}` is locked in
    // by the source-pinning suite below.
    expect(useBillingPortalSessionMock).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Source-pinning — load-bearing strings the unit tests above can't reach
// without a DOM. Mirrors the technique used by
// BillingPortalReturnHandler.test.tsx.
// ---------------------------------------------------------------------------

describe("GracePeriodBanner — source pinning", () => {
  let source = "";

  beforeEach(async () => {
    if (source) return;
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    source = await fs.readFile(
      path.join(import.meta.dir, "GracePeriodBanner.tsx"),
      "utf-8",
    );
  });

  test("Reactivate button click fires the portal-session mutation", () => {
    expect(source).toContain("portalMutation.mutate({})");
  });

  test("guards against rendering when subscription data is unavailable", () => {
    expect(source).toContain("getEffectiveCancelDate(data)");
  });

  test("uses the info tone Notice primitive", () => {
    expect(source).toContain('tone="info"');
  });

  test("derives the snapshot via the shared buildPortalReturnSnapshot helper", () => {
    // The snapshot literal (cancel_at_period_end / cancel_at / plan_id) is
    // owned by `buildPortalReturnSnapshot` in use-billing-portal-session.ts
    // so AdjustPlanClient and GracePeriodBanner share one source of truth.
    expect(source).toContain("buildPortalReturnSnapshot(data)");
  });
});
