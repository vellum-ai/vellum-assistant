
import { BillingErrorBanner } from "@/domains/chat/components/billing-error-banner";
import type { CreditPaywallCtaMode } from "@/domains/chat/utils/credit-paywall-cta";

interface CreditsExhaustedBannerProps {
  mode: CreditPaywallCtaMode;
  onAddCredits: () => void;
  onUpgrade: () => void;
  detached?: boolean;
}

export function CreditsExhaustedBanner({
  mode,
  onAddCredits,
  onUpgrade,
  detached,
}: CreditsExhaustedBannerProps) {
  const isUpgrade = mode === "upgrade";
  return (
    <BillingErrorBanner
      ariaLabel={
        isUpgrade
          ? "Your balance has run out. Upgrade to a higher plan to continue."
          : "Your balance has run out. Add credits to continue."
      }
      title="💰  Your balance has run out"
      subtitle={
        isUpgrade
          ? "Upgrade to a higher plan to continue."
          : "Add credits to continue."
      }
      ctaLabel={isUpgrade ? "Upgrade" : "Add Credits"}
      onAction={isUpgrade ? onUpgrade : onAddCredits}
      detached={detached}
    />
  );
}
