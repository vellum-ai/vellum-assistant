import type { TFunction } from "@/i18n";

/**
 * Canonical display labels for the raw Stripe payment-method brand strings,
 * so the payment-method display renders `"Visa"` rather than `"visa"`.
 */
const BRAND_LABELS: Record<string, string> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "Amex",
  discover: "Discover",
  diners: "Diners Club",
  jcb: "JCB",
  unionpay: "UnionPay",
};

/**
 * The display label, or null when there is no brand to name. Anything the map
 * has no label for counts as no brand rather than reaching the screen raw:
 * Stripe sends `"unknown"` for a card whose network it could not identify, and
 * values such as `"eftpos_au"` and `"link"` for networks we name nothing for,
 * and the platform passes all of them through untouched. Rendered as-is they
 * read as an enum mid sentence, as in "Replacing eftpos_au •••• 4242".
 */
export function brandLabel(brand: string | null | undefined): string | null {
  const key = brand?.toLowerCase();
  if (!key) {
    return null;
  }
  return Object.hasOwn(BRAND_LABELS, key) ? BRAND_LABELS[key] : null;
}

/** The brand label, or the one fallback for a card we can name no brand for. */
export function brandDisplayLabel(
  t: TFunction<"settings">,
  brand: string | null | undefined,
): string {
  return brandLabel(brand) ?? t("paymentMethodRow.savedCard");
}

/**
 * The two halves an expiry is written from, or null when either is missing.
 *
 * Handed to a message as-is so the catalog sentence owns the separator and the
 * order, which differ by locale.
 */
export function cardExpiryParts(
  expMonth: number | null | undefined,
  expYear: number | null | undefined,
): { month: string; year: string } | null {
  if (expMonth == null || expYear == null) {
    return null;
  }
  return {
    month: String(expMonth).padStart(2, "0"),
    year: String(expYear).slice(-2),
  };
}

/** Carries its own leading separator, so callers render it as-is. */
export function cardExpiryLabel(
  t: TFunction<"settings">,
  expMonth: number | null | undefined,
  expYear: number | null | undefined,
): string | null {
  const parts = cardExpiryParts(expMonth, expYear);
  if (parts === null) {
    return null;
  }
  return t("autoTopUpPaymentMethodModal.cardOnFileExpiry", parts);
}
