/**
 * Every billing wall that appears in chat renders through one primitive,
 * {@link BillingErrorBanner}. This file catalogs both layers:
 *
 *   1. the primitive's own variant matrix (icon / action / dismiss / detached),
 *   2. the three composer walls built on it, each with its production copy and
 *      CTA.
 *
 * Which of the composer banners is shown is decided by the pure resolver
 * `resolveComposerBillingBanner` (`utils/error-classification.ts`), whose
 * precedence is strict. Error-driven decisions come first: daily_limit >
 * provider_billing > managed_credits (which renders nothing here, since the
 * transcript's credit wall owns it). With no error decision the billing
 * summary's `daily_limit_reached` raises `DailyLimitBanner` proactively, and
 * low_balance is the last fallback. The credit wall itself lives in its own
 * story file, since its CTA is the one that forks between Add credits and
 * View plans.
 *
 * Android consumption-only suppression applies to **purchase** surfaces only.
 * Among these three that is just `LowBalanceBanner`; `DailyLimitBanner` (a
 * settings deep-link) and `ProviderBillingBanner` (the user's own provider is
 * out of funds, so there is nothing for Vellum to sell) keep their copy and CTA
 * on every platform.
 */
import { useLayoutEffect, useState, type ReactNode } from "react";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { CalendarClock } from "lucide-react";

import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import { BillingErrorBanner } from "@/domains/chat/components/billing-error-banner";
import { DailyLimitBanner } from "@/domains/chat/components/daily-limit-banner";
import { LowBalanceBanner } from "@/domains/chat/components/low-balance-banner";
import { ProviderBillingBanner } from "@/domains/chat/components/provider-billing-banner";
import {
  organizationsBillingAutoTopUpRetrieveQueryKey,
  organizationsBillingSummaryRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";
import { useAuthStore } from "@/stores/auth-store";
import { useOrganizationStore } from "@/stores/organization-store";

/**
 * `DailyLimitBanner` reads the billing summary (for the limit and today's
 * spend shown in its confirm step) and the auto-top-up config (for the
 * card-will-be-charged warning). Seed both so the story renders the real
 * component with real state rather than a hand-built lookalike.
 */
function BillingQueryFixture({
  children,
  autoTopUpEnabled = false,
}: {
  children: ReactNode;
  autoTopUpEnabled?: boolean;
}) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
      }),
  );

  // `useBillingBalanceStatus` refuses to read the summary unless the org is
  // resolved and the active assistant is platform hosted, so seeding the cache
  // alone leaves the hook inert and the confirm copy drops its amounts. Seed
  // the same read seams a real client sets, and hand them back on unmount so a
  // story cannot leak billing state into the next one.
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
    // The org-header gate reports "resolving" — never "ready" — while a
    // platform session exists with no organization id to scope requests to.
    useOrganizationStore.setState({
      persistedOrganizationId: "org_storybook",
    });

    client.setQueryData(organizationsBillingSummaryRetrieveQueryKey(), {
      daily_credit_limit_usd: "25.00",
      daily_spend_usd: "25.13",
      daily_limit_reached: true,
      daily_limit_snoozed: false,
      effective_balance: "20.00",
      low_balance_warning: false,
    });
    client.setQueryData(organizationsBillingAutoTopUpRetrieveQueryKey(), {
      enabled: autoTopUpEnabled,
    });

    return () => {
      useAuthStore.setState({ platformSession: previousAuth });
      useAssistantLifecycleStore.setState({
        assistantState: previousLifecycle,
      });
      useOrganizationStore.setState({
        persistedOrganizationId: previousOrgId,
      });
    };
  }, [autoTopUpEnabled, client]);

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const meta: Meta<typeof BillingErrorBanner> = {
  title: "Upsell Walls/Composer Banners",
  component: BillingErrorBanner,
  parameters: { layout: "padded" },
  args: {
    ariaLabel: "Billing notice",
    title: "Your credits are running low",
    subtitle: "Add credits to avoid an interruption.",
    action: { label: "Add credits", onClick: () => {} },
    detached: false,
  },
  decorators: [
    (Story) => (
      // The banner sizes itself against the composer, which is width-capped.
      <div className="mx-auto w-full max-w-[720px]">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof BillingErrorBanner>;

/**
 * Flush-mounted above the composer: square bottom corners so it reads as one
 * surface with the input below it.
 */
export const Attached: Story = {};

/**
 * `detached`: a standalone rounded card, inset 24px. Used by the credit wall,
 * which renders inside the transcript rather than above the composer.
 */
export const Detached: Story = {
  args: { detached: true },
};

/** With a dismiss X after the CTA. The low-balance wall is dismissible. */
export const WithDismiss: Story = {
  args: { onDismiss: () => {} },
};

/** No CTA and no dismiss collapses the whole right-hand column. */
export const NoActionNoDismiss: Story = {
  name: "No CTA and no dismiss",
  args: { action: undefined, onDismiss: undefined },
};

/** An icon slot sits before the copy; the daily-limit wall uses one. */
export const WithIcon: Story = {
  args: {
    icon: (
      <CalendarClock
        className="size-5"
        style={{ color: "var(--content-tertiary)" }}
      />
    ),
  },
};

/**
 * **Daily credit limit reached.** A self-imposed spend cap, not a plan wall,
 * so the filled CTA deep-links into billing settings rather than upselling.
 *
 * "Skip for today" is deliberately the lighter button: it suspends the
 * guardrail the user set on purpose, so it should not be the easiest click on
 * screen. It opens a confirm rather than acting immediately, and that confirm
 * carries the full explanation, what stops applying and when it returns, so
 * the banner itself stays two short buttons.
 */
export const RealDailyLimitBanner: Story = {
  name: "Real · Daily limit → Skip / Settings",
  render: () => (
    <BillingQueryFixture>
      <DailyLimitBanner onAdjustLimit={() => {}} />
    </BillingQueryFixture>
  ),
};

/**
 * Same banner for an org with automatic top-ups on. Skipping does not pause
 * top-ups, so the confirm gains a line naming that consequence: a skipped day
 * is genuinely uncapped, and the card can be charged again.
 */
export const RealDailyLimitBannerWithAutoTopUp: Story = {
  name: "Real · Daily limit → Skip (auto top-up on)",
  render: () => (
    <BillingQueryFixture autoTopUpEnabled>
      <DailyLimitBanner onAdjustLimit={() => {}} />
    </BillingQueryFixture>
  ),
};

/**
 * **Bring-your-own-key billing.** The user's own provider is out of funds, so
 * there is nothing for Vellum to sell. The CTA opens AI settings.
 */
export const RealProviderBillingBanner: Story = {
  name: "Real · Provider billing → Open Settings",
  render: () => <ProviderBillingBanner onOpenSettings={() => {}} />,
};

/**
 * **Low balance.** The proactive warn-band wall: still usable, so it is
 * dismissible, and its CTA opens the Add Credits modal rather than the plans
 * takeover.
 */
export const RealLowBalanceBanner: Story = {
  name: "Real · Low balance → Add credits",
  render: () => <LowBalanceBanner />,
};

/**
 * The three composer walls together, in resolver precedence order. Only one is
 * ever mounted at a time in the app; they are stacked here to compare their
 * CTAs.
 */
export const AllComposerWalls: Story = {
  name: "All composer walls",
  parameters: { controls: { disable: true } },
  render: () => (
    <div className="flex flex-col gap-4">
      <BillingQueryFixture>
        <DailyLimitBanner onAdjustLimit={() => {}} />
      </BillingQueryFixture>
      <ProviderBillingBanner onOpenSettings={() => {}} />
      <LowBalanceBanner />
    </div>
  ),
};
