import { BillingErrorBanner } from "@/domains/chat/components/billing-error-banner";
import type { ChatBillingBannerDecision } from "@/domains/chat/utils/error-classification";
import { useLowBalanceBannerStore } from "@/stores/low-balance-banner-store";

/**
 * Whether the proactive low-balance banner may render: only when no
 * error-driven billing banner is active (those always take precedence), the
 * server reports `low_balance_warning`, and the user has not dismissed the
 * banner this session. The exhausted-credits surfaces never overlap with this
 * one: the server keeps `low_balance_warning` false while the balance is
 * exhausted, and it is false for auto-top-up orgs and whenever the billing
 * query is gated off.
 */
export function shouldShowLowBalanceBanner(args: {
  billingBannerDecision: ChatBillingBannerDecision | null;
  isLowBalance: boolean;
  dismissed: boolean;
}): boolean {
  return (
    args.billingBannerDecision === null && args.isLowBalance && !args.dismissed
  );
}

interface LowBalanceBannerProps {
  onAddCredits: () => void;
}

/**
 * Proactive composer-flush banner shown while the org's credit balance sits in
 * the server-computed warn band. Copy is deliberately phrased around the flag
 * rather than the numbers: `low_balance_warning` compares the raw balance
 * while display fields are rounded, so near band edges the displayed balance
 * can equal or exceed the displayed threshold while the flag is true.
 */
export function LowBalanceBanner({ onAddCredits }: LowBalanceBannerProps) {
  const dismiss = useLowBalanceBannerStore.use.dismiss();
  return (
    <BillingErrorBanner
      ariaLabel="Your credits are running low. Add credits to avoid an interruption."
      title="Your credits are running low"
      subtitle="Add credits to avoid an interruption."
      ctaLabel="Add credits"
      onAction={onAddCredits}
      onDismiss={dismiss}
    />
  );
}
