
import { BillingErrorBanner } from "@/domains/chat/components/billing-error-banner";

interface CreditsExhaustedBannerProps {
  onUpgrade: () => void;
}

export function CreditsExhaustedBanner({
  onUpgrade,
}: CreditsExhaustedBannerProps) {
  return (
    <BillingErrorBanner
      ariaLabel="Your credit balance has run out. Upgrade your plan for more credits."
      icon={<span style={{ fontSize: "1.25rem" }}>💰</span>}
      title="Your credit balance has run out"
      subtitle="Upgrade your plan for more credits every month."
      ctaLabel="Upgrade"
      onAction={onUpgrade}
    />
  );
}
