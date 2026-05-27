
import { KeyRound } from "lucide-react";

import { BillingErrorBanner } from "@/domains/chat/components/billing-error-banner";

interface ProviderBillingBannerProps {
  onOpenSettings: () => void;
}

export function ProviderBillingBanner({
  onOpenSettings,
}: ProviderBillingBannerProps) {
  return (
    <BillingErrorBanner
      ariaLabel="Your API key needs credits"
      icon={
        <KeyRound
          className="size-5"
          style={{ color: "var(--content-tertiary)" }}
        />
      }
      title="Your API key needs credits"
      subtitle="Add funds with your provider or lower the model token limit."
      ctaLabel="Open Settings"
      onAction={onOpenSettings}
    />
  );
}
