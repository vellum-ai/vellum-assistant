/**
 * Tests for DailyCreditLimitCard:
 *  - renders the current per-org limit in the input when one is set
 *  - saving a new value PUTs the two-decimal limit body
 *  - turning the toggle off PUTs `daily_credit_limit_usd: null` to clear it
 *  - below-minimum input shows an inline error and does NOT call the API
 *  - `validateDailyLimit` bounds checks (pure)
 *
 * The GET is seeded directly into the React Query cache so `useQuery` resolves
 * synchronously; the PUT SDK function is mocked to capture the request body.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import * as sdkGen from "@/generated/api/sdk.gen";

let updateCalls: Array<Record<string, unknown>> = [];

mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  organizationsBillingDailyCreditLimitUpdate: (
    opts: Record<string, unknown>,
  ) => {
    updateCalls.push(opts);
    const body = (opts.body ?? {}) as { daily_credit_limit_usd: string | null };
    return Promise.resolve({
      data: {
        daily_credit_limit_usd: body.daily_credit_limit_usd,
        current_day_spent_usd: "0.00",
        day_bucket: body.daily_credit_limit_usd == null ? null : "2026-07-20",
      },
      response: { ok: true },
    });
  },
}));

import { organizationsBillingDailyCreditLimitRetrieveQueryKey } from "@/generated/api/@tanstack/react-query.gen";
import type { DailyCreditLimitResponse } from "@/generated/api/types.gen";

const { DailyCreditLimitCard, validateDailyLimit } = await import(
  "./daily-credit-limit-card"
);

function makeClient(config: DailyCreditLimitResponse): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(
    organizationsBillingDailyCreditLimitRetrieveQueryKey(),
    config,
  );
  return client;
}

function renderCard(
  config: DailyCreditLimitResponse,
): ReturnType<typeof render> {
  return render(
    <QueryClientProvider client={makeClient(config)}>
      <DailyCreditLimitCard />
    </QueryClientProvider>,
  );
}

const OFF: DailyCreditLimitResponse = {
  daily_credit_limit_usd: null,
  current_day_spent_usd: "0.00",
  day_bucket: null,
};

beforeEach(() => {
  updateCalls = [];
});

afterEach(cleanup);

describe("validateDailyLimit", () => {
  test("rejects empty, below-min, and over-precision values", () => {
    expect(validateDailyLimit("")).toBe("Enter a daily limit");
    expect(validateDailyLimit("0.50")).toBe("Must be at least $1");
    expect(validateDailyLimit("10.123")).toBe("Use at most two decimal places");
  });

  test("accepts valid amounts ≥ $1", () => {
    expect(validateDailyLimit("1")).toBeUndefined();
    expect(validateDailyLimit("25.50")).toBeUndefined();
  });
});

describe("DailyCreditLimitCard", () => {
  test("renders the current limit in the input when set", () => {
    const { getByTestId } = renderCard({ ...OFF, daily_credit_limit_usd: "25.00" });
    const input = getByTestId("daily-credit-limit-input") as HTMLInputElement;
    expect(input.value).toBe("25.00");
  });

  test("hides the input when the limit is off until the toggle is on", () => {
    const { queryByTestId, getByRole } = renderCard(OFF);
    expect(queryByTestId("daily-credit-limit-input")).toBeNull();
    fireEvent.click(getByRole("switch"));
    expect(queryByTestId("daily-credit-limit-input")).not.toBeNull();
  });

  test("saving a new value PUTs the two-decimal limit", async () => {
    const { getByTestId, getByRole } = renderCard(OFF);
    fireEvent.click(getByRole("switch"));
    fireEvent.change(getByTestId("daily-credit-limit-input"), {
      target: { value: "50" },
    });
    fireEvent.click(getByTestId("daily-credit-limit-save-button"));

    await waitFor(() => {
      if (updateCalls.length === 0) {
        throw new Error("PUT not called");
      }
    });
    expect(updateCalls[0]!.body).toEqual({ daily_credit_limit_usd: "50.00" });
  });

  test("turning the toggle off PUTs daily_credit_limit_usd: null", async () => {
    const { getByRole } = renderCard({ ...OFF, daily_credit_limit_usd: "25.00" });
    fireEvent.click(getByRole("switch"));

    await waitFor(() => {
      if (updateCalls.length === 0) {
        throw new Error("PUT not called");
      }
    });
    expect(updateCalls[0]!.body).toEqual({ daily_credit_limit_usd: null });
  });

  test("below-minimum input shows an error and does not call the API", () => {
    const { getByTestId, getByRole, container } = renderCard(OFF);
    fireEvent.click(getByRole("switch"));
    fireEvent.change(getByTestId("daily-credit-limit-input"), {
      target: { value: "0.50" },
    });
    fireEvent.click(getByTestId("daily-credit-limit-save-button"));

    expect(container.textContent).toContain("Must be at least $1");
    expect(updateCalls.length).toBe(0);
  });
});
