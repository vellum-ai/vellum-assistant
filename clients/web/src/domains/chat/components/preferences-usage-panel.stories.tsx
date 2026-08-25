/**
 * The preferences menu's usage reading while `obscure-credits` is on.
 *
 * Unlike the billing tile's `UsageBalancePanel`, this one composes itself: the
 * subscription, the plan catalog, and the cycle's usage totals arrive through
 * TanStack Query, the wallet status arrives through `useBillingBalanceStatus`,
 * and the flag arrives through the client feature-flag store. Every one of
 * those is seeded here through its real read seam, so what renders is the
 * production path rather than a lookalike.
 *
 * Two things make the seeding work. TanStack Query serves cached data even
 * while a query's `enabled` is false, so priming the cache is enough for all
 * four billing reads. And `useBillingBalanceStatus` refuses to look at the
 * summary until the platform gate, the assistant lifecycle, and the org store
 * all say the org has managed billing, so those three stores are seeded too.
 */
import type { ReactNode } from "react";
import { useLayoutEffect, useState } from "react";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import { CreditsCard } from "@/domains/chat/components/credits-card";
import { showsMenuCredits } from "@/domains/chat/components/preferences-menu";
import { PreferencesUsagePanel } from "@/domains/chat/components/preferences-usage-panel";
import { usePreferencesUsage } from "@/domains/chat/hooks/use-preferences-usage";
import {
  organizationsBillingPlansRetrieveOptions,
  organizationsBillingSubscriptionRetrieveOptions,
  organizationsBillingSummaryRetrieveQueryKey,
  organizationsBillingUsageTotalsRetrieveOptions,
} from "@/generated/api/@tanstack/react-query.gen";
import type {
  PlanListResponse,
  ProPackage,
  SubscriptionResponse,
} from "@/generated/api/types.gen";
import { useBillingBalanceStatus } from "@/hooks/use-billing-balance-status";
import { useObscureCredits } from "@/hooks/use-obscure-credits-flag";
import { displayedCreditsUsd } from "@/lib/billing/displayed-credits";
import { flagKeyToStoreKey } from "@/lib/feature-flags/feature-flag-catalog";
import { useAuthStore } from "@/stores/auth-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useOrganizationStore } from "@/stores/organization-store";

/** The store key the flag registry's `obscure-credits` entry is read under. */
const OBSCURE_CREDITS = flagKeyToStoreKey("obscure-credits");

const CYCLE_START = "2026-08-01T00:00:00Z";
const CYCLE_END = "2026-09-01T00:00:00Z";

/** The catalog's Mighty package, whose $25 bundle is the bar's denominator. */
const MIGHTY: ProPackage = {
  key: "mighty",
  name: "Mighty",
  description: "10 GB of storage and monthly Mighty Usage.",
  version: 1,
  machine_tier: null,
  storage_tier: "xs",
  credit_tier: "credits_25",
  machine_size: null,
  storage_gib: 10,
  credits_usd: 25,
  usage_label: "Mighty Usage",
  include_platform_fee: false,
  base_price_cents: 0,
  machine_price_cents: 0,
  storage_price_cents: 500,
  credit_price_cents: 2500,
  total_price_cents: 3000,
};

/** A Pro sub cleanly pinned to Mighty, which is what names the bundle. */
const SUBSCRIPTION: SubscriptionResponse = {
  plan_id: "pro",
  status: "active",
  renewal_date: null,
  current_period_start: CYCLE_START,
  current_period_end: CYCLE_END,
  cancel_at_period_end: false,
  cancel_at: null,
  package: { key: "mighty", name: "Mighty", version: 1, customized: false },
  entitlements: { managed_email: false, phone_number: false },
};

/** A free (base) sub: no package, no cycle, and nothing that resets. */
const FREE_SUBSCRIPTION: SubscriptionResponse = {
  plan_id: "base",
  status: "active",
  renewal_date: null,
  current_period_start: null,
  current_period_end: null,
  cancel_at_period_end: false,
  cancel_at: null,
  package: null,
  entitlements: { managed_email: false, phone_number: false },
};

const PLANS: PlanListResponse = {
  plans: [
    {
      id: "pro",
      name: "Pro",
      base_price_cents: 1000,
      base_lookup_key: "pro_base",
      billing_interval: "month",
      machine_tiers: [],
      storage_tiers: [],
      included_features: [],
      packages: [MIGHTY],
    },
  ],
};

/**
 * The window the usage read asks for: the cycle start through today. Derived
 * exactly as `usePlanUsageBalance` derives it, so the seeded entry lands on
 * the key the panel subscribes to.
 */
function usageWindow(): { from: string; to: string } {
  return {
    from: new Date(CYCLE_START).toISOString().slice(0, 10),
    to: new Date().toISOString().slice(0, 10),
  };
}

interface UsagePanelStoryArgs {
  /**
   * Which plan the seeded sub is on: `pro` measures the cycle against Mighty's
   * $25 bundle, `free` measures the usage grants off the billing summary.
   */
  plan: "pro" | "free";
  /** Managed usage spent this cycle, in USD. Ignored on a free plan. */
  spentUsd: string;
  /** Effective credit balance. At or below zero reads as an empty wallet. */
  balanceUsd: string;
  /** What the account's usage grants were worth, in USD. */
  totalUsageUsd: string;
  /** How much of those grants is still unused, in USD. */
  availableUsageUsd: string;
}

/** The panel on its own, which is what the menu shows most of the time. */
function PanelOnly() {
  return (
    <PreferencesUsagePanel onOpenBilling={() => {}} onAddCredits={() => {}} />
  );
}

/**
 * The panel with the compact credits row beneath it, composed the way
 * `PreferencesMenuContent` composes them: `showsMenuCredits` decides whether
 * the row belongs on screen, and `displayedCreditsUsd` decides what it names,
 * so the story exercises both real rules. The seeded balance is already in the
 * two-decimal shape the menu formats it to.
 */
function PanelWithCredits() {
  const obscureCredits = useObscureCredits();
  const usage = usePreferencesUsage();
  const {
    enabled: showBillingRows,
    balance,
    availableUsageBalance,
  } = useBillingBalanceStatus();
  const showCredits = showsMenuCredits(obscureCredits, usage);

  return (
    <>
      <PreferencesUsagePanel onOpenBilling={() => {}} onAddCredits={() => {}} />
      {showBillingRows && balance !== null && showCredits ? (
        <div className="my-2">
          <CreditsCard
            balance={displayedCreditsUsd(
              obscureCredits,
              balance,
              availableUsageBalance,
            )}
            onAddCredits={() => {}}
          />
        </div>
      ) : null}
    </>
  );
}

/**
 * Seeds the flag, the three gate stores, and the four billing reads, then
 * hands every one of them back on unmount so a story cannot leak its billing
 * state into the next one. Written in an effect rather than during render
 * because the stores are subscribed by the tree being rendered.
 */
function SeededPanel({
  args,
  children,
}: {
  args: UsagePanelStoryArgs;
  children: ReactNode;
}) {
  const { plan, spentUsd, balanceUsd, totalUsageUsd, availableUsageUsd } = args;
  const free = plan === "free";
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
      }),
  );

  useLayoutEffect(() => {
    const previousAuth = useAuthStore.getState().platformSession;
    const previousLifecycle =
      useAssistantLifecycleStore.getState().assistantState;
    const previousOrgId =
      useOrganizationStore.getState().persistedOrganizationId;

    useAuthStore.setState({ platformSession: "present" });
    useAssistantLifecycleStore.setState({
      assistantState: { kind: "active", isLocal: false, health: "healthy" },
    });
    // The org-header gate reports "resolving", never "ready", while a platform
    // session exists with no organization id to scope requests to.
    useOrganizationStore.setState({ persistedOrganizationId: "org_storybook" });
    useClientFeatureFlagStore.getState().setFlag(OBSCURE_CREDITS, true);

    client.setQueryData(
      organizationsBillingSubscriptionRetrieveOptions().queryKey,
      free ? FREE_SUBSCRIPTION : SUBSCRIPTION,
    );
    client.setQueryData(
      organizationsBillingPlansRetrieveOptions().queryKey,
      PLANS,
    );
    client.setQueryData(
      organizationsBillingUsageTotalsRetrieveOptions({ query: usageWindow() })
        .queryKey,
      { total_usd: spentUsd, event_count: 12 },
    );
    // Only the fields `useBillingBalanceStatus` reads; the untyped key lets
    // the fixture stay the size of what the hook actually consults.
    client.setQueryData(organizationsBillingSummaryRetrieveQueryKey(), {
      effective_balance: balanceUsd,
      low_balance_warning: false,
      daily_limit_reached: false,
      daily_limit_snoozed: false,
      daily_credit_limit_usd: null,
      daily_spend_usd: "0.00",
      total_usage_balance: totalUsageUsd,
      available_usage_balance: availableUsageUsd,
    });

    return () => {
      useAuthStore.setState({ platformSession: previousAuth });
      useAssistantLifecycleStore.setState({
        assistantState: previousLifecycle,
      });
      useOrganizationStore.setState({ persistedOrganizationId: previousOrgId });
      useClientFeatureFlagStore.getState().clearOverride(OBSCURE_CREDITS);
    };
  }, [availableUsageUsd, balanceUsd, client, free, spentUsd, totalUsageUsd]);

  return (
    <QueryClientProvider client={client}>
      {/* The menu is a `w-64` popover with `p-4`; the panel fills its width. */}
      <div className="w-64 rounded-lg bg-[var(--surface-lift)] p-4 shadow-[var(--shadow-popover)]">
        {children}
      </div>
    </QueryClientProvider>
  );
}

const meta: Meta<UsagePanelStoryArgs> = {
  title: "Chat/PreferencesUsagePanel",
  // Opted out of the global `autodocs` tag. The panel resolves itself from
  // module-singleton Zustand stores, so N variants cannot co-exist: the docs
  // page mounts every story at once and whichever effect ran last decides the
  // flag and the gate for all of them. Isolating the seed per instance is not
  // possible while the source of truth is a module singleton, so the variants
  // are canvas-only, where exactly one is mounted at a time.
  tags: ["!autodocs"],
  parameters: { layout: "centered" },
  argTypes: {
    plan: { control: "inline-radio", options: ["pro", "free"] },
    spentUsd: { control: "text" },
    balanceUsd: { control: "text" },
    totalUsageUsd: { control: "text" },
    availableUsageUsd: { control: "text" },
  },
  args: {
    plan: "pro",
    spentUsd: "17",
    balanceUsd: "18.00",
    totalUsageUsd: "5.00",
    availableUsageUsd: "1.60",
  },
  render: (args) => (
    <SeededPanel args={args}>
      <PanelOnly />
    </SeededPanel>
  ),
};

export default meta;
type Story = StoryObj<UsagePanelStoryArgs>;

/** $17 of Mighty's $25 bundle, with credits still in the wallet behind it. */
export const MidCycle: Story = {
  name: "Mid cycle, 68% used",
};

/**
 * The bundle spent with credits still in the wallet behind it. The bar and the
 * percentage read negative the moment the allowance runs out, and no strip
 * appears: the next turn still has something to draw on.
 */
export const FullBar: Story = {
  name: "Full bar, credits remaining",
  args: { spentUsd: "25", balanceUsd: "18.00" },
};

/**
 * The bundle spent and the wallet empty. The same negative reading, now with
 * the add-credits strip dropped in below the bar, which is the only state that
 * grows the menu.
 */
export const Exhausted: Story = {
  name: "Exhausted, 100% used",
  args: { spentUsd: "25", balanceUsd: "0.00" },
};

/**
 * The same spent bundle as `FullBar`, now with the menu around it: the wallet
 * still holds credits, so `showsMenuCredits` brings the compact credits row
 * back below the bar. The red bar and "100% used" say the included allowance
 * is gone, and the row says what the next turn draws on instead.
 */
export const FullWithCredits: Story = {
  name: "Full bar with the credits row",
  args: { spentUsd: "25", balanceUsd: "18.00" },
  render: (args) => (
    <SeededPanel args={args}>
      <PanelWithCredits />
    </SeededPanel>
  ),
};

/**
 * A free plan, which has no cycle and no included bundle: $3.40 of the $5.00
 * grant used, read straight off the billing summary. Nothing resets, so the
 * line under the bar is gone. A further grant would grow the denominator and
 * drop the bar back.
 */
export const FreePlan: Story = {
  name: "Free plan, usage grant",
  args: {
    plan: "free",
    balanceUsd: "1.60",
    totalUsageUsd: "5.00",
    availableUsageUsd: "1.60",
  },
};

/** The same free plan with its grant and its wallet both spent to nothing. */
export const FreePlanExhausted: Story = {
  name: "Free plan, wallet empty",
  args: {
    plan: "free",
    balanceUsd: "0.00",
    totalUsageUsd: "5.00",
    availableUsageUsd: "0.00",
  },
};
