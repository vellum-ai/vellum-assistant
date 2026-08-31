import { Card } from "@vellumai/design-library/components/card";
import { Skeleton } from "@vellumai/design-library/components/skeleton";

import { PlanHeading } from "@/domains/settings/components/plan-heading";

export interface PlanCardSkeletonProps {
  /**
   * Announces the wait. `PlanCard` passes it whenever it loads on its own;
   * the billing tab's skeleton stack leaves it off and announces the whole
   * stack once instead of once per card.
   */
  label?: string;
}

/**
 * Stand-in for the resolved card: a plan-name row, the renewal line, the usage
 * bar and the two plan tiles, so the card holds its height while the
 * subscription and plan catalog land.
 */
export function PlanCardSkeleton({ label }: PlanCardSkeletonProps) {
  return (
    <Card padding="md" data-testid="plan-card-skeleton">
      <PlanHeading />
      <div
        role={label == null ? undefined : "status"}
        aria-label={label}
        className="mt-4 flex flex-col gap-4"
      >
        <div className="flex flex-col gap-2">
          <Skeleton aria-hidden className="h-6 w-40 rounded-md" />
          <Skeleton aria-hidden className="h-4 w-56 rounded-md" />
        </div>
        <Skeleton aria-hidden className="h-3 w-full rounded-full" />
        {/* Same container as the resolved tile row, so the placeholders stack
            below `lg` exactly as the tiles do. The height is a real tile's:
            tag, avatar row, three spec chips and a footer row. */}
        <div className="flex flex-col gap-4 lg:flex-row lg:items-stretch">
          <Skeleton aria-hidden className="h-84 rounded-xl lg:flex-1" />
          <Skeleton aria-hidden className="h-84 rounded-xl lg:flex-1" />
        </div>
      </div>
    </Card>
  );
}
