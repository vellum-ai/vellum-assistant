/**
 * The preferences menu's usage reading while `obscure-credits` is on.
 *
 * Unlike the billing tile's `UsageBalancePanel`, this one composes itself: the
 * subscription arrives through TanStack Query, the wallet status and the
 * usage-grant figures arrive through `useBillingBalanceStatus`, and the flag
 * arrives through the client feature-flag store. Every one of those is seeded
 * here through its real read seam, so what renders is the production path
 * rather than a lookalike.
 *
 * Two things make the seeding work. TanStack Query serves cached data even
 * while a query's `enabled` is false, so priming the cache is enough for both
 * billing reads. And `useBillingBalanceStatus` refuses to look at the summary
 * until the platform gate, the assistant lifecycle, and the org store all say
 * the org has managed billing, so those three stores are seeded too.
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
  organizationsBillingSubscriptionRetrieveOptions,
  organizationsBillingSummaryRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";
import type { SubscriptionResponse } from "@/generated/api/types.gen";
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

/** A Pro sub cleanly pinned to Mighty, whose grants renew on the cycle end. */
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

/** A free (base) sub: no package and no billing cycle. */
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

interface UsagePanelStoryArgs {
  /** Which plan the seeded sub is on. Both read the same usage-grant figures. */
  plan: "pro" | "free";
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
 * Seeds the flag, the three gate stores, and the two billing reads, then
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
  const { plan, balanceUsd, totalUsageUsd, availableUsageUsd } = args;
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
  }, [availableUsageUsd, balanceUsd, client, free, totalUsageUsd]);

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
    balanceUsd: { control: "text" },
    totalUsageUsd: { control: "text" },
    availableUsageUsd: { control: "text" },
  },
  args: {
    plan: "pro",
    balanceUsd: "18.00",
    totalUsageUsd: "25.00",
    availableUsageUsd: "8.00",
  },
  render: (args) => (
    <SeededPanel args={args}>
      <PanelOnly />
    </SeededPanel>
  ),
};

export default meta;
type Story = StoryObj<UsagePanelStoryArgs>;

/** $17 of the $25 granted this cycle, with credits still in the wallet. */
export const MidCycle: Story = {
  name: "Mid cycle, 68% used",
};

/**
 * The grants used up with credits still in the wallet behind them. The
 * percentage keeps its neutral color while the amber extra-credits line takes
 * the bar's place, and no strip appears: the next turn still has something to
 * draw on.
 */
export const SpentBundle: Story = {
  name: "Spent bundle, extra credits",
  args: { availableUsageUsd: "0.00", balanceUsd: "18.00" },
};

/**
 * The grants used up and the wallet empty. The same negative reading, now with
 * the add-credits strip dropped in below the bar, which is the only state that
 * grows the menu.
 */
export const Exhausted: Story = {
  name: "Exhausted, 100% used",
  args: { availableUsageUsd: "0.00", balanceUsd: "0.00" },
};

/**
 * A Pro sub whose grants have all expired or been used to nothing, so the
 * summary reports a zero total. The bar reads fully spent:
 * the plan has nothing left to give, and whatever the org still holds lives
 * in the wallet.
 */
export const NoLiveGrants: Story = {
  name: "No live grants, fully spent",
  args: {
    totalUsageUsd: "0.00",
    availableUsageUsd: "0.00",
    balanceUsd: "18.00",
  },
};

/**
 * The same spent grants as `SpentBundle`, now with the menu's composition
 * around it: the panel's amber line already names what the next turn draws
 * on, so `showsMenuCredits` keeps the compact credits row off screen. The
 * row only appears when there is no usage reading for the flag to hide the
 * dollar balance behind.
 */
export const SpentWithoutCreditsRow: Story = {
  name: "Spent bundle, no credits row",
  args: { availableUsageUsd: "0.00", balanceUsd: "18.00" },
  render: (args) => (
    <SeededPanel args={args}>
      <PanelWithCredits />
    </SeededPanel>
  ),
};

/**
 * A free plan, which has no cycle its grants renew on: $3.40 of the $5.00
 * grant used, read straight off the billing summary. A further grant would
 * grow the denominator and drop the bar back.
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
