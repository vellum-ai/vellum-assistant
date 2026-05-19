
import { BillingErrorBanner } from "@/domains/chat/components/billing-error-banner.js";

interface CreditsExhaustedBannerProps {
  onAddFunds: () => void;
}

export function CreditsExhaustedBanner({
  onAddFunds,
}: CreditsExhaustedBannerProps) {
  return (
    <BillingErrorBanner
      ariaLabel="Your balance has run out"
      icon={<span style={{ fontSize: "1.25rem" }}>💰</span>}
      title="Your balance has run out"
      subtitle="Add funds to pick up where you left off."
      ctaLabel="Add Funds"
      onAction={onAddFunds}
    />
  );
}
