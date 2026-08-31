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

export function brandLabel(brand: string): string {
  return BRAND_LABELS[brand.toLowerCase()] ?? brand;
}

/** The brand label, or the one fallback for a card Stripe gave no brand for. */
export function brandDisplayLabel(
  t: TFunction<"settings">,
  brand: string | null,
): string {
  return brand ? brandLabel(brand) : t("paymentMethodRow.savedCard");
}

/** Carries its own leading separator, so callers render it as-is. */
export function cardExpiryLabel(
  t: TFunction<"settings">,
  expMonth: number | null,
  expYear: number | null,
): string | null {
  if (expMonth == null || expYear == null) {
    return null;
  }
  return t("autoTopUpPaymentMethodModal.cardOnFileExpiry", {
    month: String(expMonth).padStart(2, "0"),
    year: String(expYear).slice(-2),
  });
}
