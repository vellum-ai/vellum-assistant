import { Skeleton } from "@vellumai/design-library/components/skeleton";
import { StatSquare } from "@vellumai/design-library/components/stat-square";

export interface BillingPanelBalanceSkeletonProps {
  /**
   * Announces the wait. `BillingPanel` passes it while its summary is pending;
   * the billing tab's skeleton stack leaves it off and announces the whole
   * stack once instead of once per card.
   */
  label?: string;
}

/**
 * Stand-in for the Credits balance tile, shaped like the `StatSquare` that
 * replaces it so the panel holds its height across the swap.
 */
export function BillingPanelBalanceSkeleton({
  label,
}: BillingPanelBalanceSkeletonProps) {
  return (
    <div
      role={label == null ? undefined : "status"}
      aria-label={label}
      className="mt-4"
      data-testid="billing-panel-balance-skeleton"
    >
      <StatSquare
        icon={<Skeleton as="span" aria-hidden className="h-4 w-4 rounded-sm" />}
        value={
          <Skeleton
            as="span"
            aria-hidden
            className="block h-5 w-28 rounded-md"
          />
        }
        label={
          <Skeleton
            as="span"
            aria-hidden
            className="block h-4 w-24 rounded-md"
          />
        }
      />
    </div>
  );
}
