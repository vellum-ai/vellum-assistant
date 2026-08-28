/**
 * Tests for `useSetupIntentReturn`: the SetupIntent params Stripe appends to
 * the `return_url` after an off-page 3DS challenge are read once, resolved
 * through Stripe.js, and stripped from the URL.
 *
 * Strategy: mock the shared Stripe client so `retrieveSetupIntent` is driven
 * from the test (a real one needs Stripe.js and a live intent), mock the
 * saved-card sync so the confirm endpoint is not called, and mock the
 * org-readiness gate so a test can hold the resolution the way a hydrating org
 * store does. The real `setupIntentIdFromClientSecret` is kept, so the id the
 * sync is handed is parsed the way it is in the app.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router";

import * as savedSyncModule from "@/domains/settings/hooks/use-payment-method-saved-poll";
import type { SavedPaymentMethod } from "@/domains/settings/hooks/use-payment-method-saved-poll";
import type { OrgHeaderReadiness } from "@/hooks/use-is-org-ready";

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

async function syncPaymentMethodSaved(args: { setupIntentId: string | null }) {
  syncCalls.push(args);
  return syncedCard;
}

mock.module("@/domains/settings/hooks/use-payment-method-saved-poll", () => ({
  ...savedSyncModule,
  usePaymentMethodSavedSync: () => syncPaymentMethodSaved,
}));

// Drives the org-header gate. The resolution confirms the SetupIntent
// server-side, so it waits out `"resolving"` the way the config query does.
let orgReadiness: OrgHeaderReadiness = "ready";
mock.module("@/hooks/use-is-org-ready", () => ({
  useOrgHeaderReadiness: () => orgReadiness,
}));

const { useSetupIntentReturn } = await import("./use-setup-intent-return");

const RETURN_SEARCH =
  "?tab=billing&setup_intent=seti_1&setup_intent_client_secret=seti_1_secret_x&redirect_status=succeeded";
const STRIPPED_URL = "/assistant/settings/usage?tab=billing";
const CONFIRM_FAILED = "Failed to save payment method.";

function renderAt(search: string) {
  return renderHook(
    () => ({ location: useLocation(), ...useSetupIntentReturn() }),
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
  return result.current.location.pathname + result.current.location.search;
}

async function waitForOutcome(result: HookResult): Promise<void> {
  await waitFor(() => {
    if (result.current.outcome == null) {
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
  orgReadiness = "ready";
});

afterEach(cleanup);

describe("useSetupIntentReturn", () => {
  test("resolves a succeeded return into the synced saved card", async () => {
    const { result } = renderAt(RETURN_SEARCH);
    await waitForOutcome(result);

    expect(result.current.outcome).toEqual({
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
    await waitForOutcome(result);

    expect(result.current.outcome).toEqual({
      kind: "error",
      message: "Your card was declined.",
    });
    expect(syncCalls).toEqual([]);
    expect(currentUrl(result)).toBe(STRIPPED_URL);
  });

  test("carries the retrieval error message when the intent cannot be read", async () => {
    retrieveResult = { error: { message: "No such setupintent." } };

    const { result } = renderAt(RETURN_SEARCH);
    await waitForOutcome(result);

    expect(result.current.outcome).toEqual({
      kind: "error",
      message: "No such setupintent.",
    });
  });

  test("falls back to the generic message when Stripe.js is unavailable", async () => {
    stripeAvailable = false;

    const { result } = renderAt(RETURN_SEARCH);
    await waitForOutcome(result);

    expect(result.current.outcome).toEqual({
      kind: "error",
      message: CONFIRM_FAILED,
    });
    expect(retrieveCalls).toEqual([]);
  });

  test("does nothing and never loads Stripe on a plain visit", () => {
    const { result } = renderAt("?tab=billing");

    expect(result.current.outcome).toBeNull();
    expect(result.current.pending).toBe(false);
    expect(getStripePromiseCalls).toBe(0);
    expect(currentUrl(result)).toBe(STRIPPED_URL);
  });

  test("stays pending from the captured params until the outcome settles", async () => {
    orgReadiness = "resolving";
    const { result, rerender } = renderAt(RETURN_SEARCH);

    expect(result.current.pending).toBe(true);
    expect(result.current.outcome).toBeNull();

    orgReadiness = "ready";
    rerender();
    await waitForOutcome(result);

    expect(result.current.pending).toBe(false);
  });

  test("stays pending while a failed return resolves", async () => {
    orgReadiness = "resolving";
    retrieveResult = { error: { message: "No such setupintent." } };
    const { result, rerender } = renderAt(RETURN_SEARCH);

    expect(result.current.pending).toBe(true);

    orgReadiness = "ready";
    rerender();
    await waitForOutcome(result);

    expect(result.current.pending).toBe(false);
  });

  test("holds the resolution while the org header source is resolving", async () => {
    orgReadiness = "resolving";
    const { result, rerender } = renderAt(RETURN_SEARCH);

    // The params are already off the URL, so a reload cannot replay them.
    expect(currentUrl(result)).toBe(STRIPPED_URL);
    expect(getStripePromiseCalls).toBe(0);
    expect(retrieveCalls).toEqual([]);
    expect(syncCalls).toEqual([]);
    expect(result.current.outcome).toBeNull();

    orgReadiness = "ready";
    rerender();
    await waitForOutcome(result);

    expect(result.current.outcome).toEqual({
      kind: "saved",
      card: { brand: "visa", last4: "4242", autoReloadEnabled: false },
    });
    expect(getStripePromiseCalls).toBe(1);
    expect(retrieveCalls).toEqual(["seti_1_secret_x"]);
    expect(syncCalls).toEqual([{ setupIntentId: "seti_1" }]);
  });

  test("resolves rather than waiting when org resolution produced no org", async () => {
    // `"unavailable"` never becomes `"ready"` on its own, so gating on it too
    // would leave the return unresolved. The request fires and its failure
    // reaches the user as the error outcome instead.
    orgReadiness = "unavailable";
    retrieveResult = { error: { message: "No such setupintent." } };

    const { result } = renderAt(RETURN_SEARCH);
    await waitForOutcome(result);

    expect(result.current.outcome).toEqual({
      kind: "error",
      message: "No such setupintent.",
    });
    expect(retrieveCalls).toEqual(["seti_1_secret_x"]);
  });

  test("clearOutcome drops the resolved outcome", async () => {
    const { result } = renderAt(RETURN_SEARCH);
    await waitForOutcome(result);

    act(() => {
      result.current.clearOutcome();
    });

    expect(result.current.outcome).toBeNull();
    // A cleared outcome is a resolved return, not one that went back to being
    // in flight, so the card's actions stay usable.
    expect(result.current.pending).toBe(false);
  });
});
