import { Card } from "@vellumai/design-library/components/card";
import { Skeleton } from "@vellumai/design-library/components/skeleton";

import { BillingSectionHeader } from "@/domains/settings/components/billing-section-header";

export interface InvoicesTableSkeletonProps {
  /**
   * Announces the wait. The billing tab's skeleton stack leaves it off and
   * announces the whole stack once instead of once per card.
   */
  label?: string;
}

/**
 * Stand-in for `InvoicesTable` as it first mounts: collapsed, so the card is
 * the section header and its toggle alone. Built on the real header so the
 * placeholder inherits its stacking below `sm`, and sized to the toggle
 * button rather than to the table, which exists only once expanded.
 */
export function InvoicesTableSkeleton({ label }: InvoicesTableSkeletonProps) {
  return (
    <Card padding="md" data-testid="invoices-table-skeleton">
      <div role={label == null ? undefined : "status"} aria-label={label}>
        <BillingSectionHeader
          title={
            <Skeleton
              as="span"
              aria-hidden
              className="block h-5 w-28 rounded-md"
            />
          }
          actions={
            <Skeleton
              aria-hidden
              className="h-8 w-36 rounded-md"
              data-testid="invoices-toggle-skeleton"
            />
          }
        />
      </div>
    </Card>
  );
}
