/**
 * Shared price formatters for the Pro plan tier/credit pickers.
 *
 * Both `tier-picker` (machine/storage) and `credit-bundle-picker` render
 * monthly prices and price deltas in the same style, and `plan-card` shows the
 * current credit bundle's monthly price. Centralising the formatting here keeps
 * those surfaces byte-for-byte consistent — in particular the cents-aware
 * whole-dollar rule, so a sub-dollar tier reads as `$9.95/mo` everywhere rather
 * than rounding to `$10/mo` in one place and `$9.95/mo` in another.
 */

/** "$50" for whole-dollar amounts; "$50.50" only when cents are present. */
export function formatDollars(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

/** "$50/mo" for whole-dollar amounts; "$50.50/mo" only when cents are present. */
export function formatMonthly(cents: number): string {
  return `${formatDollars(cents)}/mo`;
}

/**
 * Signed monthly delta, e.g. `+$25/mo` or `−$25/mo`. Uses the U+2212 minus
 * sign (not an ASCII hyphen) so a negative delta typesets cleanly.
 */
export function formatDelta(deltaCents: number): string {
  const prefix = deltaCents > 0 ? "+" : "−";
  return `${prefix}${formatDollars(Math.abs(deltaCents))}/mo`;
}
