import { CreditCard } from "lucide-react";

import { Button } from "@vellumai/design-library/components/button";
import { Typography } from "@vellumai/design-library/components/typography";

import { brandLabel } from "@/domains/settings/utils/payment-method-brand";

export interface PaymentMethodRowProps {
  brand: string | null;
  last4: string | null;
  onUpdateCard: () => void;
  onRemove: () => void;
  removing?: boolean;
}

export function PaymentMethodRow({
  brand,
  last4,
  onUpdateCard,
  onRemove,
  removing = false,
}: PaymentMethodRowProps) {
  return (
    <div
      data-testid="payment-method-row"
      className="flex items-center justify-between gap-2 rounded-lg border border-[var(--border-base)] pl-3 pr-2 py-1.5"
    >
      <div className="flex min-w-0 items-center gap-2">
        <CreditCard
          aria-hidden
          className="h-4 w-4 shrink-0 text-[var(--content-default)]"
        />
        {/* leading-snug: the type tokens are line-height:1 and truncate's
            overflow clipping would cut descenders without real line height. */}
        <div className="flex min-w-0 items-baseline gap-2">
          <Typography
            as="p"
            variant="body-medium-default"
            className="truncate leading-snug text-[var(--content-default)]"
          >
            {brand ? brandLabel(brand) : "Saved card"}
          </Typography>
          {last4 != null && (
            <Typography
              as="p"
              variant="body-small-default"
              className="truncate leading-snug text-[var(--content-tertiary)]"
            >
              Ending in {last4}
            </Typography>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          variant="ghost"
          onClick={onUpdateCard}
          data-testid="payment-method-update"
        >
          Update Card
        </Button>
        <Button
          variant="dangerOutline"
          onClick={onRemove}
          disabled={removing}
          data-testid="payment-method-remove"
        >
          {removing ? "Removing…" : "Remove"}
        </Button>
      </div>
    </div>
  );
}
