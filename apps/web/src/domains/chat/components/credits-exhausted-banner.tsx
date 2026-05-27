
import { BillingErrorBanner } from "@/domains/chat/components/billing-error-banner";

interface CreditsExhaustedBannerProps {
  onAddFunds: () => void;
}

export function CreditsExhaustedBanner({
  onAddFunds,
}: CreditsExhaustedBannerProps) {
  return (
    <BillingErrorBanner
      ariaLabel="Your credit balance has run out"
      icon={<span style={{ fontSize: "1.25rem" }}>💰</span>}
      title="Your credit balance has run out"
      subtitle="Purchase additional credits to pick up where you left off."
      ctaLabel="Add Funds"
      onAction={onAddFunds}
    />
  );
}
