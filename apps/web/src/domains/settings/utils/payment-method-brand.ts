/**
 * Canonical display labels for the Stripe payment-method brand strings.
 * Centralized here so the auto-top-up summary in `AutoTopUpCard` and the
 * payment-method card in `PaymentMethodsCard` agree on capitalization.
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

/**
 * Render the canonical "<brand> •••• <last4>" shape with safe fallbacks.
 * Used by both `PaymentMethodsCard` (raw shape) and
 * `AutoTopUpCard.formatSavedPaymentMethodLine` (with "Charged to" prefix).
 *
 * Fallback chain when brand is null: passes the literal `"card"` to
 * `brandLabel`, which falls through to the default branch (lowercase
 * `"card"` is not in `BRAND_LABELS`) and returns `"card"` verbatim.
 */
export function formatBrandLast4(
  brand: string | null,
  last4: string | null,
): string {
  return `${brandLabel(brand ?? "card")} •••• ${last4 ?? "????"}`;
}
