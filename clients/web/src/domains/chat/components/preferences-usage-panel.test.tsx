/**
 * Tests for the preferences menu's usage panel.
 *
 * The panel composes the subscription, the plan catalog, and the usage totals
 * behind the `obscure-credits` flag, so the reads are driven from the SDK
 * boundary the way the billing hook tests drive them. The wallet status is
 * mocked: the real hook needs the platform gate and the org store, neither of
 * which these tests stand up.
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
  PlanListResponse,
  SubscriptionResponse,
} from "@/generated/api/types.gen";

let usageTotalUsd = "10";
let subscription: SubscriptionResponse | null = proSubscription();
let plans: PlanListResponse = proPlans();

mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  organizationsBillingSubscriptionRetrieve: () =>
    Promise.resolve({ data: subscription, response: { ok: true } }),
  organizationsBillingPlansRetrieve: () =>
    Promise.resolve({ data: plans, response: { ok: true } }),
  organizationsBillingUsageTotalsRetrieve: () =>
    Promise.resolve({
      data: { total_usd: usageTotalUsd, event_count: 2 },
      response: { ok: true },
    }),
}));

let billingEnabled = true;
let creditsExhausted = false;
mock.module("@/hooks/use-billing-balance-status", () => ({
  useBillingBalanceStatus: () => ({
    isExhausted: creditsExhausted,
    isLowBalance: false,
    dailyLimitReached: false,
    dailyLimitSnoozed: false,
    dailyLimit: null,
    dailySpend: null,
    balance: null,
    enabled: billingEnabled,
  }),
}));

const { PreferencesUsagePanel } = await import("./preferences-usage-panel");
const { useClientFeatureFlagStore } =
  await import("@/stores/client-feature-flag-store");

/** Drives the `obscure-credits` client flag the way the app's LD sync does. */
function setObscureCredits(value: boolean): void {
  act(() => {
    useClientFeatureFlagStore
      .getState()
      .setFlags({ obscureCredits: value }, null);
  });
}

function proSubscription(): SubscriptionResponse {
  return {
    plan_id: "pro",
    status: "active",
    renewal_date: null,
    current_period_start: "2026-07-10T00:00:00Z",
    current_period_end: "2026-08-10T00:00:00Z",
    cancel_at_period_end: false,
    cancel_at: null,
    package: { key: "mighty", name: "Mighty", version: 1, customized: false },
    entitlements: { managed_email: false, phone_number: false },
  };
}

/** A catalog whose Mighty package includes a $25 monthly bundle. */
function proPlans(): PlanListResponse {
  return {
    plans: [
      {
        id: "pro",
        packages: [
          {
            key: "mighty",
            name: "Mighty",
            version: 1,
            machine_size: null,
            credits_usd: 25,
            storage_gib: 10,
          },
        ],
      },
    ],
  } as unknown as PlanListResponse;
}

function renderPanel(
  handlers: {
    onOpenBilling?: () => void;
    onAddCredits?: () => void;
  } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <PreferencesUsagePanel
        onOpenBilling={handlers.onOpenBilling ?? (() => {})}
        onAddCredits={handlers.onAddCredits ?? (() => {})}
      />
    </QueryClientProvider>,
  );
}

/** Lets both catalog reads settle inside `act`, so nothing lands mid-assert. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** The panel's reset date, formatted the way the panel formats it. */
function resetLabel(iso: string): string {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
  }).format(new Date(iso));
}

beforeEach(() => {
  usageTotalUsd = "10";
  subscription = proSubscription();
  plans = proPlans();
  billingEnabled = true;
  creditsExhausted = false;
  setObscureCredits(true);
});

afterEach(() => {
  setObscureCredits(false);
  cleanup();
});

describe("PreferencesUsagePanel", () => {
  test("reads the share of the bundle spent this cycle", async () => {
    const { findByTestId } = renderPanel();

    // $10 of Mighty's $25 bundle.
    const panel = await findByTestId("preferences-usage");
    expect(panel.textContent).toContain("Usage");
    expect(panel.textContent).toContain("40% used");
    expect(panel.textContent).toContain(
      `Resets ${resetLabel("2026-08-10T00:00:00Z")}`,
    );
  });

  test("renders nothing while the flag is off", async () => {
    setObscureCredits(false);
    const { queryByTestId } = renderPanel();

    await settle();
    expect(queryByTestId("preferences-usage")).toBeNull();
  });

  test("renders nothing without managed billing to read", async () => {
    billingEnabled = false;
    const { queryByTestId } = renderPanel();

    await settle();
    expect(queryByTestId("preferences-usage")).toBeNull();
  });

  test("renders nothing for a sub with no included bundle", async () => {
    subscription = { ...proSubscription(), plan_id: "base", package: null };
    const { queryByTestId } = renderPanel();

    await settle();
    expect(queryByTestId("preferences-usage")).toBeNull();
  });

  test("the gear hands the billing page to its caller", async () => {
    const onOpenBilling = mock(() => {});
    const { findByTestId } = renderPanel({ onOpenBilling });

    fireEvent.click(await findByTestId("preferences-usage-settings"));
    expect(onOpenBilling).toHaveBeenCalledTimes(1);
  });

  test("a spent bundle with an empty wallet raises the strip", async () => {
    usageTotalUsd = "25";
    creditsExhausted = true;
    const onAddCredits = mock(() => {});
    const { findByTestId, getByText } = renderPanel({ onAddCredits });

    const panel = await findByTestId("preferences-usage");
    expect(panel.textContent).toContain("100% used");
    expect(getByText("Add credits to continue.")).toBeTruthy();
    expect(
      panel
        .querySelector('[data-slot="progress-bar-fill"]')
        ?.getAttribute("style"),
    ).toContain("--system-negative-strong");

    fireEvent.click(await findByTestId("preferences-usage-add-credits"));
    expect(onAddCredits).toHaveBeenCalledTimes(1);
  });

  test("a spent bundle with credits still in hand stays neutral", async () => {
    usageTotalUsd = "25";
    const { findByTestId, queryByTestId, queryByText } = renderPanel();

    const panel = await findByTestId("preferences-usage");
    await waitFor(() => {
      expect(panel.textContent).toContain("100% used");
    });
    expect(queryByText("Add credits to continue.")).toBeNull();
    expect(queryByTestId("preferences-usage-add-credits")).toBeNull();
  });
});
