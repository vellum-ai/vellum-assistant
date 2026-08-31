import type { ReactNode } from "react";

export interface PaymentMethodsActionSlotProps {
  children?: ReactNode;
}

/**
 * The Payment Methods header's action slot, shared by the resolved card and
 * its skeleton. It is mounted at button height whether or not it holds an
 * action: a slot that appeared only when it had something to show would take
 * its whole row back out of the header (about 44px, stacked below `sm`) as
 * soon as a card-on-file config landed.
 */
export function PaymentMethodsActionSlot({
  children,
}: PaymentMethodsActionSlotProps) {
  return (
    <div
      className="flex h-8 items-center"
      data-testid="payment-methods-action-slot"
    >
      {children}
    </div>
  );
}
