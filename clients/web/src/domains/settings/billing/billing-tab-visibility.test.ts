import { describe, expect, test } from "bun:test";

import {
  hasBillingIntent,
  shouldShowBillingTab,
} from "@/domains/settings/billing/billing-tab-visibility";

const params = (q: string) => new URLSearchParams(q);

describe("hasBillingIntent", () => {
  test("true for billing-intent params", () => {
    expect(hasBillingIntent(params("tab=billing"))).toBe(true);
    expect(hasBillingIntent(params("adjust_plan=1"))).toBe(true);
    expect(hasBillingIntent(params("pro_onboarding"))).toBe(true);
    expect(hasBillingIntent(params("billing_status=success"))).toBe(true);
    expect(hasBillingIntent(params("session_id=cs_test_123"))).toBe(true);
  });

  test("false for non-billing params", () => {
    expect(hasBillingIntent(params(""))).toBe(false);
    expect(hasBillingIntent(params("tab=usage"))).toBe(false);
    expect(hasBillingIntent(params("range=7d&groupBy=schedule"))).toBe(false);
  });
});

describe("shouldShowBillingTab", () => {
  test("signed in ('full'): always shown", () => {
    expect(shouldShowBillingTab("full", params(""))).toBe(true);
    expect(shouldShowBillingTab("full", params("tab=usage"))).toBe(true);
  });

  test("signed out but reachable ('disabled'): only with billing intent", () => {
    // Normal browsing → hidden (honors "hide Billing when signed out").
    expect(shouldShowBillingTab("disabled", params(""))).toBe(false);
    expect(shouldShowBillingTab("disabled", params("tab=usage"))).toBe(false);
    // Billing deeplinks / Stripe returns → reachable so the login funnel runs.
    expect(shouldShowBillingTab("disabled", params("tab=billing"))).toBe(true);
    expect(
      shouldShowBillingTab("disabled", params("billing_status=success")),
    ).toBe(true);
    expect(
      shouldShowBillingTab("disabled", params("session_id=cs_test_123")),
    ).toBe(true);
    expect(shouldShowBillingTab("disabled", params("adjust_plan=1"))).toBe(true);
    expect(shouldShowBillingTab("disabled", params("pro_onboarding"))).toBe(true);
  });

  test("gated (no platform): never shown, even with billing intent", () => {
    expect(shouldShowBillingTab("gated", params("tab=billing"))).toBe(false);
    expect(
      shouldShowBillingTab("gated", params("billing_status=success")),
    ).toBe(false);
  });
});
