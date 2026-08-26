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
/** The raw wallet balance, which BYOK suppression never touches. */
let effectiveBalance: string | null = null;
let availableUsageBalance: string | null = null;
let totalUsageBalance: string | null = null;
/** What the panel asked the wallet status to classify against. */
let balanceStatusOpts: unknown;
mock.module("@/hooks/use-billing-balance-status", () => ({
  useBillingBalanceStatus: (opts?: unknown) => {
    balanceStatusOpts = opts;
    return {
      isExhausted: creditsExhausted,
      isLowBalance: false,
      dailyLimitReached: false,
      dailyLimitSnoozed: false,
      dailyLimit: null,
      dailySpend: null,
      balance: effectiveBalance,
      availableUsageBalance,
      totalUsageBalance,
      enabled: billingEnabled,
    };
  },
}));

// The real BYOK gate classifies through five daemon queries and the
// resolved-assistants store, none of which these tests stand up; what the
// hook owns is only how the verdict gates the extra-credits claim.
let byokRoute = false;
mock.module("@/hooks/use-byok-credit-banner-gate", () => ({
  useSuppressCreditBannersForByok: (candidate: boolean) =>
    candidate && byokRoute,
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
    conversationId?: string | null;
    /** Renders with no add-credits handler, the way native Android does. */
    withoutAddCredits?: boolean;
  } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <PreferencesUsagePanel
        onOpenBilling={handlers.onOpenBilling ?? (() => {})}
        onAddCredits={
          handlers.withoutAddCredits
            ? undefined
            : (handlers.onAddCredits ?? (() => {}))
        }
        conversationId={handlers.conversationId}
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
  effectiveBalance = null;
  availableUsageBalance = null;
  totalUsageBalance = null;
  byokRoute = false;
  balanceStatusOpts = undefined;
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

  test("classifies the wallet against the conversation it renders for", async () => {
    renderPanel({ conversationId: "conv-1" });

    await settle();
    // A per-conversation profile pin only refines the reading if the wallet
    // status knows which chat is open.
    expect(balanceStatusOpts).toEqual({ conversationId: "conv-1" });
  });

  test("no conversation classifies against the default route", async () => {
    renderPanel();

    await settle();
    expect(balanceStatusOpts).toEqual({ conversationId: null });
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

  test("a free plan reads its usage grant with nothing to reset", async () => {
    // $3.40 of the $5.00 this account was granted.
    subscription = { ...proSubscription(), plan_id: "base", package: null };
    totalUsageBalance = "5.00";
    availableUsageBalance = "1.60";
    const { findByTestId } = renderPanel();

    const panel = await findByTestId("preferences-usage");
    expect(panel.textContent).toContain("68% used");
    expect(panel.textContent).not.toContain("Resets");
  });

  test("a free plan with an empty wallet raises the strip", async () => {
    subscription = { ...proSubscription(), plan_id: "base", package: null };
    totalUsageBalance = "5.00";
    availableUsageBalance = "0.00";
    effectiveBalance = "0.00";
    creditsExhausted = true;
    const { findByTestId, getByText } = renderPanel();

    const panel = await findByTestId("preferences-usage");
    expect(panel.textContent).toContain("100% used");
    expect(panel.textContent).not.toContain("Resets");
    expect(getByText("Add credits to continue.")).toBeTruthy();
  });

  test("a used-up grant with purchased credits names the extra credits", async () => {
    // The grant is gone, but bought credits still cover the next turn, so the
    // panel says what it is drawing on and offers nothing.
    subscription = { ...proSubscription(), plan_id: "base", package: null };
    totalUsageBalance = "5.00";
    availableUsageBalance = "0.00";
    effectiveBalance = "12.00";
    const { findByTestId, getByText, queryByText, queryByTestId } =
      renderPanel();

    const panel = await findByTestId("preferences-usage");
    expect(getByText("Now using extra usage credits")).toBeTruthy();
    expect(panel.textContent).not.toContain("100% used");
    expect(queryByText("Add credits to continue.")).toBeNull();
    expect(queryByTestId("preferences-usage-add-credits")).toBeNull();
  });

  test("the gear hands the billing page to its caller", async () => {
    const onOpenBilling = mock(() => {});
    const { findByTestId } = renderPanel({ onOpenBilling });

    fireEvent.click(await findByTestId("preferences-usage-settings"));
    expect(onOpenBilling).toHaveBeenCalledTimes(1);
  });

  test("a spent bundle with an empty wallet raises the strip", async () => {
    usageTotalUsd = "25";
    effectiveBalance = "0.00";
    creditsExhausted = true;
    const onAddCredits = mock(() => {});
    const { findByTestId, getByText, queryByText } = renderPanel({
      onAddCredits,
    });

    const panel = await findByTestId("preferences-usage");
    // Exhausted keeps the red reading: there are no extra credits to name.
    expect(panel.textContent).toContain("100% used");
    expect(queryByText("Now using extra usage credits")).toBeNull();
    expect(getByText("Add credits to continue.")).toBeTruthy();
    expect(
      panel
        .querySelector('[data-slot="progress-bar-fill"]')
        ?.getAttribute("style"),
    ).toContain("--system-negative-strong");

    fireEvent.click(await findByTestId("preferences-usage-add-credits"));
    expect(onAddCredits).toHaveBeenCalledTimes(1);
  });

  test("without a handler the strip states its case and offers nothing", async () => {
    usageTotalUsd = "25";
    effectiveBalance = "0.00";
    creditsExhausted = true;
    const { findByTestId, getByText, queryByTestId } = renderPanel({
      withoutAddCredits: true,
    });

    const panel = await findByTestId("preferences-usage");
    expect(panel.textContent).toContain("100% used");
    expect(getByText("Add credits to continue.")).toBeTruthy();
    expect(queryByTestId("preferences-usage-add-credits")).toBeNull();
  });

  test("a spent bundle swaps the bar for the extra-credits line", async () => {
    usageTotalUsd = "25";
    effectiveBalance = "18.00";
    const { findByTestId, getByText, queryByTestId, queryByText } =
      renderPanel();

    const panel = await findByTestId("preferences-usage");
    await waitFor(() => {
      expect(getByText("Now using extra usage credits")).toBeTruthy();
    });
    // Amber, not red: nothing has gone wrong yet, the wallet behind the
    // bundle still has something to draw on, so the line names it while the
    // percentage, the bar, and the strip all stay away.
    expect(getByText("Now using extra usage credits").className).toContain(
      "--system-mid-strong",
    );
    expect(panel.textContent).not.toContain("100% used");
    expect(panel.querySelector('[data-slot="progress-bar-fill"]')).toBeNull();
    expect(queryByText("Add credits to continue.")).toBeNull();
    expect(queryByTestId("preferences-usage-add-credits")).toBeNull();
  });

  test("a BYOK route with an empty wallet keeps the red reading", async () => {
    // The BYOK gate holds `isExhausted` down so the credit wall stays away,
    // but the wallet is empty: the next turn runs on the user's own key, so
    // nothing may claim extra credits are being spent.
    usageTotalUsd = "25";
    effectiveBalance = "0.00";
    const { findByTestId, queryByText, queryByTestId } = renderPanel();

    const panel = await findByTestId("preferences-usage");
    await waitFor(() => {
      expect(panel.textContent).toContain("100% used");
    });
    expect(queryByText("Now using extra usage credits")).toBeNull();
    expect(
      panel
        .querySelector('[data-slot="progress-bar-fill"]')
        ?.getAttribute("style"),
    ).toContain("--system-negative-strong");
    expect(queryByText("Add credits to continue.")).toBeNull();
    expect(queryByTestId("preferences-usage-add-credits")).toBeNull();
  });

  test("a BYOK route with a positive wallet keeps the red reading", async () => {
    // The classifier proves the next turn dispatches on the user's own key,
    // so whatever the wallet holds is not what gets spent.
    usageTotalUsd = "25";
    effectiveBalance = "18.00";
    byokRoute = true;
    const { findByTestId, queryByText } = renderPanel();

    const panel = await findByTestId("preferences-usage");
    await waitFor(() => {
      expect(panel.textContent).toContain("100% used");
    });
    expect(queryByText("Now using extra usage credits")).toBeNull();
    expect(queryByText("Add credits to continue.")).toBeNull();
  });

  test("an unknown wallet withholds the extra-credits claim", async () => {
    // The summary has not landed, so the wallet may hold nothing: the spent
    // bundle keeps its red reading until there is credit to point at.
    usageTotalUsd = "25";
    effectiveBalance = null;
    const { findByTestId, queryByText } = renderPanel();

    const panel = await findByTestId("preferences-usage");
    await waitFor(() => {
      expect(panel.textContent).toContain("100% used");
    });
    expect(queryByText("Now using extra usage credits")).toBeNull();
    expect(queryByText("Add credits to continue.")).toBeNull();
  });

  test("a reading below 100% stays neutral", async () => {
    const { findByTestId, getByText } = renderPanel();

    const panel = await findByTestId("preferences-usage");
    expect(panel.textContent).toContain("40% used");
    expect(
      panel
        .querySelector('[data-slot="progress-bar-fill"]')
        ?.getAttribute("style"),
    ).not.toContain("--system-negative-strong");
    expect(getByText("40% used").className).not.toContain(
      "--system-negative-strong",
    );
  });
});
