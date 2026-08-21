import { KeyRound } from "lucide-react";

import { BillingErrorBanner } from "@/domains/chat/components/billing-error-banner";
import { useTranslation } from "@/i18n";

interface ProviderBillingBannerProps {
  onOpenSettings: () => void;
}

export function ProviderBillingBanner({
  onOpenSettings,
}: ProviderBillingBannerProps) {
  const { t } = useTranslation("chat");
  return (
    <BillingErrorBanner
      ariaLabel={t("providerBillingBanner.title")}
      icon={
        <KeyRound
          className="size-5"
          style={{ color: "var(--content-tertiary)" }}
        />
      }
      title={t("providerBillingBanner.title")}
      subtitle={t("providerBillingBanner.body")}
      action={{ label: "Open Settings", onClick: onOpenSettings }}
    />
  );
}
