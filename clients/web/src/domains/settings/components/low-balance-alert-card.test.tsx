/**
 * Tests for LowBalanceAlertCard:
 *  - renders the current per-org override in the input
 *  - saving a new value PUTs the two-decimal threshold body
 *  - "Reset to default" PUTs `threshold_usd: null` to clear the override
 *  - out-of-bounds input shows an inline error and does NOT call the API
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
  organizationsBillingLowBalanceAlertUpdate: (opts: Record<string, unknown>) => {
    updateCalls.push(opts);
    const body = (opts.body ?? {}) as { threshold_usd: string | null };
    return Promise.resolve({
      data: {
        threshold_usd: body.threshold_usd,
        effective_threshold_usd: body.threshold_usd ?? "5.00",
        default_threshold_usd: "5.00",
      },
      response: { ok: true },
    });
  },
}));

import { organizationsBillingLowBalanceAlertRetrieveQueryKey } from "@/generated/api/@tanstack/react-query.gen";
import type { LowBalanceAlertResponse } from "@/generated/api/types.gen";

const { LowBalanceAlertCard } = await import("./low-balance-alert-card");

function makeClient(config: LowBalanceAlertResponse): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(
    organizationsBillingLowBalanceAlertRetrieveQueryKey(),
    config,
  );
  return client;
}

function renderCard(config: LowBalanceAlertResponse): ReturnType<typeof render> {
  return render(
    <QueryClientProvider client={makeClient(config)}>
      <LowBalanceAlertCard />
    </QueryClientProvider>,
  );
}

const UNSET: LowBalanceAlertResponse = {
  threshold_usd: null,
  effective_threshold_usd: "5.00",
  default_threshold_usd: "5.00",
};

beforeEach(() => {
  updateCalls = [];
});

afterEach(cleanup);

describe("LowBalanceAlertCard", () => {
  test("renders the current override in the input", () => {
    const { getByTestId } = renderCard({ ...UNSET, threshold_usd: "25.00" });
    const input = getByTestId("low-balance-alert-input") as HTMLInputElement;
    expect(input.value).toBe("25.00");
  });

  test("saving a new value PUTs the two-decimal threshold", async () => {
    const { getByTestId } = renderCard(UNSET);
    fireEvent.change(getByTestId("low-balance-alert-input"), {
      target: { value: "50" },
    });
    fireEvent.click(getByTestId("low-balance-alert-save-button"));

    await waitFor(() => {
      if (updateCalls.length === 0) {
        throw new Error("PUT not called");
      }
    });
    expect(updateCalls[0]!.body).toEqual({ threshold_usd: "50.00" });
  });

  test("Reset to default PUTs threshold_usd: null", async () => {
    const { getByTestId } = renderCard({ ...UNSET, threshold_usd: "25.00" });
    fireEvent.click(getByTestId("low-balance-alert-reset-button"));

    await waitFor(() => {
      if (updateCalls.length === 0) {
        throw new Error("PUT not called");
      }
    });
    expect(updateCalls[0]!.body).toEqual({ threshold_usd: null });
  });

  test("out-of-bounds input shows an error and does not call the API", () => {
    const { getByTestId, container } = renderCard(UNSET);
    fireEvent.change(getByTestId("low-balance-alert-input"), {
      target: { value: "2000" },
    });
    fireEvent.click(getByTestId("low-balance-alert-save-button"));

    expect(container.textContent).toContain("Must be between $1 and $1,000");
    expect(updateCalls.length).toBe(0);
  });
});
