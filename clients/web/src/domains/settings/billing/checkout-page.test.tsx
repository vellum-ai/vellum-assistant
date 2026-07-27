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
import { MemoryRouter, Route, Routes, useLocation } from "react-router";

import { saveCheckoutIntent } from "@/lib/billing/checkout-intent";
import * as sdkGen from "@/generated/api/sdk.gen";
import * as browserRuntime from "@/runtime/browser";
import * as orgReadyMod from "@/hooks/use-is-org-ready";
import * as platformGateMod from "@/hooks/use-platform-gate";
import type { PlatformGateStateWithPending } from "@/hooks/use-platform-gate";
import * as takeoverMod from "@/hooks/use-marketing-pricing-takeover";
import type { MarketingPricingTakeoverState } from "@/hooks/use-marketing-pricing-takeover";

const CHECKOUT_URL = "https://stripe.test/checkout/session";
const INTENT_KEY = "vellum.pro-checkout-intent";
// An onboarding hand-off: the package plus the onboarding step Start would
// otherwise have taken, so a checkout that doesn't happen resumes the funnel.
const ONBOARDING_NEXT = "/assistant/onboarding/research?hosting=managed";
const ONBOARDING_ENTRY = `/assistant/checkout?package=super&continue=${encodeURIComponent(ONBOARDING_NEXT)}`;

type Captured = { body?: unknown };
const upgradeCalls: Captured[] = [];
let openedUrl: string | null = null;
// Gate value the mocked `usePlatformGateWithPending` returns (default:
// session-only full).
let gateValue: PlatformGateStateWithPending = "full";
// Org-readiness the mocked `useIsOrgReady` returns (default: hydrated/ready).
let orgReadyValue = true;
// `marketing-pricing-takeover` state (default: funnel on).
let takeoverValue: MarketingPricingTakeoverState = "enabled";
// When true the upgrade rejects — drives the error path. Otherwise it resolves
// with `upgradeData`.
let upgradeRejects = false;
// When true the upgrade hangs until `releaseUpgrade()` — the mid-flight window
// where a flag flip and the response race.
let holdUpgrade = false;
let releaseUpgrade: (() => void) | null = null;
let heldUpgrade: Promise<unknown> | null = null;
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
    if (holdUpgrade) {
      heldUpgrade = new Promise((resolve) => {
        releaseUpgrade = () =>
          resolve({ data: upgradeData, response: { ok: true } });
      });
      return heldUpgrade;
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
  usePlatformGateWithPending: () => gateValue,
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

function freshQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

/**
 * The page mounted at its own path, matching `routes.tsx`. Rendering it
 * unconditionally would leave it mounted after it redirects, where it re-reads
 * the *destination's* search params and redirects a second time.
 */
function checkoutTree(entry: string, client: QueryClient) {
  return (
    <MemoryRouter initialEntries={[entry]}>
      <QueryClientProvider client={client}>
        <Routes>
          <Route path="/assistant/checkout" element={<CheckoutPage />} />
          <Route path="*" element={null} />
        </Routes>
      </QueryClientProvider>
      <LocationProbe />
    </MemoryRouter>
  );
}

function renderCheckout(entry: string) {
  return render(checkoutTree(entry, freshQueryClient()));
}

/**
 * Run every pending microtask, so a released upgrade's continuation has fully
 * settled before a test asserts that it did nothing. A `setTimeout` macrotask
 * is scheduled behind the whole microtask queue the promise chain runs on.
 */
function flushPending(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

beforeEach(() => {
  upgradeCalls.length = 0;
  openedUrl = null;
  gateValue = "full";
  orgReadyValue = true;
  takeoverValue = "enabled";
  upgradeRejects = false;
  holdUpgrade = false;
  releaseUpgrade = null;
  heldUpgrade = null;
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
    const client = freshQueryClient();
    // A fresh element each render so the rerender doesn't hit React's
    // same-reference bailout and actually re-reads the org-readiness value.
    const makeTree = () =>
      checkoutTree("/assistant/checkout?package=super", client);
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

  test("the error escape falls back to plans and drops the stash", async () => {
    upgradeRejects = true;
    saveCheckoutIntent({
      kind: "package",
      packageKey: "super",
      resumeAfterOnboarding: true,
    });
    const { findByRole, getByTestId } = renderCheckout(
      "/assistant/checkout?package=super",
    );

    // No continuation carried, so the escape is literally the plans takeover.
    fireEvent.click(await findByRole("link", { name: "View plans" }));

    await waitFor(() =>
      expect(getByTestId("loc").textContent).toBe("/assistant/plans"),
    );
    expect(sessionStorage.getItem(INTENT_KEY)).toBeNull();
  });

  test("the error escape resumes the carried onboarding step", async () => {
    upgradeRejects = true;
    // The signup carry's marked stash survives into the failure. Walking away
    // must not leave it for the privacy screen to resume checkout from.
    saveCheckoutIntent({
      kind: "package",
      packageKey: "super",
      resumeAfterOnboarding: true,
    });
    const { findByRole, getByTestId, queryByRole } =
      renderCheckout(ONBOARDING_ENTRY);

    // Mid-onboarding the escape goes back to onboarding, and says so.
    const escape = await findByRole("link", { name: "Continue setup" });
    expect(queryByRole("link", { name: "View plans" })).toBeNull();

    fireEvent.click(escape);

    await waitFor(() =>
      expect(getByTestId("loc").textContent).toBe(ONBOARDING_NEXT),
    );
    expect(sessionStorage.getItem(INTENT_KEY)).toBeNull();
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
    saveCheckoutIntent({
      kind: "package",
      packageKey: "super",
      resumeAfterOnboarding: true,
    });
    const { getByTestId } = renderCheckout("/assistant/checkout?package=super");

    await waitFor(() =>
      expect(getByTestId("loc").textContent).toBe("/assistant/plans"),
    );
    expect(upgradeCalls.length).toBe(0);
    expect(sessionStorage.getItem(INTENT_KEY)).toBeNull();
  });

  test("an unsettled session holds, then fires once it resolves", async () => {
    // The cold-reload window. The probe has not answered, so nothing here is
    // decided: bouncing would drop a deep link a moment before it becomes
    // valid, and firing would send a request no session backs.
    gateValue = "pending";
    const client = freshQueryClient();
    const makeTree = () =>
      checkoutTree("/assistant/checkout?package=super", client);
    const { getByLabelText, getByTestId, rerender } = render(makeTree());

    getByLabelText("Preparing checkout");
    expect(upgradeCalls.length).toBe(0);
    expect(getByTestId("loc").textContent).toBe(
      "/assistant/checkout?package=super",
    );

    gateValue = "full";
    rerender(makeTree());
    await waitFor(() => expect(upgradeCalls.length).toBe(1));
  });

  test("an unsettled session that resolves to no login bails and drops the stash", async () => {
    // The other end of the same window: once the probe settles absent, the
    // gate's bounded `"pending"` is over and the bail happens as it always did.
    gateValue = "pending";
    saveCheckoutIntent({
      kind: "package",
      packageKey: "super",
      resumeAfterOnboarding: true,
    });
    const client = freshQueryClient();
    const makeTree = () =>
      checkoutTree("/assistant/checkout?package=super", client);
    const { getByTestId, rerender } = render(makeTree());

    gateValue = "disabled";
    rerender(makeTree());

    await waitFor(() =>
      expect(getByTestId("loc").textContent).toBe("/assistant/plans"),
    );
    expect(upgradeCalls.length).toBe(0);
    expect(sessionStorage.getItem(INTENT_KEY)).toBeNull();
  });

  test("a session without a platform login drops the stash on the way out", async () => {
    gateValue = "disabled";
    // The signup carry's marked stash is still in place: the hand-off, which
    // rewrites it without the marker, never ran. Nothing was bought, so the
    // stash must not outlive the attempt.
    saveCheckoutIntent({
      kind: "package",
      packageKey: "super",
      resumeAfterOnboarding: true,
    });
    const { getByTestId } = renderCheckout(ONBOARDING_ENTRY);

    await waitFor(() =>
      expect(getByTestId("loc").textContent).toBe(ONBOARDING_NEXT),
    );
    expect(upgradeCalls.length).toBe(0);
    expect(openedUrl).toBeNull();
    expect(sessionStorage.getItem(INTENT_KEY)).toBeNull();
  });

  test("the hand-off rewrites a marked stash without the marker", async () => {
    // The invariant the provisioning takeover reads the marker against: the
    // hand-off replaces the record wholesale, so a stash that reaches the
    // post-checkout return is always unmarked, and one that still carries the
    // marker is proof no checkout ever handed off.
    saveCheckoutIntent({
      kind: "package",
      packageKey: "super",
      resumeAfterOnboarding: true,
    });
    renderCheckout(ONBOARDING_ENTRY);

    await waitFor(() => expect(openedUrl).toBe(CHECKOUT_URL));
    const stashed = JSON.parse(sessionStorage.getItem(INTENT_KEY)!);
    expect(stashed).toMatchObject({ kind: "package", packageKey: "super" });
    expect(stashed.resumeAfterOnboarding).toBeUndefined();
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

  test("the funnel switched off mid-flight drops the late redirect", async () => {
    holdUpgrade = true;
    const client = freshQueryClient();
    const makeTree = () =>
      checkoutTree("/assistant/checkout?package=super", client);
    const { getByTestId, rerender } = render(makeTree());

    await waitFor(() => expect(upgradeCalls.length).toBe(1));

    // The kill switch lands while the upgrade is still in flight.
    takeoverValue = "disabled";
    rerender(makeTree());
    await waitFor(() =>
      expect(getByTestId("loc").textContent).toBe("/assistant/plans"),
    );

    // The response arrives after the bail: it must neither open Stripe nor
    // re-stash the package the bail just dropped.
    releaseUpgrade!();
    await heldUpgrade;
    await flushPending();
    expect(openedUrl).toBeNull();
    expect(sessionStorage.getItem(INTENT_KEY)).toBeNull();
  });

  test("the funnel switched off after the hand-off keeps the stash", async () => {
    const client = freshQueryClient();
    const makeTree = () =>
      checkoutTree("/assistant/checkout?package=super", client);
    const { getByTestId, rerender } = render(makeTree());

    await waitFor(() => expect(openedUrl).toBe(CHECKOUT_URL));

    // Electron and native Capacitor open Stripe without unloading the page, so
    // the flag flip reaches a route that is still mounted. The intent belongs
    // to the return trip by now — the kill switch must not delete it, and must
    // not navigate out from under the checkout in progress.
    takeoverValue = "disabled";
    rerender(makeTree());
    await flushPending();

    expect(JSON.parse(sessionStorage.getItem(INTENT_KEY)!)).toMatchObject({
      kind: "package",
      packageKey: "super",
    });
    expect(getByTestId("loc").textContent).toBe(
      "/assistant/checkout?package=super",
    );
  });

  test("a pending→disabled transition resumes the carried onboarding step", async () => {
    // The funnel-dropout race: a new user clicks Start before the flag has
    // hydrated, onboarding hands off, and the flag then lands off. Bouncing to
    // plans would drop the user out of onboarding short of research/hatching,
    // so the continuation onboarding carried has to win here.
    takeoverValue = "pending";
    const client = freshQueryClient();
    const makeTree = () => checkoutTree(ONBOARDING_ENTRY, client);
    const { getByTestId, rerender } = render(makeTree());

    expect(getByTestId("loc").textContent).toBe(ONBOARDING_ENTRY);

    takeoverValue = "disabled";
    rerender(makeTree());

    await waitFor(() =>
      expect(getByTestId("loc").textContent).toBe(ONBOARDING_NEXT),
    );
    expect(upgradeCalls.length).toBe(0);
    expect(openedUrl).toBeNull();
  });

  test("an already-off funnel returns to the continuation and drops the stash", async () => {
    takeoverValue = "disabled";
    // The marked stash from the signup carry is dead once the kill switch is
    // off — it must not resurface on a provisioning surface within its TTL.
    saveCheckoutIntent({
      kind: "package",
      packageKey: "super",
      resumeAfterOnboarding: true,
    });
    const { getByTestId } = renderCheckout(ONBOARDING_ENTRY);

    await waitFor(() =>
      expect(getByTestId("loc").textContent).toBe(ONBOARDING_NEXT),
    );
    expect(upgradeCalls.length).toBe(0);
    expect(sessionStorage.getItem(INTENT_KEY)).toBeNull();
  });

  test("a no_op result returns to the continuation when one is carried", async () => {
    // Already Pro mid-onboarding still needs an assistant — plans is not it.
    upgradeData = { status: "no_op", checkout_url: null, message: "" };
    const { getByTestId } = renderCheckout(ONBOARDING_ENTRY);

    await waitFor(() => expect(upgradeCalls.length).toBe(1));
    await waitFor(() =>
      expect(getByTestId("loc").textContent).toBe(ONBOARDING_NEXT),
    );
  });

  test("an off-site continuation is rejected in favor of plans", async () => {
    takeoverValue = "disabled";
    const { getByTestId } = renderCheckout(
      `/assistant/checkout?package=super&continue=${encodeURIComponent("https://evil.example.com/steal")}`,
    );

    await waitFor(() =>
      expect(getByTestId("loc").textContent).toBe("/assistant/plans"),
    );
  });

  test("holds while the funnel flag is unresolved, then fires once it lands", async () => {
    takeoverValue = "pending";
    const client = freshQueryClient();
    const makeTree = () =>
      checkoutTree("/assistant/checkout?package=super", client);
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
