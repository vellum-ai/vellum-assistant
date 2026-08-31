import { Card } from "@vellumai/design-library/components/card";
import { Skeleton } from "@vellumai/design-library/components/skeleton";
import { StatSquare } from "@vellumai/design-library/components/stat-square";

import { BillingSectionHeader } from "@/domains/settings/components/billing-section-header";
import { SkeletonLines } from "@/domains/settings/components/skeleton-lines";
import { useTranslation } from "@/i18n";

export interface BillingPanelSkeletonProps {
  /**
   * Announces the wait. `BillingPanel` passes it whenever it loads on its own;
   * the billing tab's skeleton stack leaves it off and announces the whole
   * stack once instead of once per card.
   */
  label?: string;
}

/**
 * Stand-in for `BillingPanel` as it first mounts: the header the real panel
 * renders from the first paint, the balance tile, and the three nested row
 * groups (auto-reload, daily limit, low-balance toggle) behind the dividers
 * the panel lays them out with.
 */
export function BillingPanelSkeleton({ label }: BillingPanelSkeletonProps) {
  const { t } = useTranslation("settings");
  return (
    <Card padding="md" data-testid="billing-panel-skeleton">
      <BillingSectionHeader
        title={t("billingPanel.title")}
        subtitle={t("billingPanel.subtitle")}
        actions={
          <>
            <Skeleton aria-hidden className="h-8 w-36 rounded-md" />
            <Skeleton aria-hidden className="h-8 w-28 rounded-md" />
          </>
        }
      />
      <div
        role={label == null ? undefined : "status"}
        aria-label={label}
        data-testid="billing-panel-skeleton-body"
      >
        <div className="mt-4">
          <StatSquare
            icon={<Skeleton aria-hidden className="h-4 w-4 rounded-sm" />}
            value={<Skeleton aria-hidden className="h-5 w-28 rounded-md" />}
            label={<Skeleton aria-hidden className="h-4 w-24 rounded-md" />}
          />
        </div>
        <SkeletonLines lines={2} lineClassName="h-6" className="mt-6" />
        <div className="mt-6 border-t border-[var(--border-subtle)] pt-6">
          <SkeletonLines lines={2} lineClassName="h-6" />
        </div>
        <div className="mt-6 border-t border-[var(--border-subtle)] pt-6">
          <SkeletonLines lines={1} lineClassName="h-6" />
        </div>
      </div>
    </Card>
  );
}
