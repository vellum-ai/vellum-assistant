/**
 * Tests for DailyCreditLimitCard:
 *  - renders the current per-org limit in the input when one is set
 *  - the extra-usage subtitle shows under the toggle only while it is on
 *  - saving a new value PUTs the two-decimal limit body
 *  - turning the toggle off PUTs `daily_credit_limit_usd: null` to clear it
 *  - below-minimum input shows an inline error and does NOT call the API
 *  - the toggle is locked (with explanatory copy) while a saved limit is what
 *    enabled auto top-ups depend on
 *  - an org with auto top-up on but no saved limit can still take back an
 *    unsaved enable
 *  - a server-rejected clear renders the DRF field error, not the generic copy
 *  - an errored auto top-up query fails open so the toggle still clears the
 *    limit, including when the error lands on top of stale cached data
 *  - a pending limit query renders shimmer rows, not loading copy, and the
 *    deep-link scroll still waits for that content
 *  - the skeleton also holds while the billing-summary or auto top-up query is
 *    still pending, so the card reveals once at its final height
 *  - a failed sibling query settles the skeleton instead of stranding it
 *  - `validateDailyLimit` bounds checks (pure)
 *  - the exported anchor id stays in sync with the deep-link route constant
 *
 * Every response the card reads is seeded into the React Query cache so the
 * first render resolves synchronously, and *every* SDK call the card makes is
 * mocked at the SDK boundary. Both halves are load-bearing: React Query
 * refetches seeded entries on mount, so an unmocked endpoint would reach the
 * real network, and a failed refetch flips the query to `error` (keeping the
 * stale data), which renders the card's load-failure notice and breaks any
 * assertion that waits.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";

import * as sdkGen from "@/generated/api/sdk.gen";
import type {
  AutoTopUpConfigResponse,
  BillingSummaryResponse,
  DailyCreditLimitResponse,
} from "@/generated/api/types.gen";

let updateCalls: Array<Record<string, unknown>> = [];
let resumeCalls: Array<Record<string, unknown>> = [];
let updateError: unknown = null;
let resumeError: unknown = null;
let limitResponse: DailyCreditLimitResponse;
let summaryResponse: BillingSummaryResponse;
let autoTopUpResponse: AutoTopUpConfigResponse;
let autoTopUpShouldFail = false;
let summaryShouldFail = false;
// Hold a GET unresolved so the card stays in its loading branch. One flag per
// query, because the reveal now waits for all three.
let limitRetrieveNeverSettles = false;
let summaryRetrieveNeverSettles = false;
let autoTopUpRetrieveNeverSettles = false;

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
    if (autoTopUpRetrieveNeverSettles) {
      return new Promise(() => {});
    }
    if (autoTopUpShouldFail) {
      return Promise.reject(new Error("auto top-up unavailable"));
    }
    return Promise.resolve({ data: autoTopUpResponse, response: { ok: true } });
  },
  organizationsBillingDailyCreditLimitRetrieve: () =>
    limitRetrieveNeverSettles
      ? new Promise(() => {})
      : Promise.resolve({ data: limitResponse, response: { ok: true } }),
  organizationsBillingSummaryRetrieve: () => {
    if (summaryRetrieveNeverSettles) {
      return new Promise(() => {});
    }
    if (summaryShouldFail) {
      return Promise.reject(new Error("summary unavailable"));
    }
    return Promise.resolve({ data: summaryResponse, response: { ok: true } });
  },
  organizationsBillingDailyCreditLimitSkipTodayDestroy: (
    opts: Record<string, unknown>,
  ) => {
    resumeCalls.push(opts);
    if (resumeError !== null) {
      return Promise.reject(resumeError);
    }
    // Ending a skip returns the limit with the skip cleared.
    limitResponse = { ...limitResponse, daily_limit_snoozed: false };
    return Promise.resolve({ data: limitResponse, response: { ok: true } });
  },
}));

import {
  organizationsBillingAutoTopUpRetrieveQueryKey,
  organizationsBillingDailyCreditLimitRetrieveQueryKey,
  organizationsBillingSummaryRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";

import { routes } from "@/utils/routes";

const {
  DAILY_CREDIT_LIMIT_ANCHOR_ID,
  DailyCreditLimitCard,
  validateDailyLimit,
} = await import("./daily-credit-limit-card");

const AUTO_TOP_UP_OFF: AutoTopUpConfigResponse = {
  enabled: false,
  threshold_usd: null,
  amount_usd: null,
  monthly_cap_usd: null,
  has_payment_method: false,
  payment_method_brand: null,
  payment_method_last4: null,
  payment_method_exp_month: null,
  payment_method_exp_year: null,
  billing_address: null,
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

/**
 * The card reads only `daily_spend_usd` / `daily_limit_reached` off the billing
 * summary, but the endpoint returns the whole balance payload, so the fixture
 * carries it.
 */
const SUMMARY: BillingSummaryResponse = {
  settled_balance: "20.00",
  minimum_top_up: "5.00",
  maximum_top_up: "100.00",
  maximum_balance: "500.00",
  allowed_top_up_amounts: ["5.00", "10.00", "25.00"],
  settled_balance_usd: "20.00",
  minimum_top_up_usd: "5.00",
  maximum_top_up_usd: "100.00",
  maximum_balance_usd: "500.00",
  pending_compute: "0.00",
  pending_compute_usd: "0.00",
  effective_balance: "20.00",
  effective_balance_usd: "20.00",
  is_degraded: false,
  daily_credit_limit_usd: null,
  daily_spend_usd: "0.00",
  daily_limit_reached: false,
  daily_limit_snoozed: false,
  low_balance_threshold_usd: "5.00",
  low_balance_warning: false,
  credits_expiring_soon_usd: "0.00",
  next_credit_expiry_at: null,
};

/** No retries, so a rejected mock surfaces on the first attempt. */
function newClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

/**
 * Leaves the auto top-up query unseeded so the mocked GET drives it from
 * scratch, for the tests that exercise that query's own pending or error path.
 */
const UNSEEDED = "unseeded";

function makeClient(
  config: DailyCreditLimitResponse,
  autoTopUp: AutoTopUpConfigResponse | typeof UNSEEDED = AUTO_TOP_UP_OFF,
): QueryClient {
  const client = newClient();
  client.setQueryData(
    organizationsBillingDailyCreditLimitRetrieveQueryKey(),
    config,
  );
  client.setQueryData(
    organizationsBillingSummaryRetrieveQueryKey(),
    summaryResponse,
  );
  if (autoTopUp !== UNSEEDED) {
    client.setQueryData(
      organizationsBillingAutoTopUpRetrieveQueryKey(),
      autoTopUp,
    );
  }
  return client;
}

/**
 * Render the card with the daily-limit, billing-summary and auto top-up GETs
 * pre-seeded. All three are load-bearing: the card holds its skeleton until
 * every query that shapes a row has settled, so a test asserting synchronously
 * needs each of them already in the cache. Pass `UNSEEDED` to leave the auto
 * top-up query to the mocked GET instead.
 */
function renderCard(
  config: DailyCreditLimitResponse,
  autoTopUp: AutoTopUpConfigResponse | typeof UNSEEDED = AUTO_TOP_UP_OFF,
): ReturnType<typeof render> & { client: QueryClient } {
  limitResponse = config;
  if (autoTopUp !== UNSEEDED) {
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

/** Let queued promise callbacks (a fired mutation) run before asserting. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Wait for the mocked auto top-up GET to reject and settle the query. */
function settleAutoTopUpError(client: QueryClient): Promise<void> {
  return waitFor(() => {
    const state = client.getQueryState(
      organizationsBillingAutoTopUpRetrieveQueryKey(),
    );
    if (state?.status !== "error") {
      throw new Error("auto top-up query not settled");
    }
  });
}

const OFF: DailyCreditLimitResponse = {
  daily_credit_limit_usd: null,
  current_day_spent_usd: "0.00",
  day_bucket: null,
  daily_limit_snoozed: false,
  daily_limit_snoozed_day_bucket: null,
};

const ON: DailyCreditLimitResponse = {
  ...OFF,
  daily_credit_limit_usd: "25.00",
};

beforeEach(() => {
  updateCalls = [];
  resumeCalls = [];
  updateError = null;
  resumeError = null;
  limitResponse = { ...OFF };
  summaryResponse = { ...SUMMARY };
  autoTopUpResponse = { ...AUTO_TOP_UP_OFF };
  autoTopUpShouldFail = false;
  summaryShouldFail = false;
  limitRetrieveNeverSettles = false;
  summaryRetrieveNeverSettles = false;
  autoTopUpRetrieveNeverSettles = false;
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

describe("DailyCreditLimitCard skipped state", () => {
  const SKIPPED: DailyCreditLimitResponse = {
    ...ON,
    daily_limit_snoozed: true,
    daily_limit_snoozed_day_bucket: "2026-07-20",
  };

  test("surfaces that the limit is skipped for today", () => {
    // Without this the page would show a configured limit with no hint that
    // it is not in force, which is the UI lying about the user's own money
    // control.
    const { getByTestId } = renderCard(SKIPPED);
    const notice = getByTestId("daily-credit-limit-skipped");
    expect(notice.textContent).toContain("Skipped for today");
  });

  test("stays quiet when no skip is active", () => {
    const { queryByTestId } = renderCard(ON);
    expect(queryByTestId("daily-credit-limit-skipped")).toBeNull();
  });

  test("a skip from a prior day does not render as active", () => {
    // The server decides expiry; the client must not re-derive it from the
    // raw bucket.
    const { queryByTestId } = renderCard({
      ...ON,
      daily_limit_snoozed: false,
      daily_limit_snoozed_day_bucket: "2020-01-01",
    });
    expect(queryByTestId("daily-credit-limit-skipped")).toBeNull();
  });

  test("Resume now ends the skip", async () => {
    const { getByTestId } = renderCard(SKIPPED);
    // Wrapped in `act` because the mutation's success handler invalidates two
    // queries, and those refetches settle after the click returns.
    await act(async () => {
      fireEvent.click(getByTestId("daily-credit-limit-resume-button"));
      await flushMicrotasks();
    });
    expect(resumeCalls.length).toBe(1);
  });

  test("a rejected Resume now says the limit is still skipped", async () => {
    // Silence here reads as success, and the user walks away believing the
    // limit is back on when it is not.
    resumeError = new Error("network down");
    const { getByTestId, queryByTestId } = renderCard(SKIPPED);
    await act(async () => {
      fireEvent.click(getByTestId("daily-credit-limit-resume-button"));
      await flushMicrotasks();
    });
    expect(queryByTestId("daily-credit-limit-resume-error")).not.toBeNull();
    expect(queryByTestId("daily-credit-limit-skipped")).not.toBeNull();
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

  test("shows the extra-usage subtitle only while the toggle is on", () => {
    const { container, getByRole } = renderCard(OFF);
    expect(container.textContent).not.toContain(
      "Daily limit only applies to extra usage credits",
    );
    fireEvent.click(getByRole("switch"));
    expect(container.textContent).toContain(
      "Daily limit only applies to extra usage credits",
    );
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
      "A daily credit limit is required while auto-reload is enabled.",
    );

    // The guard holds even if the click lands (e.g. a programmatic change):
    // the limit is never cleared.
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(updateCalls.length).toBe(0);
  });

  test("lets an org with no saved limit take back an unsaved enable", async () => {
    // Predates the backend default: auto top-ups are on, but no limit was ever
    // persisted, so nothing the backend depends on is at stake yet.
    const { getByRole, queryByTestId } = renderCard(OFF, AUTO_TOP_UP_ON);

    const toggle = getByRole("switch") as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);

    fireEvent.click(toggle);
    expect(queryByTestId("daily-credit-limit-input")).not.toBeNull();
    expect(toggle.disabled).toBe(false);

    fireEvent.click(toggle);
    expect(queryByTestId("daily-credit-limit-input")).toBeNull();
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    // There was no saved limit to clear, so the off-flip is local only.
    await flushMicrotasks();
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
    const { client, getByRole, queryByTestId } = renderCard(ON, UNSEEDED);

    await settleAutoTopUpError(client);

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

  test("fails open when an errored refetch lands on top of stale enabled data", async () => {
    // React Query keeps serving the cached config alongside the error, so
    // reading `data.enabled` alone would keep enforcing an auto top-up the
    // user may have already disabled from another client.
    autoTopUpShouldFail = true;
    const { client, getByRole, queryByTestId } = renderCard(ON, AUTO_TOP_UP_ON);

    await settleAutoTopUpError(client);
    expect(
      client.getQueryState(organizationsBillingAutoTopUpRetrieveQueryKey())
        ?.data,
    ).toEqual(AUTO_TOP_UP_ON);

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

describe("DailyCreditLimitCard loading state", () => {
  /** Render inside the anchor container `BillingPanel` wraps the card in. */
  function renderAtAnchor(client: QueryClient): ReturnType<typeof render> {
    return render(
      <QueryClientProvider client={client}>
        <div id={DAILY_CREDIT_LIMIT_ANCHOR_ID}>
          <DailyCreditLimitCard />
        </div>
      </QueryClientProvider>,
    );
  }

  /** Seed every query except the one whose pending state is under test. */
  function clientWithout(pending: "summary" | "autoTopUp"): QueryClient {
    const client = newClient();
    client.setQueryData(
      organizationsBillingDailyCreditLimitRetrieveQueryKey(),
      OFF,
    );
    if (pending !== "summary") {
      client.setQueryData(
        organizationsBillingSummaryRetrieveQueryKey(),
        summaryResponse,
      );
    }
    if (pending !== "autoTopUp") {
      client.setQueryData(
        organizationsBillingAutoTopUpRetrieveQueryKey(),
        AUTO_TOP_UP_OFF,
      );
    }
    return client;
  }

  test("a pending limit renders shimmer rows, not loading copy", () => {
    limitRetrieveNeverSettles = true;
    const { getByTestId } = renderAtAnchor(newClient());

    const card = getByTestId("daily-credit-limit-card");
    expect(card.querySelectorAll('[data-slot="skeleton"]').length).toBe(2);
    expect(
      card.querySelector('[role="status"]')?.getAttribute("aria-label"),
    ).toBe("Loading daily credit limit settings");
    expect(card.textContent).toBe("");
  });

  test("a resolved limit keeps the skeleton while the summary is pending", () => {
    // The summary carries `daily_limit_reached` / `daily_limit_snoozed`, so
    // revealing on the limit alone lets those notices append after the fade in
    // and grow the Credits card a second time.
    summaryRetrieveNeverSettles = true;
    const { getByTestId, queryByRole } = renderAtAnchor(
      clientWithout("summary"),
    );

    expect(queryByRole("switch")).toBeNull();
    expect(
      getByTestId("daily-credit-limit-card").querySelectorAll(
        '[data-slot="skeleton"]',
      ).length,
    ).toBe(2);
  });

  test("a resolved limit keeps the skeleton while auto top-up is pending", () => {
    // Auto top-up decides the required note, another row that would otherwise
    // land after the reveal.
    autoTopUpRetrieveNeverSettles = true;
    const { getByTestId, queryByRole } = renderAtAnchor(
      clientWithout("autoTopUp"),
    );

    expect(queryByRole("switch")).toBeNull();
    expect(
      getByTestId("daily-credit-limit-card").querySelectorAll(
        '[data-slot="skeleton"]',
      ).length,
    ).toBe(2);
  });

  test("a failed summary settles the reveal instead of stranding it", async () => {
    // Settled-with-error is settled: the card already falls back to the limit
    // payload for today's spend, so a broken summary must not hold the
    // skeleton open forever.
    summaryShouldFail = true;
    const { queryByRole } = renderAtAnchor(clientWithout("summary"));

    await waitFor(() => {
      if (queryByRole("switch") == null) {
        throw new Error("the card never revealed after the summary failed");
      }
    });
  });

  test("the deep-link scroll still waits for the resolved card", async () => {
    // The skeleton is the same node the anchor points at, so scrolling to it
    // while the card is still loading would land the user above content that
    // has not taken its final height yet.
    const proto = window.Element.prototype;
    const originalScroll = proto.scrollIntoView;
    const originalHash = window.location.hash;
    let scrolls = 0;
    proto.scrollIntoView = function countScroll(): void {
      scrolls += 1;
    };
    window.location.hash = `#${DAILY_CREDIT_LIMIT_ANCHOR_ID}`;

    try {
      limitRetrieveNeverSettles = true;
      renderAtAnchor(newClient());
      expect(scrolls).toBe(0);
      cleanup();

      // A resolved limit alone is not the final height either: the summary can
      // still append the reached or skipped notice below the anchor.
      limitRetrieveNeverSettles = false;
      summaryRetrieveNeverSettles = true;
      renderAtAnchor(clientWithout("summary"));
      expect(scrolls).toBe(0);
      cleanup();

      summaryRetrieveNeverSettles = false;
      renderAtAnchor(makeClient(OFF));
      await waitFor(() => {
        if (scrolls === 0) {
          throw new Error("the resolved card never scrolled to the anchor");
        }
      });
    } finally {
      proto.scrollIntoView = originalScroll;
      window.location.hash = originalHash;
    }
  });
});
