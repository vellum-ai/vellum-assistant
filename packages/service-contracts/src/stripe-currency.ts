/**
 * Stripe amount scaling rules for charges and invoices.
 *
 * These sets follow Stripe's amount scaling rules
 * (https://docs.stripe.com/currencies), not ISO 4217 metadata: divide the
 * minor-unit integer by 100 for most currencies, by 1 for the zero-decimal
 * set (e.g. JPY, KRW), and by 1000 for the three-decimal set (e.g. BHD).
 * ISK, HUF, TWD, and UGX are deliberately absent from the zero-decimal set:
 * Stripe charges and invoices them as two-decimal amounts and treats them
 * as zero-decimal only for payouts, per Stripe's currency docs.
 *
 * Only the scaling data and digit selection live here; presentation (locale,
 * symbol vs code display, fallbacks for unknown codes) belongs to each
 * consumer.
 */
export const STRIPE_ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

export const STRIPE_THREE_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  "BHD",
  "JOD",
  "KWD",
  "OMR",
  "TND",
]);

/**
 * Fraction digits Stripe uses when charging or invoicing in the given
 * currency. Expects an uppercase ISO 4217 code; unknown codes get the
 * two-decimal default.
 */
export function stripeScaleDigits(currencyCode: string): number {
  if (STRIPE_ZERO_DECIMAL_CURRENCIES.has(currencyCode)) {
    return 0;
  }
  if (STRIPE_THREE_DECIMAL_CURRENCIES.has(currencyCode)) {
    return 3;
  }
  return 2;
}
