/**
 * Tests for usePaymentMethodSavedPoll: the returned callback resolves as soon
 * as the refetched config reports a payment method whose
 * `stripe_payment_method_updated_at` advanced past the pre-call cache value,
 * and keeps polling while the marker is unchanged (webhook not landed yet).
 * The 20s timeout path is not exercised here; it would need real time.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";

import * as sdkGen from "@/generated/api/sdk.gen";
import type { AutoTopUpConfigResponse } from "@/generated/api/types.gen";

let retrieveResponses: AutoTopUpConfigResponse[] = [];
let retrieveCalls = 0;

mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  organizationsBillingAutoTopUpRetrieve: () => {
    const next =
      retrieveResponses[Math.min(retrieveCalls, retrieveResponses.length - 1)];
    retrieveCalls += 1;
    return Promise.resolve({ data: next, response: { ok: true } });
  },
}));

import { organizationsBillingAutoTopUpRetrieveQueryKey } from "@/generated/api/@tanstack/react-query.gen";

const { usePaymentMethodSavedPoll } = await import(
  "./use-payment-method-saved-poll"
);
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

function setup(cached: AutoTopUpConfigResponse) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(organizationsBillingAutoTopUpRetrieveQueryKey(), cached);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => usePaymentMethodSavedPoll(), { wrapper });
}

beforeEach(() => {
  retrieveResponses = [];
  retrieveCalls = 0;
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
});
