/**
 * Tests for `useSetupIntentReturn`: the SetupIntent params Stripe appends to
 * the `return_url` after an off-page 3DS challenge are read once, resolved
 * through Stripe.js into `useSetupIntentReturnStore`, and stripped from the
 * URL without disturbing the hash or any unrelated param.
 *
 * Strategy: mock the shared Stripe client so `retrieveSetupIntent` is driven
 * from the test (a real one needs Stripe.js and a live intent), mock the
 * saved-card sync so the confirm endpoint is not called, and mock the
 * org-readiness gate so a test can hold the resolution the way a hydrating org
 * store does (with a short settle ceiling, so the bounded wait is observable).
 * The platform-session half of that gate is driven through the real auth
 * store. The real `setupIntentIdFromClientSecret` is kept, so the id the sync
 * is handed is parsed the way it is in the app.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router";

import * as savedSyncModule from "@/domains/settings/hooks/use-payment-method-saved-poll";
import type { SavedPaymentMethod } from "@/domains/settings/hooks/use-payment-method-saved-poll";
import type { OrgHeaderReadiness } from "@/hooks/use-is-org-ready";
import { useAuthStore, type AuthUser } from "@/stores/auth-store";
import { useOrganizationStore } from "@/stores/organization-store";

// Keeps the real stripe-client below from injecting a Stripe.js script tag
// into happy-dom when it is imported.
mock.module("@stripe/stripe-js", () => ({
  loadStripe: () => Promise.resolve(null),
}));

const stripeClient = await import("@/domains/settings/billing/stripe-client");

interface RetrieveResult {
  setupIntent?: {
    status: string;
    last_setup_error?: { message?: string };
  };
  error?: { message?: string };
}

let stripeAvailable = true;
let getStripePromiseCalls = 0;
let retrieveCalls: string[] = [];
let retrieveResult: RetrieveResult = {};

mock.module("@/domains/settings/billing/stripe-client", () => ({
  ...stripeClient,
  getStripePromise: () => {
    getStripePromiseCalls += 1;
    if (!stripeAvailable) {
      return null;
    }
    return Promise.resolve({
      retrieveSetupIntent: (clientSecret: string) => {
        retrieveCalls.push(clientSecret);
        return Promise.resolve(retrieveResult);
      },
    });
  },
}));

let syncCalls: Array<{ setupIntentId: string | null }> = [];
let syncedCard: SavedPaymentMethod | null = null;
// Seam for the scope test: the confirm is where the resolution spends its
// time, so a switch that lands mid-flight lands here.
let onSync: (() => void) | null = null;

async function syncPaymentMethodSaved(args: { setupIntentId: string | null }) {
  syncCalls.push(args);
  onSync?.();
  return syncedCard;
}

mock.module("@/domains/settings/hooks/use-payment-method-saved-poll", () => ({
  ...savedSyncModule,
  usePaymentMethodSavedSync: () => syncPaymentMethodSaved,
}));

// Drives the org-header gate. The resolution confirms the SetupIntent
// server-side, so it waits out `"resolving"` the way the config query does.
// The real ceiling is 5s; a short one here keeps the bounded-wait case fast.
let orgReadiness: OrgHeaderReadiness = "ready";
mock.module("@/hooks/use-is-org-ready", () => ({
  getOrgHeaderReadiness: () => orgReadiness,
  ORG_HEADER_SETTLE_TIMEOUT_MS: 200,
}));

const { useSetupIntentReturn } = await import("./use-setup-intent-return");
const { useSetupIntentReturnStore } =
  await import("@/domains/settings/setup-intent-return-store");

/** The account a mid-resolution user switch lands on. */
const SWITCHED_USER: AuthUser = {
  kind: "platform",
  id: "u_2",
  username: "second",
  email: "second@example.com",
  isStaff: false,
  firstName: "Second",
  lastName: "User",
};

const RETURN_SEARCH =
  "?tab=billing&setup_intent=seti_1&setup_intent_client_secret=seti_1_secret_x&redirect_status=succeeded";
const STRIPPED_URL = "/assistant/settings/usage?tab=billing";
const CONFIRM_FAILED = "Failed to save payment method.";

function renderAt(search: string) {
  return renderHook(
    () => {
      useSetupIntentReturn();
      return useLocation();
    },
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <MemoryRouter initialEntries={[`/assistant/settings/usage${search}`]}>
          {children}
        </MemoryRouter>
      ),
    },
  );
}

type HookResult = ReturnType<typeof renderAt>["result"];

function currentUrl(result: HookResult): string {
  const { pathname, search, hash } = result.current;
  return pathname + search + hash;
}

function outcome() {
  return useSetupIntentReturnStore.getState().outcome;
}

function pending(): boolean {
  return useSetupIntentReturnStore.getState().pending;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Long enough for an ungated resolution to have run its Stripe read. */
async function flushResolution(): Promise<void> {
  await wait(30);
}

async function waitForOutcome(): Promise<void> {
  await waitFor(() => {
    if (outcome() == null) {
      throw new Error("outcome not resolved yet");
    }
  });
}

beforeEach(() => {
  stripeAvailable = true;
  getStripePromiseCalls = 0;
  retrieveCalls = [];
  retrieveResult = { setupIntent: { status: "succeeded" } };
  syncCalls = [];
  syncedCard = { brand: "visa", last4: "4242", autoReloadEnabled: false };
  onSync = null;
  orgReadiness = "ready";
  useOrganizationStore.setState({
    currentOrganizationId: null,
    persistedOrganizationId: null,
  });
  // Settled by default: the resolution holds until the platform-session probe
  // has answered, the way it does on a warm app. The identity half is reset
  // too, so a test that switches users mid-resolution leaves no scope behind.
  useAuthStore.setState({
    platformSession: "absent",
    sessionStatus: "initializing",
    user: null,
  });
  useSetupIntentReturnStore.setState({
    pending: false,
    outcome: null,
    scopeKey: null,
  });
});

afterEach(cleanup);

describe("useSetupIntentReturn", () => {
  test("resolves a succeeded return into the synced saved card", async () => {
    const { result } = renderAt(RETURN_SEARCH);
    await waitForOutcome();

    expect(outcome()).toEqual({
      kind: "saved",
      card: { brand: "visa", last4: "4242", autoReloadEnabled: false },
    });
    expect(retrieveCalls).toEqual(["seti_1_secret_x"]);
    expect(syncCalls).toEqual([{ setupIntentId: "seti_1" }]);
    expect(currentUrl(result)).toBe(STRIPPED_URL);
  });

  test("carries the SetupIntent's own error message when it did not succeed", async () => {
    retrieveResult = {
      setupIntent: {
        status: "requires_payment_method",
        last_setup_error: { message: "Your card was declined." },
      },
    };

    const { result } = renderAt(RETURN_SEARCH);
    await waitForOutcome();

    expect(outcome()).toEqual({
      kind: "error",
      message: "Your card was declined.",
    });
    expect(syncCalls).toEqual([]);
    expect(currentUrl(result)).toBe(STRIPPED_URL);
  });

  test("carries the retrieval error message when the intent cannot be read", async () => {
    retrieveResult = { error: { message: "No such setupintent." } };

    renderAt(RETURN_SEARCH);
    await waitForOutcome();

    expect(outcome()).toEqual({
      kind: "error",
      message: "No such setupintent.",
    });
  });

  test("falls back to the generic message when Stripe.js is unavailable", async () => {
    stripeAvailable = false;

    renderAt(RETURN_SEARCH);
    await waitForOutcome();

    expect(outcome()).toEqual({ kind: "error", message: CONFIRM_FAILED });
    expect(retrieveCalls).toEqual([]);
  });

  test("does nothing and never loads Stripe on a plain visit", () => {
    const { result } = renderAt("?tab=billing");

    expect(outcome()).toBeNull();
    expect(pending()).toBe(false);
    expect(getStripePromiseCalls).toBe(0);
    expect(currentUrl(result)).toBe(STRIPPED_URL);
  });

  test("strips only Stripe's params, keeping the hash and unrelated ones", () => {
    // An anchor deep link (`#daily-credit-limit`, from the daily-limit email)
    // has to survive a Stripe return, so the strip rebuilds the URL from the
    // live location instead of replacing it with the canonical billing route.
    const { result } = renderAt(`${RETURN_SEARCH}&foo=1#daily-credit-limit`);

    expect(currentUrl(result)).toBe(
      "/assistant/settings/usage?tab=billing&foo=1#daily-credit-limit",
    );
  });

  test("stays pending from the captured params until the outcome settles", async () => {
    orgReadiness = "resolving";
    renderAt(RETURN_SEARCH);

    expect(pending()).toBe(true);
    expect(outcome()).toBeNull();

    orgReadiness = "ready";
    await waitForOutcome();

    expect(pending()).toBe(false);
  });

  test("holds the resolution while the org header source is resolving", async () => {
    orgReadiness = "resolving";
    const { result } = renderAt(RETURN_SEARCH);

    // The params are already off the URL, so a reload cannot replay them.
    expect(currentUrl(result)).toBe(STRIPPED_URL);
    expect(getStripePromiseCalls).toBe(0);
    expect(retrieveCalls).toEqual([]);
    expect(syncCalls).toEqual([]);
    expect(outcome()).toBeNull();

    orgReadiness = "ready";
    await waitForOutcome();

    expect(outcome()).toEqual({
      kind: "saved",
      card: { brand: "visa", last4: "4242", autoReloadEnabled: false },
    });
    expect(getStripePromiseCalls).toBe(1);
    expect(retrieveCalls).toEqual(["seti_1_secret_x"]);
    expect(syncCalls).toEqual([{ setupIntentId: "seti_1" }]);
  });

  test("holds the resolution until the platform-session probe settles", async () => {
    // The confirm writes through the QueryClient captured when the resolution
    // started, and that client is keyed on the signed-in user: a full page load
    // authenticates a placeholder user before the probe swaps in the real one,
    // so confirming in that window writes the saved card into a client that is
    // about to be discarded.
    useAuthStore.setState({ platformSession: "unknown" });
    renderAt(RETURN_SEARCH);
    await flushResolution();

    expect(getStripePromiseCalls).toBe(0);
    expect(syncCalls).toEqual([]);
    expect(pending()).toBe(true);

    act(() => {
      useAuthStore.setState({ platformSession: "present" });
    });
    await waitForOutcome();

    expect(syncCalls).toEqual([{ setupIntentId: "seti_1" }]);
    expect(outcome()).toEqual({
      kind: "saved",
      card: { brand: "visa", last4: "4242", autoReloadEnabled: false },
    });
  });

  test("gives the platform-session wait its own ceiling", async () => {
    // Under one shared budget a slow org header starves the probe, and the wait
    // gives up and confirms through the client that is about to be discarded.
    orgReadiness = "resolving";
    useAuthStore.setState({ platformSession: "unknown" });

    renderAt(RETURN_SEARCH);

    // Spend most of the header's 200ms ceiling before it answers.
    await wait(150);
    orgReadiness = "ready";

    // Past where a single shared budget would already have expired.
    await wait(150);
    expect(syncCalls).toEqual([]);
    expect(pending()).toBe(true);

    act(() => {
      useAuthStore.setState({ platformSession: "present" });
    });
    await waitForOutcome();

    expect(syncCalls).toEqual([{ setupIntentId: "seti_1" }]);
  });

  test("stops waiting on a platform session that never settles", async () => {
    // Same ceiling as the org header: a probe that never answers must not leave
    // the return pending (and the add-a-card actions disabled) for the rest of
    // the visit.
    useAuthStore.setState({ platformSession: "unknown" });

    renderAt(RETURN_SEARCH);
    await waitForOutcome();

    expect(syncCalls).toEqual([{ setupIntentId: "seti_1" }]);
    expect(pending()).toBe(false);
  });

  test("stops waiting on an org header that never settles", async () => {
    // `"resolving"` is transient by construction, but a wait with no ceiling
    // would leave the return pending (and the add-a-card actions disabled) for
    // the rest of the visit if it ever weren't.
    orgReadiness = "resolving";
    retrieveResult = { error: { message: "No such setupintent." } };

    renderAt(RETURN_SEARCH);
    await waitForOutcome();

    expect(outcome()).toEqual({
      kind: "error",
      message: "No such setupintent.",
    });
    expect(retrieveCalls).toEqual(["seti_1_secret_x"]);
  });

  test("resolves rather than waiting when org resolution produced no org", async () => {
    // `"unavailable"` never becomes `"ready"` on its own, so gating on it too
    // would leave the return unresolved. The request fires and its failure
    // reaches the user as the error outcome instead.
    orgReadiness = "unavailable";
    retrieveResult = { error: { message: "No such setupintent." } };

    renderAt(RETURN_SEARCH);
    await waitForOutcome();

    expect(outcome()).toEqual({
      kind: "error",
      message: "No such setupintent.",
    });
    expect(retrieveCalls).toEqual(["seti_1_secret_x"]);
  });

  test("settles into the store after the caller unmounts", async () => {
    // The billing tab panel unmounts on a switch to Usage, and by then the
    // params are off the URL: a resolution tied to a component lifecycle would
    // strand the return with no way to replay it.
    orgReadiness = "resolving";
    const { unmount } = renderAt(RETURN_SEARCH);

    expect(pending()).toBe(true);
    unmount();

    orgReadiness = "ready";
    await waitForOutcome();

    expect(outcome()).toEqual({
      kind: "saved",
      card: { brand: "visa", last4: "4242", autoReloadEnabled: false },
    });
  });

  test("discards a return whose organization changed while it resolved", async () => {
    // The confirm writes through the QueryClient captured when the resolution
    // started, and a switch remounts that client: publishing the result would
    // show the previous organization's saved card under the new one and
    // invalidate the new one's billing cache.
    useOrganizationStore.setState({ currentOrganizationId: "org_1" });
    const pendingAtSwitch: boolean[] = [];
    onSync = () => {
      useOrganizationStore.setState({ currentOrganizationId: "org_2" });
      pendingAtSwitch.push(pending());
    };

    renderAt(RETURN_SEARCH);
    await waitFor(() => {
      if (pending()) {
        throw new Error("return still resolving");
      }
    });

    expect(syncCalls).toEqual([{ setupIntentId: "seti_1" }]);
    expect(outcome()).toBeNull();
    expect(useSetupIntentReturnStore.getState().scopeKey).toBeNull();
    // The cards gate their add-a-card actions on the pending window, so it
    // ends at the switch rather than when the abandoned resolution finishes.
    expect(pendingAtSwitch).toEqual([false]);
  });

  test("abandons a return whose organization changed and changed back", async () => {
    // The scope reads unchanged once it lands back on org_1, but the confirm
    // and its webhook poll carried org_2's header from the first switch on, so
    // the resolution is abandoned there and its late result never published.
    useOrganizationStore.setState({ currentOrganizationId: "org_1" });
    onSync = () => {
      useOrganizationStore.setState({ currentOrganizationId: "org_2" });
      useOrganizationStore.setState({ currentOrganizationId: "org_1" });
    };

    renderAt(RETURN_SEARCH);
    await waitFor(() => {
      if (syncCalls.length === 0) {
        throw new Error("confirm not called yet");
      }
    });
    await flushResolution();

    expect(pending()).toBe(false);
    expect(outcome()).toBeNull();
    expect(useSetupIntentReturnStore.getState().scopeKey).toBeNull();
  });

  test("abandons a return whose signed-in user changed while it resolved", async () => {
    // The same watch covers the auth half of the scope: a user switch lands on
    // a different request-scoped QueryClient just as an org switch does.
    useOrganizationStore.setState({ currentOrganizationId: "org_1" });
    onSync = () => {
      useAuthStore.setState({
        sessionStatus: "authenticated",
        user: SWITCHED_USER,
      });
    };

    renderAt(RETURN_SEARCH);
    await waitFor(() => {
      if (syncCalls.length === 0) {
        throw new Error("confirm not called yet");
      }
    });
    await flushResolution();

    expect(pending()).toBe(false);
    expect(outcome()).toBeNull();
  });

  test("stamps a settled outcome with the scope it resolved under", async () => {
    useOrganizationStore.setState({ currentOrganizationId: "org_1" });

    renderAt(RETURN_SEARCH);
    await waitForOutcome();

    expect(useSetupIntentReturnStore.getState().scopeKey).toBe(
      "anonymous:org:org_1",
    );
  });

  test("clearOutcome drops the resolved outcome", async () => {
    renderAt(RETURN_SEARCH);
    await waitForOutcome();

    act(() => {
      useSetupIntentReturnStore.getState().clearOutcome();
    });

    expect(outcome()).toBeNull();
    // A cleared outcome is a resolved return, not one that went back to being
    // in flight, so the card's actions stay usable.
    expect(pending()).toBe(false);
  });
});
