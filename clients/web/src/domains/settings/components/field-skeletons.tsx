import { Skeleton } from "@vellumai/design-library/components/skeleton";

import { useTranslation } from "@/i18n";

/** Row height of a mounted Stripe input, so the swap does not move the modal. */
const FIELD_ROW_CLASS = "h-[42px] w-full rounded-lg";

/**
 * Vertical rhythm of the field stack. The skeleton and the mounted form share
 * it so they stay the same height and the reveal does not move the modal.
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
