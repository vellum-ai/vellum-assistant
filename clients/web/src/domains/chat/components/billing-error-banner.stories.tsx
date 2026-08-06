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
import type { Meta, StoryObj } from "@storybook/react-vite";
import { CalendarClock } from "lucide-react";

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
 * No CTA and no dismiss collapses the whole right-hand column. The credit wall
 * on native Android is the surface that reaches this shape (see
 * `Upsell Walls/Credit Wall`); it renders `detached` on top of it.
 */
export const NoActionNoDismiss: Story = {
  name: "No CTA and no dismiss",
  args: { action: undefined, onDismiss: undefined },
};

/**
 * The low-balance wall on native Android: the purchase CTA is suppressed and
 * the subtitle points at the website, but the dismiss stays, because
 * `LowBalanceBanner` passes `onDismiss` unconditionally. The other two composer
 * walls are not purchase surfaces and are unaffected on Android.
 */
export const AndroidLowBalance: Story = {
  name: "Low balance on native Android",
  args: {
    ariaLabel: `Your credits are running low. ${ANDROID_BILLING_MESSAGE}`,
    action: undefined,
    onDismiss: () => {},
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
      <DailyLimitBanner onAdjustLimit={() => {}} />
      <ProviderBillingBanner onOpenSettings={() => {}} />
      <LowBalanceBanner />
    </div>
  ),
};
