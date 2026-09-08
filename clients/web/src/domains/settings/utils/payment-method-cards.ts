import type {
  CardOnFile,
  PaymentMethodModalMode,
} from "@/domains/settings/components/payment-method-modal-shell";
import type { AutoTopUpConfigResponse } from "@/generated/api/types.gen";

export interface PaymentMethodCardEntry {
  id: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
}

/**
 * The cards to list. The backend keeps at most one payment method and has no
 * list endpoint, so this is always length 0 or 1 today; the array is what the
 * multi-card render in `PaymentMethodsCard` is written against.
 */
export function paymentMethodCards(
  config: AutoTopUpConfigResponse | undefined,
): PaymentMethodCardEntry[] {
  if (config == null || !config.has_payment_method) {
    return [];
  }
  return [
    {
      id: "primary",
      brand: config.payment_method_brand,
      last4: config.payment_method_last4,
      // `?? null` because a platform deployment older than the expiry fields
      // omits the keys entirely rather than sending them null.
      expMonth: config.payment_method_exp_month ?? null,
      expYear: config.payment_method_exp_year ?? null,
    },
  ];
}

/**
 * What the payment modal was opened with. Captured on the click that opens it,
 * because a successful save writes the new card into the config query cache
 * before the modal closes: derived props would flip an in-flight add into
 * replace mode and name the card that was just saved in the subtitle.
 */
export interface PaymentModalSnapshot {
  mode: PaymentMethodModalMode;
  cardOnFile: CardOnFile | null;
}

/**
 * The mode a card on file calls for: replacing the saved card once one exists,
 * adding one otherwise. Every entry point saves through the same setup flow,
 * including the repeated-declines cutoff, where the declined card is still
 * attached and is the one being replaced.
 */
export function modalSnapshotFor(
  cards: PaymentMethodCardEntry[],
): PaymentModalSnapshot {
  const [existing] = cards;
  if (existing == null) {
    return { mode: "add", cardOnFile: null };
  }
  return {
    mode: "replace",
    cardOnFile: {
      brand: existing.brand,
      last4: existing.last4,
      expMonth: existing.expMonth,
      expYear: existing.expYear,
    },
  };
}
