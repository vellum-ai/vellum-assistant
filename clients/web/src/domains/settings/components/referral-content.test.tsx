/**
 * Tests for ReferralContent's three render states:
 *  - loading: the query is pending, so a spinner and "Loading..." render
 *  - error: the query rejects, so the failure notice renders
 *  - loaded: seeded cache data renders the stat chips and copy action
 *
 * The GET SDK function is mocked so pending/rejected states are deterministic;
 * the loaded state seeds the React Query cache so `useQuery` resolves
 * synchronously.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";

import * as sdkGen from "@/generated/api/sdk.gen";
import type { MyReferralCodeResponse } from "@/generated/api/types.gen";

let retrieveImpl: () => Promise<unknown> = () => new Promise(() => {});

mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  referralCodesMeRetrieve: () => retrieveImpl(),
}));

const { referralCodesMeRetrieveQueryKey } = await import(
  "@/generated/api/@tanstack/react-query.gen"
);
const { ReferralContent } = await import("./referral-content");

function referralData(): MyReferralCodeResponse {
  return {
    code: "ABC123",
    referral_url: "https://vellum.ai/r/ABC123",
    referred_count: 2,
    total_earned_usd: "10.00",
    earning_cap_usd: "50.00",
    total_earned: "10.00",
    earning_cap: "50.00",
    credit_amount: "5.00",
    referrer_credit_amount: "5.00",
    is_eligible_for_credits: true,
  };
}

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function renderWith(client: QueryClient): ReturnType<typeof render> {
  return render(
    <QueryClientProvider client={client}>
      <ReferralContent />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  retrieveImpl = () => new Promise(() => {});
});

describe("ReferralContent", () => {
  test("renders the loading state while the query is pending", () => {
    retrieveImpl = () => new Promise(() => {});
    const { container } = renderWith(makeClient());
    expect(container.textContent).toContain("Loading...");
  });

  test("renders the failure notice when the query errors", async () => {
    retrieveImpl = () => Promise.reject(new Error("boom"));
    const { container } = renderWith(makeClient());
    await waitFor(() => {
      if (!container.textContent?.includes("Failed to load")) {
        throw new Error("error notice not shown yet");
      }
    });
    expect(container.textContent).toContain(
      "Failed to load referral information.",
    );
  });

  test("renders stats and the copy action when loaded", () => {
    const client = makeClient();
    client.setQueryData(referralCodesMeRetrieveQueryKey(), referralData());
    const { container, getByTestId } = renderWith(client);
    expect(container.textContent).toContain("Credits Earned");
    expect(container.textContent).toContain("Friends Referred");
    expect(getByTestId("referral-copy-button")).toBeDefined();
  });
});
