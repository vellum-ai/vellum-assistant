/**
 * Tests for `DailyLimitBanner`.
 *
 * The banner is the one place a user can relax a spend guardrail from inside
 * chat, so the cases that matter are: the skip is confirmed rather than
 * immediate, the confirm copy states when enforcement returns, and the
 * auto-top-up warning appears only when top-ups are positively known to be on
 * (asserting someone's card will be charged when we are not sure is worse than
 * saying nothing), and a rejected skip stays on screen instead of closing as
 * if it had worked.
 *
 * Every SDK call the banner makes is mocked at the SDK boundary and seeded into
 * the query cache, matching the sibling billing tests.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

import * as sdkGen from "@/generated/api/sdk.gen";
import type {
  AutoTopUpConfigResponse,
  BillingSummaryResponse,
} from "@/generated/api/types.gen";

let skipCalls: Array<Record<string, unknown>> = [];
let summaryResponse: BillingSummaryResponse;
let autoTopUpResponse: AutoTopUpConfigResponse;
let autoTopUpShouldFail = false;
let skipShouldFail = false;

mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  organizationsBillingSummaryRetrieve: () =>
    Promise.resolve({ data: summaryResponse, response: { ok: true } }),
  organizationsBillingAutoTopUpRetrieve: () => {
    if (autoTopUpShouldFail) {
      return Promise.reject(new Error("auto top-up unavailable"));
    }
    return Promise.resolve({ data: autoTopUpResponse, response: { ok: true } });
  },
  organizationsBillingDailyCreditLimitSkipTodayCreate: (
    opts: Record<string, unknown>,
  ) => {
    skipCalls.push(opts);
    if (skipShouldFail) {
      return Promise.reject(new Error("skip rejected"));
    }
    return Promise.resolve({ data: {}, response: { ok: true } });
  },
}));

mock.module("@/hooks/use-platform-gate", () => ({
  usePlatformGate: () => "full",
  useActiveAssistantIsPlatformHosted: () => true,
}));

mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => true,
  useOrgHeaderReadiness: () => "ready",
}));

import {
  organizationsBillingAutoTopUpRetrieveQueryKey,
  organizationsBillingSummaryRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";

const { DailyLimitBanner } = await import("./daily-limit-banner");

const AUTO_TOP_UP_OFF = {
  enabled: false,
  threshold_usd: null,
  amount_usd: null,
  monthly_cap_usd: null,
  has_payment_method: false,
  payment_method_brand: null,
  payment_method_last4: null,
  stripe_payment_method_updated_at: null,
  last_charge_at: null,
  last_failure_at: null,
  last_failure_reason: null,
  disabled_due_to_repeated_failures: false,
  paused_until: null,
  current_month_credits_purchased_usd: "0.00",
  current_month_charged_usd: "0.00",
  next_trigger_amount_usd: null,
  stubbed: false,
} as AutoTopUpConfigResponse;

const SUMMARY = {
  settled_balance: "20.00",
  minimum_top_up: "5.00",
  maximum_top_up: "100.00",
  maximum_balance: "500.00",
  allowed_top_up_amounts: ["5.00"],
  settled_balance_usd: "20.00",
  minimum_top_up_usd: "5.00",
  maximum_top_up_usd: "100.00",
  maximum_balance_usd: "500.00",
  pending_compute: "0.00",
  pending_compute_usd: "0.00",
  effective_balance: "20.00",
  effective_balance_usd: "20.00",
  is_degraded: false,
  daily_credit_limit_usd: "25.00",
  daily_spend_usd: "25.13",
  daily_limit_reached: true,
  daily_limit_snoozed: false,
  low_balance_threshold_usd: "5.00",
  low_balance_warning: false,
  credits_expiring_soon_usd: "0.00",
  next_credit_expiry_at: null,
} as unknown as BillingSummaryResponse;

function renderBanner() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(
    organizationsBillingSummaryRetrieveQueryKey(),
    summaryResponse,
  );
  if (!autoTopUpShouldFail) {
    client.setQueryData(
      organizationsBillingAutoTopUpRetrieveQueryKey(),
      autoTopUpResponse,
    );
  }
  return render(
    <QueryClientProvider client={client}>
      <DailyLimitBanner onAdjustLimit={() => {}} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  skipCalls = [];
  summaryResponse = { ...SUMMARY };
  autoTopUpResponse = { ...AUTO_TOP_UP_OFF };
  autoTopUpShouldFail = false;
  skipShouldFail = false;
});

afterEach(cleanup);

describe("DailyLimitBanner", () => {
  test("offers both a Settings and a Skip for today action", () => {
    const { getByRole } = renderBanner();
    expect(getByRole("button", { name: "Settings" })).toBeTruthy();
    expect(getByRole("button", { name: "Skip for today" })).toBeTruthy();
  });

  test("skipping is confirmed, not immediate", () => {
    // A single click must not relax a spend guardrail.
    const { getByRole } = renderBanner();
    fireEvent.click(getByRole("button", { name: "Skip for today" }));
    expect(skipCalls.length).toBe(0);
  });

  test("the confirm names the limit, today's spend, and when it returns", () => {
    const { getByRole, getByText } = renderBanner();
    fireEvent.click(getByRole("button", { name: "Skip for today" }));
    expect(getByText(/Skip today's credit limit\?/)).toBeTruthy();
    const dialog = getByRole("dialog");
    expect(dialog.textContent).toContain("$25.00");
    expect(dialog.textContent).toContain("$25.13");
    expect(dialog.textContent).toContain("comes back automatically");
  });

  test("confirming sends the skip", async () => {
    const { getByRole, getAllByRole } = renderBanner();
    fireEvent.click(getByRole("button", { name: "Skip for today" }));
    const confirm = getAllByRole("button", { name: "Skip for today" }).at(-1)!;
    await act(async () => {
      fireEvent.click(confirm);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(skipCalls.length).toBe(1);
  });

  test("a rejected skip keeps the dialog open and says so", async () => {
    // Closing on failure would leave the user believing the limit is skipped
    // while it is still blocking every send.
    skipShouldFail = true;
    const { getByRole, getAllByRole, queryByRole } = renderBanner();
    fireEvent.click(getByRole("button", { name: "Skip for today" }));
    const confirm = getAllByRole("button", { name: "Skip for today" }).at(-1)!;
    await act(async () => {
      fireEvent.click(confirm);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const dialog = queryByRole("dialog");
    expect(dialog).toBeTruthy();
    expect(dialog!.textContent).toContain("Could not skip today's limit");
  });

  test("a successful skip closes the dialog", async () => {
    const { getByRole, getAllByRole, queryByRole } = renderBanner();
    fireEvent.click(getByRole("button", { name: "Skip for today" }));
    const confirm = getAllByRole("button", { name: "Skip for today" }).at(-1)!;
    await act(async () => {
      fireEvent.click(confirm);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(queryByRole("dialog")).toBeNull();
  });

  test("warns that auto top-ups keep charging when they are on", () => {
    autoTopUpResponse = { ...AUTO_TOP_UP_OFF, enabled: true };
    const { getByRole } = renderBanner();
    fireEvent.click(getByRole("button", { name: "Skip for today" }));
    expect(getByRole("dialog").textContent).toContain(
      "your card can be charged again today",
    );
  });

  test("omits the top-up warning when top-ups are off", () => {
    const { getByRole } = renderBanner();
    fireEvent.click(getByRole("button", { name: "Skip for today" }));
    expect(getByRole("dialog").textContent).not.toContain(
      "your card can be charged",
    );
  });

  test("omits the top-up warning when the top-up state is unknown", () => {
    // An errored query is not evidence that top-ups are on, and claiming a
    // card will be charged when we cannot tell is worse than staying silent.
    autoTopUpShouldFail = true;
    const { getByRole } = renderBanner();
    fireEvent.click(getByRole("button", { name: "Skip for today" }));
    expect(getByRole("dialog").textContent).not.toContain(
      "your card can be charged",
    );
  });
});
