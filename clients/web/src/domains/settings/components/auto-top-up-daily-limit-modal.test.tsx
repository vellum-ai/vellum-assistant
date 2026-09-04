/**
 * Tests for `AutoTopUpDailyLimitModal`, the gate the auto-reload form shows
 * when the org has no daily credit limit:
 *  - opens with the $25 default filled in
 *  - saving PUTs the two-decimal limit, seeds the daily-limit cache, and then
 *    reports back through `onSaved`
 *  - Enter in the input saves too
 *  - a below-minimum value shows the inline error and never calls the API
 *  - declining reports back through `onCancel` without a PUT
 *  - a rejected save keeps the dialog open with the failure shown
 *
 * Radix portals the dialog, so queries come off `render`'s `baseElement`
 * (document.body), not the mount container. The PUT is mocked at the SDK
 * boundary.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import * as sdkGen from "@/generated/api/sdk.gen";
import type { DailyCreditLimitResponse } from "@/generated/api/types.gen";

let updateCalls: Array<Record<string, unknown>> = [];
let updateError: unknown = null;

mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  organizationsBillingDailyCreditLimitUpdate: (
    opts: Record<string, unknown>,
  ) => {
    updateCalls.push(opts);
    if (updateError !== null) {
      return Promise.reject(updateError);
    }
    const body = (opts.body ?? {}) as { daily_credit_limit_usd: string | null };
    return Promise.resolve({
      data: {
        daily_credit_limit_usd: body.daily_credit_limit_usd,
        current_day_spent_usd: "0.00",
        day_bucket: "2026-09-04",
        daily_limit_snoozed: false,
        daily_limit_snoozed_day_bucket: null,
      },
      response: { ok: true },
    });
  },
}));

import { organizationsBillingDailyCreditLimitRetrieveQueryKey } from "@/generated/api/@tanstack/react-query.gen";

const { AutoTopUpDailyLimitModal, DEFAULT_DAILY_CREDIT_LIMIT_USD } =
  await import("./auto-top-up-daily-limit-modal");

let onSaved = mock(() => {});
let onCancel = mock(() => {});

function renderModal() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <AutoTopUpDailyLimitModal onSaved={onSaved} onCancel={onCancel} />
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  updateCalls = [];
  updateError = null;
  onSaved = mock(() => {});
  onCancel = mock(() => {});
});

afterEach(cleanup);

describe("AutoTopUpDailyLimitModal", () => {
  test("opens with the default limit filled in", () => {
    const { getByTestId } = renderModal();

    expect(DEFAULT_DAILY_CREDIT_LIMIT_USD).toBe("25");
    expect(
      (getByTestId("auto-top-up-daily-limit-input") as HTMLInputElement).value,
    ).toBe("25");
    expect(getByTestId("auto-top-up-daily-limit-modal").textContent).toContain(
      "Set a daily credit limit",
    );
  });

  test("saving PUTs the two-decimal limit, seeds the cache, then reports back", async () => {
    const { client, getByTestId } = renderModal();

    fireEvent.change(getByTestId("auto-top-up-daily-limit-input"), {
      target: { value: "40" },
    });
    fireEvent.click(getByTestId("auto-top-up-daily-limit-save-button"));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0]!.body).toEqual({ daily_credit_limit_usd: "40.00" });
    expect(
      client.getQueryData<DailyCreditLimitResponse>(
        organizationsBillingDailyCreditLimitRetrieveQueryKey(),
      )?.daily_credit_limit_usd,
    ).toBe("40.00");
  });

  test("Enter in the input saves the default", async () => {
    const { getByTestId } = renderModal();

    fireEvent.keyDown(getByTestId("auto-top-up-daily-limit-input"), {
      key: "Enter",
    });

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(updateCalls[0]!.body).toEqual({ daily_credit_limit_usd: "25.00" });
  });

  test("a below-minimum value shows the error and does not call the API", () => {
    const { getByTestId } = renderModal();

    fireEvent.change(getByTestId("auto-top-up-daily-limit-input"), {
      target: { value: "0.5" },
    });
    fireEvent.click(getByTestId("auto-top-up-daily-limit-save-button"));

    expect(getByTestId("auto-top-up-daily-limit-modal").textContent).toContain(
      "Must be at least $1",
    );
    expect(updateCalls).toEqual([]);
    expect(onSaved).not.toHaveBeenCalled();
  });

  test("declining reports back without saving", () => {
    const { getByTestId } = renderModal();

    fireEvent.click(getByTestId("auto-top-up-daily-limit-cancel-button"));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(updateCalls).toEqual([]);
    expect(onSaved).not.toHaveBeenCalled();
  });

  test("a rejected save keeps the dialog open and shows the failure", async () => {
    updateError = new Error("boom");
    const { getByTestId, queryByTestId } = renderModal();

    fireEvent.click(getByTestId("auto-top-up-daily-limit-save-button"));

    await waitFor(() => {
      if (queryByTestId("auto-top-up-daily-limit-error") == null) {
        throw new Error("error notice not shown");
      }
    });
    expect(getByTestId("auto-top-up-daily-limit-error").textContent).toContain(
      "Failed to save daily credit limit",
    );
    expect(queryByTestId("auto-top-up-daily-limit-modal")).not.toBeNull();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
