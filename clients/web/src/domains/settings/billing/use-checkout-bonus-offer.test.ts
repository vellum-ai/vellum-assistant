/**
 * Tests for `useCheckoutBonusOffer` gating:
 *  - no cancel signal: the eligibility endpoint is never queried and no offer
 *    shows, whatever the server would say
 *  - triggered before the org store settles: the query waits for org
 *    readiness (a header-less request would be rejected), then fires once
 *  - triggered + server says ineligible: exactly one request and no offer,
 *    so hand-typed cancel URLs stay quiet
 *  - triggered + server says eligible: the offer shows with the
 *    server-returned amount
 *  - a second trigger behind the app's 10s default staleTime: the cached
 *    ineligible answer from a previous probe is not reused; each trigger
 *    re-asks the server
 *
 * The GET is mocked at the SDK boundary so the real generated query factory
 * stays in the loop, mirroring checkout-bonus-modal.test.tsx.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import * as sdkGen from "@/generated/api/sdk.gen";
import type { CheckoutBonusEligibilityResponse } from "@/generated/api/types.gen";

let retrieveCalls = 0;
let eligibilityResponse: CheckoutBonusEligibilityResponse;
let orgReady = true;

mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  organizationsBillingCheckoutBonusRetrieve: () => {
    retrieveCalls += 1;
    return Promise.resolve({
      data: eligibilityResponse,
      response: { ok: true },
    });
  },
}));

mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => orgReady,
}));

const { useCheckoutBonusOffer } = await import("./use-checkout-bonus-offer");

function setup(triggered: boolean, client?: QueryClient) {
  const queryClient =
    client ??
    new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return renderHook((props) => useCheckoutBonusOffer(props.triggered), {
    initialProps: { triggered },
    wrapper,
  });
}

// Lets any wrongly-enabled fetch land before asserting a call count of zero.
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

beforeEach(() => {
  retrieveCalls = 0;
  eligibilityResponse = { eligible: true, amount_usd: "5.00" };
  orgReady = true;
});

afterEach(() => {
  cleanup();
});

describe("useCheckoutBonusOffer", () => {
  test("no cancel signal: never queries, never offers", async () => {
    const { result } = setup(false);

    await flush();
    expect(retrieveCalls).toBe(0);
    expect(result.current.showOffer).toBe(false);
  });

  test("triggered before the org settles: waits, then fires once", async () => {
    orgReady = false;
    const { result, rerender } = setup(true);

    await flush();
    expect(retrieveCalls).toBe(0);
    expect(result.current.showOffer).toBe(false);

    orgReady = true;
    rerender({ triggered: true });

    await waitFor(() => expect(result.current.showOffer).toBe(true));
    expect(retrieveCalls).toBe(1);
  });

  test("triggered + ineligible: one request, no offer", async () => {
    eligibilityResponse = { eligible: false, amount_usd: "0.00" };
    const { result } = setup(true);

    await waitFor(() => expect(retrieveCalls).toBe(1));
    await flush();
    expect(result.current.showOffer).toBe(false);
  });

  test("triggered + eligible: offers the server-returned amount", async () => {
    eligibilityResponse = { eligible: true, amount_usd: "7.50" };
    const { result } = setup(true);

    await waitFor(() => expect(result.current.showOffer).toBe(true));
    expect(result.current.amountUsd).toBe("7.50");
    expect(retrieveCalls).toBe(1);
  });

  test("repeat trigger: refetches past the app's 10s default staleTime", async () => {
    // Mirror the app QueryClient (providers.tsx): a 10s default staleTime
    // would otherwise let a cached ineligible probe answer a real cancel.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 10_000 } },
    });

    eligibilityResponse = { eligible: false, amount_usd: "0.00" };
    const first = setup(true, client);
    await waitFor(() => expect(retrieveCalls).toBe(1));
    await flush();
    expect(first.result.current.showOffer).toBe(false);
    first.unmount();

    // A real abandoned checkout lands within the staleness window.
    eligibilityResponse = { eligible: true, amount_usd: "5.00" };
    const second = setup(true, client);

    await waitFor(() => expect(second.result.current.showOffer).toBe(true));
    expect(second.result.current.amountUsd).toBe("5.00");
    expect(retrieveCalls).toBe(2);
  });
});
