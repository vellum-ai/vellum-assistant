import { Card } from "@vellumai/design-library/components/card";
import { Skeleton } from "@vellumai/design-library/components/skeleton";

import { BillingSectionHeader } from "@/domains/settings/components/billing-section-header";
import { PaymentMethodsActionSlot } from "@/domains/settings/components/payment-methods-action-slot";
import { SkeletonLines } from "@/domains/settings/components/skeleton-lines";

export interface PaymentMethodsCardSkeletonProps {
  /**
   * Announces the wait. `PaymentMethodsCard` passes it whenever it loads on
   * its own; the billing tab's skeleton stack leaves it off and announces the
   * whole stack once instead of once per card.
   */
  label?: string;
}

/**
 * Stand-in for `PaymentMethodsCard`: the section header with its action slot,
 * then the single card row. Built on the real header so the placeholder
 * inherits its stacking below `sm` rather than restating it.
 */
export function PaymentMethodsCardSkeleton({
  label,
}: PaymentMethodsCardSkeletonProps) {
  return (
    <Card padding="md" data-testid="payment-methods-card-skeleton">
      <BillingSectionHeader
        title={
          <Skeleton
            as="span"
            aria-hidden
            className="block h-5 w-40 rounded-md"
          />
        }
        actions={
          <PaymentMethodsActionSlot>
            <Skeleton
              aria-hidden
              className="h-8 w-24 rounded-md"
              data-testid="payment-methods-add-skeleton"
            />
          </PaymentMethodsActionSlot>
        }
      />
      <SkeletonLines
        lines={1}
        lineClassName="h-10 rounded-lg"
        className="mt-4"
        label={label}
      />
    </Card>
  );
}
