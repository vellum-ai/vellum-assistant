/**
 * Single source of truth for USD amounts on billing surfaces. Every dollar
 * figure the chat banners and the billing settings cards render comes from
 * here, so the display rule cannot drift between surfaces. The en-US
 * formatting is intentional: these are USD amounts, rendered the same in
 * every UI locale.
 */

/**
 * Format a USD decimal string like "25.00" as "$25" (or "$25.50" if non-zero
 * cents, "$1,250" with en-US separators). Nullish or unparseable input renders
 * "$0"; negatives render "-$5".
 *
 * Reach for this where the amount is a label and a trailing ".00" is noise:
 * the auto-top-up summary, the checkout bonus offer.
 */
export function formatUsdShort(value: string | null | undefined): string {
  if (!value) {
    return "$0";
  }
  const n = parseFloat(value);
  if (!Number.isFinite(n)) {
    return "$0";
  }
  const abs = Math.abs(n);
  const formatted = abs.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const stripped = formatted.endsWith(".00")
    ? formatted.slice(0, -3)
    : formatted;
  return n < 0 ? `-$${stripped}` : `$${stripped}`;
}

/**
 * Format a USD decimal string ("5.00") as "$5.00", always keeping cents.
 *
 * Reach for this where the amount is the exact figure a limit or a day's
 * spend is measured against, so dropping the cents would misstate it. A
 * nullish amount returns `null` rather than "$0": a caller that only
 * sometimes knows the value can omit the clause instead of asserting an
 * amount that was never reported.
 */
export function formatUsd(value: string): string;
export function formatUsd(value: string | null | undefined): string | null;
export function formatUsd(value: string | null | undefined): string | null {
  if (value == null) {
    return null;
  }
  const n = parseFloat(value);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : `$${value}`;
}
