/**
 * Tests for the payment-method-saved follow-ups.
 *
 * usePaymentMethodSavedPoll: Stripe has already confirmed the save when the
 * callback runs, so it flips the cached config to `has_payment_method: true`
 * up front, then resolves as soon as a refetch reports a payment method
 * whose `stripe_payment_method_updated_at` advanced past the pre-call cache
 * value. While the marker is unchanged (webhook not landed yet) it keeps
 * polling without writing the pre-webhook "no card" responses into the
 * cache, so the flipped config stays visible. The 20s timeout path is not
 * exercised here; it would need real time.
 *
 * usePaymentMethodSavedSync: confirms the SetupIntent server-side and seeds
 * the config cache from the response, falling back to the poll when the
 * confirm call fails or no SetupIntent id was derivable.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";

import * as sdkGen from "@/generated/api/sdk.gen";
import type { AutoTopUpConfigResponse } from "@/generated/api/types.gen";

let retrieveResponses: AutoTopUpConfigResponse[] = [];
let retrieveCalls = 0;
let confirmCalls: Array<Record<string, unknown>> = [];
let confirmResponse: AutoTopUpConfigResponse | null = null;
let confirmShouldFail = false;

mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  organizationsBillingAutoTopUpRetrieve: () => {
    const next =
      retrieveResponses[Math.min(retrieveCalls, retrieveResponses.length - 1)];
    retrieveCalls += 1;
    return Promise.resolve({ data: next, response: { ok: true } });
  },
  organizationsBillingAutoTopUpConfirmSetupIntentCreate: (
    opts: Record<string, unknown>,
  ) => {
    confirmCalls.push(opts);
    if (confirmShouldFail) {
      return Promise.reject(new Error("confirm failed"));
    }
    return Promise.resolve({ data: confirmResponse, response: { ok: true } });
  },
}));

import { organizationsBillingAutoTopUpRetrieveQueryKey } from "@/generated/api/@tanstack/react-query.gen";

const { usePaymentMethodSavedPoll, usePaymentMethodSavedSync } =
  await import("./use-payment-method-saved-poll");
const { DISABLED_CONFIG } = await import("../components/auto-top-up-card");

function makeConfig(
  marker: string | null,
  hasPm: boolean,
): AutoTopUpConfigResponse {
  return {
    ...DISABLED_CONFIG,
    has_payment_method: hasPm,
    stripe_payment_method_updated_at: marker,
  };
}

function makeClient(cached: AutoTopUpConfigResponse): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  client.setQueryData(organizationsBillingAutoTopUpRetrieveQueryKey(), cached);
  return client;
}

function makeWrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function setup(cached: AutoTopUpConfigResponse) {
  const client = makeClient(cached);
  const rendered = renderHook(() => usePaymentMethodSavedPoll(), {
    wrapper: makeWrapper(client),
  });
  return { ...rendered, client };
}

function cachedConfig(client: QueryClient): AutoTopUpConfigResponse | undefined {
  return client.getQueryData<AutoTopUpConfigResponse>(
    organizationsBillingAutoTopUpRetrieveQueryKey(),
  );
}

function setupSync(cached: AutoTopUpConfigResponse) {
  const client = makeClient(cached);
  const rendered = renderHook(() => usePaymentMethodSavedSync(), {
    wrapper: makeWrapper(client),
  });
  return { ...rendered, client };
}

beforeEach(() => {
  retrieveResponses = [];
  retrieveCalls = 0;
  confirmCalls = [];
  confirmResponse = null;
  confirmShouldFail = false;
});

describe("usePaymentMethodSavedPoll", () => {
  test("resolves once the marker advances past the pre-call cache value", async () => {
    retrieveResponses = [makeConfig("2026-08-19T00:00:01Z", true)];
    const { result } = setup(makeConfig("2026-08-19T00:00:00Z", true));

    await result.current();

    expect(retrieveCalls).toBe(1);
  });

  test("keeps polling while the marker is unchanged", async () => {
    // First refetch still carries the stale marker (webhook not landed);
    // the second carries the fresh one.
    retrieveResponses = [
      makeConfig("2026-08-19T00:00:00Z", true),
      makeConfig("2026-08-19T00:00:01Z", true),
    ];
    const { result } = setup(makeConfig("2026-08-19T00:00:00Z", true));

    await result.current();

    expect(retrieveCalls).toBe(2);
  }, 10_000);

  test("treats a first-ever card (null prior marker) as fresh", async () => {
    retrieveResponses = [makeConfig("2026-08-19T00:00:01Z", true)];
    const { result } = setup(makeConfig(null, false));

    await result.current();

    expect(retrieveCalls).toBe(1);
  });

  test("flips the cached config to a saved card before the webhook lands", async () => {
    retrieveResponses = [makeConfig("2026-08-19T00:00:01Z", true)];
    const { result, client } = setup(makeConfig(null, false));

    const done = result.current();

    // The flip lands right after in-flight fetches are cancelled, ahead of
    // the first poll response resolving.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cachedConfig(client)?.has_payment_method).toBe(true);
    await done;
  });

  test("a pre-webhook response does not clobber the flipped config", async () => {
    retrieveResponses = [
      makeConfig(null, false),
      makeConfig("2026-08-19T00:00:01Z", true),
    ];
    const { result, client } = setup(makeConfig(null, false));

    const done = result.current();
    // Let the first (pre-webhook, still no card) response come back and be
    // examined; the cache must keep showing the saved card through it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(cachedConfig(client)?.has_payment_method).toBe(true);

    await done;

    expect(retrieveCalls).toBe(2);
    expect(cachedConfig(client)).toEqual(
      makeConfig("2026-08-19T00:00:01Z", true),
    );
  }, 10_000);

  test("flips back when an observer refetch writes pre-webhook data over it", async () => {
    retrieveResponses = [
      makeConfig(null, false),
      makeConfig("2026-08-19T00:00:01Z", true),
    ];
    const { result, client } = setup(makeConfig(null, false));

    const done = result.current();
    // Let the first (still no card) poll response come back; the poll is now
    // waiting for its next attempt.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Simulate a focus/reconnect refetch landing the server's pre-webhook
    // config over the flip; the cache subscription restores it.
    client.setQueryData(
      organizationsBillingAutoTopUpRetrieveQueryKey(),
      makeConfig(null, false),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cachedConfig(client)?.has_payment_method).toBe(true);

    await done;
    expect(cachedConfig(client)).toEqual(
      makeConfig("2026-08-19T00:00:01Z", true),
    );
  }, 10_000);
});

describe("usePaymentMethodSavedSync", () => {
  test("seeds the config cache from the confirm response without polling", async () => {
    const confirmed = {
      ...makeConfig("2026-08-19T00:00:01Z", true),
      payment_method_brand: "visa",
      payment_method_last4: "4242",
    };
    confirmResponse = confirmed;
    const { result, client } = setupSync(makeConfig(null, false));

    await result.current({ setupIntentId: "seti_abc" });

    expect(confirmCalls.length).toBe(1);
    expect(
      (confirmCalls[0] as { body: { setup_intent_id: string } }).body,
    ).toEqual({ setup_intent_id: "seti_abc" });
    expect(retrieveCalls).toBe(0);
    expect(
      client.getQueryData<AutoTopUpConfigResponse>(
        organizationsBillingAutoTopUpRetrieveQueryKey(),
      ),
    ).toEqual(confirmed);
  });

  test("falls back to the poll when the confirm call fails", async () => {
    confirmShouldFail = true;
    retrieveResponses = [makeConfig("2026-08-19T00:00:01Z", true)];
    const { result } = setupSync(makeConfig("2026-08-19T00:00:00Z", true));

    await result.current({ setupIntentId: "seti_abc" });

    expect(confirmCalls.length).toBe(1);
    expect(retrieveCalls).toBe(1);
  });

  test("polls without confirming when no SetupIntent id was derivable", async () => {
    retrieveResponses = [makeConfig("2026-08-19T00:00:01Z", true)];
    const { result } = setupSync(makeConfig("2026-08-19T00:00:00Z", true));

    await result.current({ setupIntentId: null });

    expect(confirmCalls.length).toBe(0);
    expect(retrieveCalls).toBe(1);
  });
});
