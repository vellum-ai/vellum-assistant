import type { ReactNode } from "react";

import { BillingSectionHeader } from "@/domains/settings/components/billing-section-header";
import { useTranslation } from "@/i18n";

export interface BillingPanelHeaderProps {
  /** The resolved panel passes its buttons; the skeleton passes placeholders. */
  actions: ReactNode;
}

/**
 * The Credits section's title and subtitle, shared by `BillingPanel` and its
 * skeleton so the header reads the same from the first paint.
 */
export function BillingPanelHeader({ actions }: BillingPanelHeaderProps) {
  const { t } = useTranslation("settings");
  return (
    <BillingSectionHeader
      title={t("billingPanel.title")}
      subtitle={t("billingPanel.subtitle")}
      actions={actions}
    />
  );
}
