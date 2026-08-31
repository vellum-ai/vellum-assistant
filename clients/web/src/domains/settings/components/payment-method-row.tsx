import { CreditCard } from "lucide-react";

import {
  brandDisplayLabel,
  cardExpiryLabel,
} from "@/domains/settings/utils/payment-method-brand";
import { useTranslation } from "@/i18n";
import { Button } from "@vellumai/design-library/components/button";
import { Typography } from "@vellumai/design-library/components/typography";

export interface PaymentMethodRowProps {
  brand: string | null;
  last4: string | null;
  expMonth?: number | null;
  expYear?: number | null;
  onUpdateCard: () => void;
  /** Disables the row's actions, e.g. while a redirect return is resolving. */
  actionsDisabled?: boolean;
}

export function PaymentMethodRow({
  brand,
  last4,
  expMonth = null,
  expYear = null,
  onUpdateCard,
  actionsDisabled = false,
}: PaymentMethodRowProps) {
  const { t } = useTranslation("settings");
  const expiry = cardExpiryLabel(t, expMonth, expYear);

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
        <div className="flex min-w-0 items-baseline gap-2">
          <Typography
            as="p"
            variant="body-medium-default"
            className="truncate leading-snug text-[var(--content-default)]"
          >
            {brandDisplayLabel(t, brand)}
          </Typography>
          {last4 != null && (
            <Typography
              as="p"
              variant="body-small-default"
              className="truncate leading-snug text-[var(--content-tertiary)]"
            >
              {t("paymentMethodRow.endingIn", { last4 })}
            </Typography>
          )}
          {expiry != null && (
            <Typography
              as="p"
              variant="body-small-default"
              className="truncate leading-snug text-[var(--content-quiet)]"
            >
              {expiry}
            </Typography>
          )}
        </div>
      </div>
      <Button
        variant="ghost"
        onClick={onUpdateCard}
        disabled={actionsDisabled}
        data-testid="payment-method-update"
        className="shrink-0"
      >
        {t("paymentMethodRow.replaceCard")}
      </Button>
    </div>
  );
}
