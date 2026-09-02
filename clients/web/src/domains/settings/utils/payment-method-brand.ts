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
 * The display label, or null when there is no brand to name. Stripe's own
 * `"unknown"`, for a card whose network it could not identify, counts as no
 * brand: passed through it reads as a word mid sentence, as in "Replacing
 * unknown •••• 4242".
 */
export function brandLabel(brand: string | null): string | null {
  const key = brand?.toLowerCase();
  if (key == null || key === "unknown") {
    return null;
  }
  return BRAND_LABELS[key] ?? brand;
}

/** The brand label, or the one fallback for a card Stripe gave no brand for. */
export function brandDisplayLabel(
  t: TFunction<"settings">,
  brand: string | null,
): string {
  return brandLabel(brand) ?? t("paymentMethodRow.savedCard");
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
