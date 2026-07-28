
import { CalendarClock } from "lucide-react";

import { BillingErrorBanner } from "@/domains/chat/components/billing-error-banner";

interface DailyLimitBannerProps {
  onAdjustLimit: () => void;
}

export function DailyLimitBanner({ onAdjustLimit }: DailyLimitBannerProps) {
  return (
    <BillingErrorBanner
      ariaLabel="Daily credit limit reached"
      icon={
        <CalendarClock
          className="size-5"
          style={{ color: "var(--content-tertiary)" }}
        />
      }
      title="Daily credit limit reached"
      subtitle="This limit applies to Vellum credit spend and resets at midnight UTC."
      ctaLabel="Adjust Limit"
      onAction={onAdjustLimit}
    />
  );
}
