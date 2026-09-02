import { Skeleton } from "@vellumai/design-library/components/skeleton";

import { useTranslation } from "@/i18n";

/** Row height copied from a mounted Stripe input. */
const FIELD_ROW_CLASS = "h-[42px] w-full rounded-lg";

/**
 * Vertical rhythm of the field stack, shared with the mounted form. The five
 * rows match the manual-entry baseline; the reveal grows past it whenever Link
 * renders its banner or, for a signed-in member, its saved-card panel.
 */
export const FIELD_STACK_CLASS = "flex flex-col gap-[10px]";

/**
 * Stand-in for the mounted card and billing-address inputs: card number, the
 * expiry/CVC pair, then name, country and street. It carries the whole loading
 * story, from the SetupIntent fetch through the iframes' own boot.
 */
export function FieldSkeletons() {
  const { t } = useTranslation("settings");
  return (
    <div
      role="status"
      aria-label={t("autoTopUpPaymentMethodModal.loadingLabel")}
      data-testid="auto-top-up-pm-modal-skeleton"
      className={FIELD_STACK_CLASS}
    >
      <Skeleton aria-hidden className={FIELD_ROW_CLASS} />
      <div className="grid grid-cols-2 gap-[10px]">
        <Skeleton aria-hidden className={FIELD_ROW_CLASS} />
        <Skeleton aria-hidden className={FIELD_ROW_CLASS} />
      </div>
      <Skeleton aria-hidden className={FIELD_ROW_CLASS} />
      <Skeleton aria-hidden className={FIELD_ROW_CLASS} />
      <Skeleton aria-hidden className={FIELD_ROW_CLASS} />
    </div>
  );
}
