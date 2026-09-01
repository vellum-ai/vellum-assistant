import { Card } from "@vellumai/design-library/components/card";
import { Skeleton } from "@vellumai/design-library/components/skeleton";

import { BillingPanelBalanceSkeleton } from "@/domains/settings/components/billing-panel-balance-skeleton";
import { BillingPanelHeader } from "@/domains/settings/components/billing-panel-header";
import { BillingPanelRowGroup } from "@/domains/settings/components/billing-panel-row-group";
import { SkeletonLines } from "@/domains/settings/components/skeleton-lines";

/**
 * Stand-in for `BillingPanel` in the billing tab's skeleton stack, which is
 * the only place the whole card is stood in for: the panel itself keeps its
 * chrome mounted and swaps only its balance body. The stack announces the wait
 * once for every card in it, so nothing here is labeled.
 */
export function BillingPanelSkeleton() {
  return (
    <Card padding="md" data-testid="billing-panel-skeleton">
      <BillingPanelHeader
        actions={
          <>
            <Skeleton aria-hidden className="h-8 w-36 rounded-md" />
            <Skeleton aria-hidden className="h-8 w-28 rounded-md" />
          </>
        }
      />
      <BillingPanelBalanceSkeleton />
      <SkeletonLines lines={2} lineClassName="h-6" className="mt-6" />
      <BillingPanelRowGroup>
        <SkeletonLines lines={2} lineClassName="h-6" />
      </BillingPanelRowGroup>
      <BillingPanelRowGroup>
        <SkeletonLines lines={1} lineClassName="h-6" />
      </BillingPanelRowGroup>
    </Card>
  );
}
