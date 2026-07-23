
import { BillingErrorBanner } from "@/domains/chat/components/billing-error-banner";

interface CreditsExhaustedBannerProps {
  onAddCredits: () => void;
  onUpgrade: () => void;
}

export function CreditsExhaustedBanner({
  onAddCredits,
  onUpgrade,
}: CreditsExhaustedBannerProps) {
  return (
    <BillingErrorBanner
      ariaLabel="Your balance has run out. Upgrade to a higher plan or add credits to continue."
      title="💰  Your balance has run out"
      subtitle="Upgrade to a higher plan or add credits to continue."
      secondaryCtaLabel="Add Credits"
      onSecondaryAction={onAddCredits}
      ctaLabel="Upgrade"
      onAction={onUpgrade}
    />
  );
}
