/**
 * Tests for DailyCreditLimitCard:
 *  - renders the current per-org limit in the input when one is set
 *  - saving a new value PUTs the two-decimal limit body
 *  - turning the toggle off PUTs `daily_credit_limit_usd: null` to clear it
 *  - below-minimum input shows an inline error and does NOT call the API
 *  - the toggle is locked (with explanatory copy) while auto top-up is enabled
 *  - a server-rejected clear renders the DRF field error, not the generic copy
 *  - a failed auto top-up query fails open so the toggle still clears the limit
 *  - `validateDailyLimit` bounds checks (pure)
 *  - the exported anchor id stays in sync with the deep-link route constant
 *
 * The GET is seeded directly into the React Query cache so `useQuery` resolves
 * synchronously; the PUT and the auto top-up GET are mocked at the SDK boundary
 * to capture the request body and to drive the auto top-up dependency.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import * as sdkGen from "@/generated/api/sdk.gen";
import type {
  AutoTopUpConfigResponse,
  DailyCreditLimitResponse,
} from "@/generated/api/types.gen";

let updateCalls: Array<Record<string, unknown>> = [];
let updateError: unknown = null;
let autoTopUpResponse: AutoTopUpConfigResponse;
let autoTopUpShouldFail = false;

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
        day_bucket: body.daily_credit_limit_usd == null ? null : "2026-07-20",
      },
      response: { ok: true },
    });
  },
  organizationsBillingAutoTopUpRetrieve: () => {
    if (autoTopUpShouldFail) {
      return Promise.reject(new Error("auto top-up unavailable"));
    }
    return Promise.resolve({ data: autoTopUpResponse, response: { ok: true } });
  },
}));

import {
  organizationsBillingAutoTopUpRetrieveQueryKey,
  organizationsBillingDailyCreditLimitRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";

import { routes } from "@/utils/routes";

const { DAILY_CREDIT_LIMIT_ANCHOR_ID, DailyCreditLimitCard, validateDailyLimit } =
  await import("./daily-credit-limit-card");

const AUTO_TOP_UP_OFF: AutoTopUpConfigResponse = {
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
};

const AUTO_TOP_UP_ON: AutoTopUpConfigResponse = {
  ...AUTO_TOP_UP_OFF,
  enabled: true,
  threshold_usd: "50.00",
  amount_usd: "200.00",
  has_payment_method: true,
};

function makeClient(
  config: DailyCreditLimitResponse,
  autoTopUp?: AutoTopUpConfigResponse,
): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(
    organizationsBillingDailyCreditLimitRetrieveQueryKey(),
    config,
  );
  if (autoTopUp) {
    client.setQueryData(
      organizationsBillingAutoTopUpRetrieveQueryKey(),
      autoTopUp,
    );
  }
  return client;
}

/**
 * Render the card with the daily-limit GET pre-seeded. `autoTopUp` seeds the
 * auto top-up GET too (and backs its refetch). Omit it to leave that query
 * unresolved, which is the fail-open path.
 */
function renderCard(
  config: DailyCreditLimitResponse,
  autoTopUp?: AutoTopUpConfigResponse,
): ReturnType<typeof render> & { client: QueryClient } {
  if (autoTopUp) {
    autoTopUpResponse = autoTopUp;
  }
  const client = makeClient(config, autoTopUp);
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <DailyCreditLimitCard />
      </QueryClientProvider>,
    ),
  };
}

const OFF: DailyCreditLimitResponse = {
  daily_credit_limit_usd: null,
  current_day_spent_usd: "0.00",
  day_bucket: null,
};

const ON: DailyCreditLimitResponse = {
  ...OFF,
  daily_credit_limit_usd: "25.00",
};

beforeEach(() => {
  updateCalls = [];
  updateError = null;
  autoTopUpResponse = { ...AUTO_TOP_UP_OFF };
  autoTopUpShouldFail = false;
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
    const { getByTestId } = renderCard({
      ...OFF,
      daily_credit_limit_usd: "25.00",
    });
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
    const { getByRole } = renderCard({
      ...OFF,
      daily_credit_limit_usd: "25.00",
    });
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

describe("DAILY_CREDIT_LIMIT_ANCHOR_ID", () => {
  test("matches the hash in the deep-link route constant", () => {
    expect(
      routes.settings.usageBillingDailyLimit.endsWith(
        `#${DAILY_CREDIT_LIMIT_ANCHOR_ID}`,
      ),
    ).toBe(true);
  });
});

describe("DailyCreditLimitCard auto top-up dependency", () => {
  test("locks the toggle and explains why while auto top-up is enabled", () => {
    const { getByRole, getByTestId } = renderCard(ON, AUTO_TOP_UP_ON);

    const toggle = getByRole("switch") as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(getByTestId("daily-credit-limit-required-note").textContent).toBe(
      "A daily credit limit is required while automatic top-ups are enabled.",
    );

    // The guard holds even if the click lands (e.g. a programmatic change):
    // the limit is never cleared.
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(updateCalls.length).toBe(0);
  });

  test("leaves the toggle usable and the note hidden while auto top-up is off", () => {
    const { getByRole, queryByTestId } = renderCard(ON, AUTO_TOP_UP_OFF);

    expect((getByRole("switch") as HTMLButtonElement).disabled).toBe(false);
    expect(queryByTestId("daily-credit-limit-required-note")).toBeNull();
  });

  test("renders the server field error when the clear is rejected", async () => {
    updateError = {
      daily_credit_limit_usd: [
        "Disable automatic top-ups before removing the daily credit limit.",
      ],
    };
    const { getByRole, getByTestId } = renderCard(ON, AUTO_TOP_UP_OFF);

    fireEvent.click(getByRole("switch"));

    const notice = await waitFor(() =>
      getByTestId("daily-credit-limit-update-error"),
    );
    expect(notice.textContent).toContain(
      "Disable automatic top-ups before removing the daily credit limit.",
    );
    expect(notice.textContent).not.toContain("Failed to save");
  });

  test("falls back to the generic error when the failure carries no field errors", async () => {
    updateError = new Error("network down");
    const { getByRole, getByTestId } = renderCard(ON, AUTO_TOP_UP_OFF);

    fireEvent.click(getByRole("switch"));

    const notice = await waitFor(() =>
      getByTestId("daily-credit-limit-update-error"),
    );
    expect(notice.textContent).toContain("Failed to save daily credit limit.");
  });

  test("fails open when the auto top-up query errors", async () => {
    autoTopUpShouldFail = true;
    const { client, getByRole, queryByTestId } = renderCard(ON);

    await waitFor(() => {
      const state = client.getQueryState(
        organizationsBillingAutoTopUpRetrieveQueryKey(),
      );
      if (state?.status !== "error") {
        throw new Error("auto top-up query not settled");
      }
    });

    // The server still enforces the invariant, so an unknown auto top-up state
    // must not strand the user with a toggle they cannot turn off.
    expect(queryByTestId("daily-credit-limit-required-note")).toBeNull();
    const toggle = getByRole("switch") as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);

    fireEvent.click(toggle);

    await waitFor(() => {
      if (updateCalls.length === 0) {
        throw new Error("PUT not called");
      }
    });
    expect(updateCalls[0]!.body).toEqual({ daily_credit_limit_usd: null });
  });
});
