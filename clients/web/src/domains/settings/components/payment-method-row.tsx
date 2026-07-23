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
      className="flex items-center justify-between gap-2 rounded-lg bg-[var(--surface-base)] pl-3 pr-2 py-1.5"
    >
      <div className="flex items-center gap-2">
        <CreditCard
          aria-hidden
          className="h-4 w-4 text-[var(--content-default)]"
        />
        <div>
          <Typography
            as="p"
            variant="body-medium-default"
            className="text-[var(--content-default)]"
          >
            {brand ? brandLabel(brand) : "Saved card"}
          </Typography>
          {last4 != null && (
            <Typography
              as="p"
              variant="body-small-default"
              className="text-[var(--content-tertiary)]"
            >
              Ending in {last4}
            </Typography>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="outlined"
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
