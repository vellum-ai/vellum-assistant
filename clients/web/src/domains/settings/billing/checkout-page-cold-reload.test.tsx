/**
 * Cold-reload coverage for the deep-link CheckoutPage.
 *
 * `checkout-page.test.tsx` mocks the platform gate to drive the page's own
 * branches. This file leaves the gate real and drives the auth store instead,
 * so the page sees the window a hard reload of `/assistant/checkout?package=…`
 * actually opens: `sessionStatus` is already authenticated while
 * `platformSession` is still `"unknown"`, because the local-gateway path
 * settles the first without awaiting the second.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";

import { saveCheckoutIntent } from "@/lib/billing/checkout-intent";
import * as sdkGen from "@/generated/api/sdk.gen";
import * as browserRuntime from "@/runtime/browser";
import * as orgReadyMod from "@/hooks/use-is-org-ready";
import * as takeoverMod from "@/hooks/use-marketing-pricing-takeover";

const CHECKOUT_URL = "https://stripe.test/checkout/session";
const INTENT_KEY = "vellum.pro-checkout-intent";
const ENTRY = "/assistant/checkout?package=super";

type Captured = { body?: unknown };
const upgradeCalls: Captured[] = [];
let openedUrl: string | null = null;

mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  organizationsBillingSubscriptionUpgradeCreate: (opts: Captured) => {
    upgradeCalls.push(opts);
    return Promise.resolve({
      data: { status: "redirect", checkout_url: CHECKOUT_URL, message: "" },
      response: { ok: true },
    });
  },
}));

mock.module("@/runtime/browser", () => ({
  ...browserRuntime,
  openUrl: (url: string) => {
    openedUrl = url;
    return Promise.resolve();
  },
}));

// Org readiness and the funnel flag are settled here so the platform session is
// the only thing the page is waiting on.
mock.module("@/hooks/use-is-org-ready", () => ({
  ...orgReadyMod,
  useOrgHeaderReadiness: () => "ready",
}));

mock.module("@/hooks/use-marketing-pricing-takeover", () => ({
  ...takeoverMod,
  useMarketingPricingTakeover: () => "enabled",
}));

const { useAuthStore } = await import("@/stores/auth-store");
const { CheckoutPage } = await import("./checkout-page");

const initialAuthState = useAuthStore.getState();

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="loc">{location.pathname + location.search}</div>;
}

function renderCheckout() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <MemoryRouter initialEntries={[ENTRY]}>
      <QueryClientProvider client={client}>
        <Routes>
          <Route path="/assistant/checkout" element={<CheckoutPage />} />
          <Route path="*" element={null} />
        </Routes>
      </QueryClientProvider>
      <LocationProbe />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  upgradeCalls.length = 0;
  openedUrl = null;
  sessionStorage.removeItem(INTENT_KEY);
  useAuthStore.setState(initialAuthState, true);
});

afterEach(() => {
  cleanup();
});

describe("CheckoutPage — cold reload", () => {
  test("a probe that resolves present shortly after mount proceeds to checkout", async () => {
    // The reload window: signed in, platform liveness not yet known.
    useAuthStore.setState({
      sessionStatus: "authenticated",
      platformSession: "unknown",
    });

    const { getByLabelText, getByTestId } = renderCheckout();

    // Nothing is decided yet, so the route holds rather than bailing — a bail
    // here throws away a session that is about to confirm.
    getByLabelText("Preparing checkout");
    expect(upgradeCalls.length).toBe(0);
    expect(getByTestId("loc").textContent).toBe(ENTRY);

    act(() => {
      useAuthStore.setState({ platformSession: "present" });
    });

    await waitFor(() => expect(upgradeCalls.length).toBe(1));
    await waitFor(() => expect(openedUrl).toBe(CHECKOUT_URL));
    expect(getByTestId("loc").textContent).toBe(ENTRY);
  });

  test("a settled-absent session still bails to plans and drops the stash", async () => {
    useAuthStore.setState({
      sessionStatus: "unauthenticated",
      platformSession: "absent",
    });
    saveCheckoutIntent({
      kind: "package",
      packageKey: "super",
      resumeAfterOnboarding: true,
    });

    const { getByTestId } = renderCheckout();

    await waitFor(() =>
      expect(getByTestId("loc").textContent).toBe("/assistant/plans"),
    );
    expect(upgradeCalls.length).toBe(0);
    expect(openedUrl).toBeNull();
    expect(sessionStorage.getItem(INTENT_KEY)).toBeNull();
  });
});
