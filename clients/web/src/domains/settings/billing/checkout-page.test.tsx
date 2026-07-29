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
import * as capacitorCore from "@capacitor/core";
import * as sdkGen from "@/generated/api/sdk.gen";
import * as browserRuntime from "@/runtime/browser";
import * as orgReadyMod from "@/hooks/use-is-org-ready";
import type { OrgHeaderReadiness } from "@/hooks/use-is-org-ready";
import * as platformGateMod from "@/hooks/use-platform-gate";
import type { PlatformGateStateWithPending } from "@/hooks/use-platform-gate";
import * as takeoverMod from "@/hooks/use-marketing-pricing-takeover";
import type { MarketingPricingTakeoverState } from "@/hooks/use-marketing-pricing-takeover";
import type { CharacterTraits } from "@/types/avatar";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";

const CHECKOUT_URL = "https://stripe.test/checkout/session";
const INTENT_KEY = "vellum.pro-checkout-intent";
// An onboarding hand-off: the package plus the onboarding step Start would
// otherwise have taken, so a checkout that doesn't happen resumes the funnel.
const ONBOARDING_NEXT = "/assistant/onboarding/research?hosting=managed";
const ONBOARDING_ENTRY = `/assistant/checkout?package=super&continue=${encodeURIComponent(ONBOARDING_NEXT)}`;
// The package-less encoding: the same funnel carrying a custom tier config.
const CUSTOM_ENTRY =
  "/assistant/checkout?machine_tier=large&storage_tier=s&credit_tier=credits_50";

type Captured = { body?: unknown };
const upgradeCalls: Captured[] = [];
let openedUrl: string | null = null;
// Gate value the mocked `usePlatformGateWithPending` returns (default:
// session-only full).
let gateValue: PlatformGateStateWithPending = "full";
// Org-header readiness the mocked hooks report (default: hydrated/ready).
let orgReadinessValue: OrgHeaderReadiness = "ready";
// Re-runs of the org fetch, which is what a retry with no organization does.
let fetchOrganizationsCalls = 0;
// `marketing-pricing-takeover` state (default: funnel on).
let takeoverValue: MarketingPricingTakeoverState = "enabled";
// Drives `Capacitor.isNativePlatform()`, which is what puts checkout in an
// `SFSafariViewController` that leaves this route mounted underneath it.
let nativePlatform = false;
// When true the upgrade rejects — drives the error path. Otherwise it resolves
// with `upgradeData`.
let upgradeRejects = false;
// When true the upgrade hangs until `releaseUpgrade()` — the mid-flight window
// where a flag flip and the response race.
let holdUpgrade = false;
let releaseUpgrade: (() => void) | null = null;
let heldUpgrade: Promise<unknown> | null = null;
let upgradeData: {
  status: string;
  checkout_url: string | null;
  message: string;
} = {
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

mock.module("@capacitor/core", () => ({
  ...capacitorCore,
  Capacitor: {
    ...capacitorCore.Capacitor,
    isNativePlatform: () => nativePlatform,
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
  useOrgHeaderReadiness: () => orgReadinessValue,
  // The real derivation, so the boolean gate and the tri-state can never
  // disagree about the same store state.
  useIsOrgReady: () => orgReadinessValue === "ready",
}));

mock.module("@/hooks/use-marketing-pricing-takeover", () => ({
  ...takeoverMod,
  useMarketingPricingTakeover: () => takeoverValue,
}));

const { useOrganizationStore } = await import("@/stores/organization-store");
const { useResolvedAssistantsStore } =
  await import("@/stores/resolved-assistants-store");
const { avatarQueryKey } = await import("@/hooks/use-assistant-avatar");
const {
  clearTakeoverAvatarStash,
  readTakeoverAvatarStash,
  saveTakeoverAvatarStash,
} = await import("@/lib/billing/takeover-avatar-stash");
const { CheckoutPage } = await import("./checkout-page");

const AVATAR_TRAITS: CharacterTraits = {
  bodyShape: "blob",
  eyeStyle: "curious",
  color: "purple",
};

/**
 * The cached avatar the hand-off snapshots. The live query key appends a
 * `supportsManifest` boolean, so the seed has to carry one too.
 */
function seedCachedAvatar(client: QueryClient, assistantId: string) {
  client.setQueryData([...avatarQueryKey(assistantId), true], {
    components: BUNDLED_COMPONENTS,
    traits: AVATAR_TRAITS,
    customImageUrl: null,
  });
}

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
  orgReadinessValue = "ready";
  takeoverValue = "enabled";
  nativePlatform = false;
  delete (window as { vellum?: unknown }).vellum;
  fetchOrganizationsCalls = 0;
  useOrganizationStore.setState({
    fetchOrganizations: async () => {
      fetchOrganizationsCalls += 1;
    },
  });
  upgradeRejects = false;
  holdUpgrade = false;
  releaseUpgrade = null;
  heldUpgrade = null;
  upgradeData = { status: "redirect", checkout_url: CHECKOUT_URL, message: "" };
  sessionStorage.removeItem(INTENT_KEY);
  // The line above only drops the intent key, so clear the avatar stash's own.
  clearTakeoverAvatarStash();
  useResolvedAssistantsStore.setState({
    activeAssistantId: null,
    assistants: [],
    assistantsHydrated: false,
  });
});

afterEach(() => {
  cleanup();
});

describe("CheckoutPage", () => {
  test("valid package + full gate fires the upgrade, stashes intent and avatar, opens Stripe", async () => {
    const client = freshQueryClient();
    seedCachedAvatar(client, "a1");
    // Capture only stashes for a hydrated list holding exactly one assistant.
    useResolvedAssistantsStore.setState({
      activeAssistantId: "a1",
      assistants: [{ id: "a1", isLocal: false, isPlatformHosted: true }],
      assistantsHydrated: true,
    });
    render(checkoutTree("/assistant/checkout?package=super", client));

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
    // The avatar goes with it, so the post-checkout takeover can draw the
    // creature on a cold return instead of holding an empty stage.
    expect(readTakeoverAvatarStash()?.assistantId).toBe("a1");
  });

  test("holds the upgrade while org is resolving, then fires once it hydrates", async () => {
    orgReadinessValue = "resolving";
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
    orgReadinessValue = "ready";
    rerender(makeTree());
    await waitFor(() => expect(upgradeCalls.length).toBe(1));
    await flushPending();
    expect(upgradeCalls.length).toBe(1);
  });

  test("an org id that is never coming reaches the retry, not the spinner", async () => {
    // Org resolution settled terminally in `error` with nothing persisted, so
    // the header the upgrade needs is not on its way — waiting here is waiting
    // forever.
    orgReadinessValue = "unavailable";
    const { findByRole, getByTestId, queryByLabelText } = renderCheckout(
      "/assistant/checkout?package=super",
    );

    await findByRole("button", { name: "Try again" });
    await findByRole("link", { name: "View plans" });
    expect(queryByLabelText("Preparing checkout")).toBeNull();
    // Deciding must not mean sending the request anyway: without
    // `Vellum-Organization-Id` the upgrade fails.
    expect(upgradeCalls.length).toBe(0);
    expect(getByTestId("loc").textContent).toBe(
      "/assistant/checkout?package=super",
    );
  });

  test("Try again with no organization re-runs org resolution, then checks out", async () => {
    orgReadinessValue = "unavailable";
    const client = freshQueryClient();
    const makeTree = () =>
      checkoutTree("/assistant/checkout?package=super", client);
    const { findByRole, rerender } = render(makeTree());

    fireEvent.click(await findByRole("button", { name: "Try again" }));

    // Retrying what actually failed is the org fetch — re-sending an upgrade
    // that still can't name an organization fails the same way.
    expect(fetchOrganizationsCalls).toBe(1);
    expect(upgradeCalls.length).toBe(0);

    orgReadinessValue = "ready";
    rerender(makeTree());
    await waitFor(() => expect(upgradeCalls.length).toBe(1));
  });

  test("a no_op result navigates to plans carrying the package and clears any marked stash", async () => {
    upgradeData = { status: "no_op", checkout_url: null, message: "" };
    // A marked stash from the onboarding signup carry survives into this bounce;
    // the already-Pro no_op must clear it rather than leave it lingering its TTL.
    saveCheckoutIntent({
      kind: "package",
      packageKey: "super",
      resumeAfterOnboarding: true,
    });
    saveTakeoverAvatarStash({
      assistantId: "a1",
      components: BUNDLED_COMPONENTS,
      traits: AVATAR_TRAITS,
    });
    const { getByTestId } = renderCheckout("/assistant/checkout?package=super");

    await waitFor(() => expect(upgradeCalls.length).toBe(1));
    // Already Pro is an upgrade request plans can still honor, in place.
    await waitFor(() =>
      expect(getByTestId("loc").textContent).toBe(
        "/assistant/plans?package=super",
      ),
    );
    expect(openedUrl).toBeNull();
    expect(sessionStorage.getItem(INTENT_KEY)).toBeNull();
    // The avatar snapshot is stashed for a checkout return that is no longer
    // coming, so it goes out with the intent.
    expect(readTakeoverAvatarStash()).toBeNull();
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
    saveTakeoverAvatarStash({
      assistantId: "a1",
      components: BUNDLED_COMPONENTS,
      traits: AVATAR_TRAITS,
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
    expect(readTakeoverAvatarStash()).toBeNull();
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
    saveTakeoverAvatarStash({
      assistantId: "a1",
      components: BUNDLED_COMPONENTS,
      traits: AVATAR_TRAITS,
    });
    const { getByTestId } = renderCheckout(ONBOARDING_ENTRY);

    await waitFor(() =>
      expect(getByTestId("loc").textContent).toBe(ONBOARDING_NEXT),
    );
    expect(upgradeCalls.length).toBe(0);
    expect(openedUrl).toBeNull();
    expect(sessionStorage.getItem(INTENT_KEY)).toBeNull();
    // The avatar snapshot is stashed for a checkout that never happened, so the
    // bail drops it alongside the intent.
    expect(readTakeoverAvatarStash()).toBeNull();
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

  test("a dismissed native sheet lands on the reopen/escape page, not a spinner", async () => {
    nativePlatform = true;
    const { findByRole, queryByLabelText } = renderCheckout(
      "/assistant/checkout?package=super",
    );

    await waitFor(() => expect(openedUrl).toBe(CHECKOUT_URL));
    expect(upgradeCalls[0]!.body).toMatchObject({ return_target: "native" });

    // `SFSafariViewController` covers the app without unloading this route, and
    // the only thing a dismissal delivers is `browserFinished` — no deep-link
    // return, no navigation. So whatever the hand-off rendered is exactly what
    // the user comes back to, and it has to be something they can act on.
    await findByRole("button", { name: "Reopen checkout" });
    await findByRole("link", { name: "View plans" });
    expect(queryByLabelText("Preparing checkout")).toBeNull();
  });

  test("the hand-off page leaves the stash and the route to the return trip", async () => {
    nativePlatform = true;
    const { findByRole, getByTestId } = renderCheckout(
      "/assistant/checkout?package=super",
    );

    await findByRole("button", { name: "Reopen checkout" });
    await flushPending();

    // A completed checkout comes back as a deep link and reads this stash. The
    // hand-off page can't tell that apart from an abandoned sheet, so it settles
    // nothing: the stash stays and the route stays where the hand-off left it.
    expect(JSON.parse(sessionStorage.getItem(INTENT_KEY)!)).toMatchObject({
      kind: "package",
      packageKey: "super",
    });
    expect(getByTestId("loc").textContent).toBe(
      "/assistant/checkout?package=super",
    );
  });

  test("the hand-off escape walks away without dropping the stash", async () => {
    nativePlatform = true;
    const { findByRole, getByTestId } = renderCheckout(
      "/assistant/checkout?package=super",
    );

    fireEvent.click(await findByRole("link", { name: "View plans" }));

    await waitFor(() =>
      expect(getByTestId("loc").textContent).toBe("/assistant/plans"),
    );
    // Unlike the failure escape: a checkout that reached Stripe may still be
    // paid for, and the hand-off already rewrote the stash unmarked, so leaving
    // it can only help the return trip and can't resume anything on its own.
    expect(sessionStorage.getItem(INTENT_KEY)).not.toBeNull();
  });

  test("Reopen checkout re-runs the upgrade for a fresh Stripe session", async () => {
    nativePlatform = true;
    const { findByRole } = renderCheckout("/assistant/checkout?package=super");

    fireEvent.click(await findByRole("button", { name: "Reopen checkout" }));

    await waitFor(() => expect(upgradeCalls.length).toBe(2));
  });

  test("the Electron hand-off gets the same escape, having no dismissal signal", async () => {
    // `openUrlFinishedListener` is Capacitor-only, so closing the system browser
    // tells the shell nothing at all. The page behind it is the whole affordance.
    (window as { vellum?: unknown }).vellum = { platform: "electron" };
    const { findByRole } = renderCheckout("/assistant/checkout?package=super");

    await waitFor(() => expect(openedUrl).toBe(CHECKOUT_URL));
    expect(upgradeCalls[0]!.body).toMatchObject({ return_target: "native" });
    await findByRole("button", { name: "Reopen checkout" });
  });

  test("plain web hands off by unloading the tab and never renders the escape", async () => {
    const { getByLabelText, queryByRole } = renderCheckout(
      "/assistant/checkout?package=super",
    );

    await waitFor(() => expect(openedUrl).toBe(CHECKOUT_URL));
    await flushPending();

    // Same-tab navigation takes this route with it, so the spinner is the last
    // thing rendered and the escape would only ever flash before the unload.
    expect(upgradeCalls[0]!.body).toMatchObject({ return_target: "web" });
    getByLabelText("Preparing checkout");
    expect(queryByRole("button", { name: "Reopen checkout" })).toBeNull();
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

  test("a no_op result returns to the continuation verbatim, without the package", async () => {
    // Already Pro mid-onboarding still needs an assistant — plans is not it,
    // and the resume must not be diverted into the package switch modal.
    upgradeData = { status: "no_op", checkout_url: null, message: "" };
    const { getByTestId } = renderCheckout(ONBOARDING_ENTRY);

    await waitFor(() => expect(upgradeCalls.length).toBe(1));
    await waitFor(() =>
      expect(getByTestId("loc").textContent).toBe(ONBOARDING_NEXT),
    );
    expect(getByTestId("loc").textContent).not.toContain("package=");
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

  test("a custom tier configuration checks out with no package in the body", async () => {
    renderCheckout(CUSTOM_ENTRY);

    await waitFor(() => expect(upgradeCalls.length).toBe(1));
    // `package` is mutually exclusive with the tier fields server-side, so the
    // custom body carries the three dimensions and nothing else.
    expect(upgradeCalls[0]!.body).toEqual({
      target_plan_id: "pro",
      confirm: true,
      machine_tier: "large",
      storage_tier: "s",
      credit_tier: "credits_50",
      return_target: "web",
    });

    await waitFor(() => expect(openedUrl).toBe(CHECKOUT_URL));
    // The post-checkout provisioning takeover renders its per-dimension chips
    // off this stash, so it has to be written before the hand-off.
    expect(JSON.parse(sessionStorage.getItem(INTENT_KEY)!)).toMatchObject({
      kind: "custom",
      machineTier: "large",
      storageTier: "s",
      creditTier: "credits_50",
    });
  });

  test("omitted machine and credit params check out as the null baseline", async () => {
    renderCheckout("/assistant/checkout?storage_tier=xs");

    await waitFor(() => expect(upgradeCalls.length).toBe(1));
    // Small machine, no credit bundle: the endpoint reads those as explicit
    // nulls, not as fields to leave off.
    expect(upgradeCalls[0]!.body).toEqual({
      target_plan_id: "pro",
      confirm: true,
      machine_tier: null,
      storage_tier: "xs",
      credit_tier: null,
      return_target: "web",
    });

    await waitFor(() => expect(openedUrl).toBe(CHECKOUT_URL));
    expect(JSON.parse(sessionStorage.getItem(INTENT_KEY)!)).toMatchObject({
      kind: "custom",
      machineTier: null,
      storageTier: "xs",
      creditTier: null,
    });
  });

  test("an explicit package wins over tier params on the same URL", async () => {
    renderCheckout(
      "/assistant/checkout?package=super&machine_tier=large&storage_tier=s",
    );

    await waitFor(() => expect(upgradeCalls.length).toBe(1));
    // A body carrying both is a 400, so the client picks one side of the
    // mutual exclusion rather than passing the conflict along.
    expect(upgradeCalls[0]!.body).toEqual({
      target_plan_id: "pro",
      package: "super",
      confirm: true,
      return_target: "web",
    });

    await waitFor(() => expect(openedUrl).toBe(CHECKOUT_URL));
    expect(JSON.parse(sessionStorage.getItem(INTENT_KEY)!)).toMatchObject({
      kind: "package",
      packageKey: "super",
    });
  });

  test("tier params the endpoint would reject bail out and drop the stash", async () => {
    // Legacy `xxl` storage 400s server-side. A mangled link has to bail rather
    // than check out some other configuration the user never chose.
    saveCheckoutIntent({
      kind: "package",
      packageKey: "super",
      resumeAfterOnboarding: true,
    });
    const { getByTestId } = renderCheckout(
      "/assistant/checkout?machine_tier=large&storage_tier=xxl",
    );

    await waitFor(() =>
      expect(getByTestId("loc").textContent).toBe("/assistant/plans"),
    );
    expect(upgradeCalls.length).toBe(0);
    expect(openedUrl).toBeNull();
    expect(sessionStorage.getItem(INTENT_KEY)).toBeNull();
  });

  test("a no_op on a custom configuration falls back to plans", async () => {
    // Already Pro: the upgrade endpoint no-ops instead of minting a session,
    // for a custom body exactly as it does for a package.
    upgradeData = { status: "no_op", checkout_url: null, message: "" };
    const { getByTestId } = renderCheckout(CUSTOM_ENTRY);

    await waitFor(() => expect(upgradeCalls.length).toBe(1));
    await waitFor(() =>
      expect(getByTestId("loc").textContent).toBe("/assistant/plans"),
    );
    expect(openedUrl).toBeNull();
    expect(sessionStorage.getItem(INTENT_KEY)).toBeNull();
  });
});
