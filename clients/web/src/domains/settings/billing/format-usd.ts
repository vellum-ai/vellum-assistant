/**
 * Format a USD decimal string like "25.00" as "$25" (or "$25.50" if non-zero
 * cents, "$1,250" with en-US separators). The en-US formatting is intentional:
 * these are USD amounts, rendered the same in every UI locale. Nullish or
 * unparseable input renders "$0"; negatives render "-$5".
 *
 * Single source of truth for short dollar amounts on billing surfaces (the
 * auto-top-up summary, the checkout bonus offer). Import this rather than
 * writing a private copy so the display rule cannot drift between surfaces.
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
