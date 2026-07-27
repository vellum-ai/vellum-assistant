/**
 * Tests for the deep-link CheckoutPage.
 *
 * Mirrors plans-page.test.tsx's interaction harness: the generated SDK, the
 * browser runtime, and the platform gate are `mock.module()`'d, and
 * `CheckoutPage` is dynamically imported after the mocks register. A
 * `LocationProbe` reads the router location so redirects can be asserted.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";

import { saveCheckoutIntent } from "@/lib/billing/checkout-intent";
import * as sdkGen from "@/generated/api/sdk.gen";
import * as browserRuntime from "@/runtime/browser";
import * as orgReadyMod from "@/hooks/use-is-org-ready";
import * as platformGateMod from "@/hooks/use-platform-gate";
import type { PlatformGateState } from "@/hooks/use-platform-gate";
import * as takeoverMod from "@/hooks/use-marketing-pricing-takeover";
import type { MarketingPricingTakeoverState } from "@/hooks/use-marketing-pricing-takeover";

const CHECKOUT_URL = "https://stripe.test/checkout/session";
const INTENT_KEY = "vellum.pro-checkout-intent";

type Captured = { body?: unknown };
const upgradeCalls: Captured[] = [];
let openedUrl: string | null = null;
// Gate value the mocked `usePlatformGate` returns (default: session-only full).
let gateValue: PlatformGateState = "full";
// Org-readiness the mocked `useIsOrgReady` returns (default: hydrated/ready).
let orgReadyValue = true;
// `marketing-pricing-takeover` state (default: funnel on).
let takeoverValue: MarketingPricingTakeoverState = "enabled";
// When true the upgrade rejects — drives the error path. Otherwise it resolves
// with `upgradeData`.
let upgradeRejects = false;
let upgradeData: { status: string; checkout_url: string | null; message: string } = {
  status: "redirect",
  checkout_url: CHECKOUT_URL,
  message: "",
};

mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  organizationsBillingSubscriptionUpgradeCreate: (opts: Captured) => {
    upgradeCalls.push(opts);
    if (upgradeRejects) {
      return Promise.reject(new Error("checkout failed"));
    }
    return Promise.resolve({ data: upgradeData, response: { ok: true } });
  },
}));

mock.module("@/runtime/browser", () => ({
  ...browserRuntime,
  openUrl: (url: string) => {
    openedUrl = url;
    return Promise.resolve();
  },
}));

mock.module("@/hooks/use-platform-gate", () => ({
  ...platformGateMod,
  usePlatformGate: () => gateValue,
}));

mock.module("@/hooks/use-is-org-ready", () => ({
  ...orgReadyMod,
  useIsOrgReady: () => orgReadyValue,
}));

mock.module("@/hooks/use-marketing-pricing-takeover", () => ({
  ...takeoverMod,
  useMarketingPricingTakeover: () => takeoverValue,
}));

const { CheckoutPage } = await import("./checkout-page");

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="loc">{location.pathname + location.search}</div>;
}

function renderCheckout(entry: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <QueryClientProvider client={client}>
        <CheckoutPage />
      </QueryClientProvider>
      <LocationProbe />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  upgradeCalls.length = 0;
  openedUrl = null;
  gateValue = "full";
  orgReadyValue = true;
  takeoverValue = "enabled";
  upgradeRejects = false;
  upgradeData = { status: "redirect", checkout_url: CHECKOUT_URL, message: "" };
  sessionStorage.removeItem(INTENT_KEY);
});

afterEach(() => {
  cleanup();
});

describe("CheckoutPage", () => {
  test("valid package + full gate fires the upgrade, stashes intent, opens Stripe", async () => {
    renderCheckout("/assistant/checkout?package=super");

    await waitFor(() => expect(upgradeCalls.length).toBe(1));
    expect(upgradeCalls[0]!.body).toEqual({
      target_plan_id: "pro",
      package: "super",
      confirm: true,
      return_target: "web",
    });

    await waitFor(() => expect(openedUrl).toBe(CHECKOUT_URL));
    // The package intent is stashed before the redirect so the post-checkout
    // provisioning screen can render it.
    const stashed = sessionStorage.getItem(INTENT_KEY);
    expect(stashed).not.toBeNull();
    expect(JSON.parse(stashed!)).toMatchObject({
      kind: "package",
      packageKey: "super",
    });
  });

  test("holds the upgrade until org is ready, then fires once it hydrates", async () => {
    orgReadyValue = false;
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    // A fresh element each render so the rerender doesn't hit React's
    // same-reference bailout and actually re-reads the org-readiness value.
    const makeTree = () => (
      <MemoryRouter initialEntries={["/assistant/checkout?package=super"]}>
        <QueryClientProvider client={client}>
          <CheckoutPage />
        </QueryClientProvider>
        <LocationProbe />
      </MemoryRouter>
    );
    const { getByLabelText, getByTestId, rerender } = render(makeTree());

    // Org store not yet hydrated: the spinner shows, nothing fires, and the
    // route holds instead of redirecting.
    getByLabelText("Preparing checkout");
    expect(upgradeCalls.length).toBe(0);
    expect(getByTestId("loc").textContent).toBe(
      "/assistant/checkout?package=super",
    );

    // Once the org id lands, the upgrade fires exactly once.
    orgReadyValue = true;
    rerender(makeTree());
    await waitFor(() => expect(upgradeCalls.length).toBe(1));
  });

  test("a no_op result navigates to plans and clears any marked stash", async () => {
    upgradeData = { status: "no_op", checkout_url: null, message: "" };
    // A marked stash from the onboarding signup carry survives into this bounce;
    // the already-Pro no_op must clear it rather than leave it lingering its TTL.
    saveCheckoutIntent({
      kind: "package",
      packageKey: "super",
      resumeAfterOnboarding: true,
    });
    const { getByTestId } = renderCheckout("/assistant/checkout?package=super");

    await waitFor(() => expect(upgradeCalls.length).toBe(1));
    await waitFor(() =>
      expect(getByTestId("loc").textContent).toBe("/assistant/plans"),
    );
    expect(openedUrl).toBeNull();
    expect(sessionStorage.getItem(INTENT_KEY)).toBeNull();
  });

  test("an error renders the retry UI, and Try again re-fires the upgrade", async () => {
    upgradeRejects = true;
    const { findByRole } = renderCheckout("/assistant/checkout?package=super");

    await waitFor(() => expect(upgradeCalls.length).toBe(1));
    // The error state offers a retry and a non-dead-end escape to plans.
    await findByRole("button", { name: "Try again" });
    await findByRole("link", { name: "View plans" });

    fireEvent.click(await findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(upgradeCalls.length).toBe(2));
  });

  test("missing package navigates to plans without firing the upgrade", async () => {
    const { getByTestId } = renderCheckout("/assistant/checkout");

    await waitFor(() =>
      expect(getByTestId("loc").textContent).toBe("/assistant/plans"),
    );
    expect(upgradeCalls.length).toBe(0);
  });

  test("a gated session skips the upgrade and falls back to plans", async () => {
    gateValue = "gated";
    const { getByTestId } = renderCheckout("/assistant/checkout?package=super");

    await waitFor(() =>
      expect(getByTestId("loc").textContent).toBe("/assistant/plans"),
    );
    expect(upgradeCalls.length).toBe(0);
  });

  test("the pricing funnel switched off redirects to plans without charging", async () => {
    takeoverValue = "disabled";
    const { getByTestId } = renderCheckout("/assistant/checkout?package=super");

    await waitFor(() =>
      expect(getByTestId("loc").textContent).toBe("/assistant/plans"),
    );
    // A link cached from while the funnel was on must not start a purchase.
    expect(upgradeCalls.length).toBe(0);
    expect(openedUrl).toBeNull();
    expect(sessionStorage.getItem(INTENT_KEY)).toBeNull();
  });

  test("holds while the funnel flag is unresolved, then fires once it lands", async () => {
    takeoverValue = "pending";
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const makeTree = () => (
      <MemoryRouter initialEntries={["/assistant/checkout?package=super"]}>
        <QueryClientProvider client={client}>
          <CheckoutPage />
        </QueryClientProvider>
        <LocationProbe />
      </MemoryRouter>
    );
    const { getByLabelText, getByTestId, rerender } = render(makeTree());

    // The flag defaults off, so an unresolved value must neither fire checkout
    // nor bounce — bouncing here would strand every cold-loaded deep link.
    getByLabelText("Preparing checkout");
    expect(upgradeCalls.length).toBe(0);
    expect(getByTestId("loc").textContent).toBe(
      "/assistant/checkout?package=super",
    );

    takeoverValue = "enabled";
    rerender(makeTree());
    await waitFor(() => expect(upgradeCalls.length).toBe(1));
  });
});
