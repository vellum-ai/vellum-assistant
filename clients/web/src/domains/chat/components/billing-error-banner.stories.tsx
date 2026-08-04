/**
 * Every billing wall that appears in chat renders through one primitive,
 * {@link BillingErrorBanner}. This file catalogs both layers:
 *
 *   1. the primitive's own variant matrix (icon / action / dismiss / detached),
 *   2. the four real walls built on it, each with its production copy and CTA.
 *
 * Which of the composer banners is shown is decided by the pure resolver
 * `resolveComposerBillingBanner` (`utils/error-classification.ts:111`), whose
 * precedence is strict: daily_limit > provider_billing > managed_credits
 * (which renders nothing here, since the transcript's credit wall owns it) >
 * low_balance. The credit wall itself lives in its own story file, since its
 * CTA is the one that forks between Add credits and View plans.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import { CalendarClock, KeyRound } from "lucide-react";

import { BillingErrorBanner } from "@/domains/chat/components/billing-error-banner";
import { DailyLimitBanner } from "@/domains/chat/components/daily-limit-banner";
import { LowBalanceBanner } from "@/domains/chat/components/low-balance-banner";
import { ProviderBillingBanner } from "@/domains/chat/components/provider-billing-banner";
import { ANDROID_BILLING_MESSAGE } from "@/lib/billing/android-consumption-only";

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

/**
 * No CTA and no dismiss collapses the whole right-hand column. This is what
 * every purchase wall degrades to on native Android, which is
 * consumption-only.
 */
export const NoActionNoDismiss: Story = {
  name: "No CTA (native Android)",
  args: {
    action: undefined,
    onDismiss: undefined,
    subtitle: ANDROID_BILLING_MESSAGE,
  },
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
 * so the CTA deep-links into billing settings rather than upselling.
 */
export const RealDailyLimitBanner: Story = {
  name: "Real · Daily limit → Adjust Limit",
  render: () => <DailyLimitBanner onAdjustLimit={() => {}} />,
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

/** The three composer walls together, in resolver precedence order. */
export const AllComposerWalls: Story = {
  name: "All composer walls",
  parameters: { controls: { disable: true } },
  render: () => (
    <div className="flex flex-col gap-4">
      <DailyLimitBanner onAdjustLimit={() => {}} />
      <ProviderBillingBanner onOpenSettings={() => {}} />
      <LowBalanceBanner />
      <BillingErrorBanner
        ariaLabel="Your API key needs credits"
        icon={
          <KeyRound
            className="size-5"
            style={{ color: "var(--content-tertiary)" }}
          />
        }
        title="Your API key needs credits"
        subtitle={ANDROID_BILLING_MESSAGE}
      />
    </div>
  ),
};
