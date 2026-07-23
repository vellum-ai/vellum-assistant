
import { BillingErrorBanner } from "@/domains/chat/components/billing-error-banner";

interface CreditsExhaustedBannerProps {
  onUpgrade: () => void;
}

export function CreditsExhaustedBanner({
  onUpgrade,
}: CreditsExhaustedBannerProps) {
  return (
    <BillingErrorBanner
      ariaLabel="Your credit balance has run out. Upgrade to a Pro plan."
      icon={<span style={{ fontSize: "1.25rem" }}>💰</span>}
      title="Your credit balance has run out"
      subtitle="Upgrade to a Pro plan to get monthly credits."
      ctaLabel="Upgrade"
      onAction={onUpgrade}
    />
  );
}
