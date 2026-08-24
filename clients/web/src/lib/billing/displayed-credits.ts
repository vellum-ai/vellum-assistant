/**
 * What the credit figures name once `obscure-credits` is on.
 *
 * The initial credit grant and a Pro sub's monthly bundle are what the Usage
 * Balance bar measures, so the numbers labelled "Credits" state only what was
 * bought or earned on top of them. Shared by the billing page's balance tile
 * and the preferences menu's credits row so the two can never quote different
 * amounts for the same wallet.
 *
 * The banners and the exhausted/low-balance flags stay keyed on the full
 * effective balance: what the next turn can actually spend has not changed,
 * only what is worth naming separately.
 */

/** A decimal-string amount as a number, or null when there is none to read. */
function parseUsd(value: string | null | undefined): number | null {
  if (value == null) {
    return null;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The balance to display: the effective balance less whatever is still unused
 * on the usage grants, never below zero. Returns the balance untouched while
 * the flag is off, and on a platform that reports no grant figure at all,
 * so both call sites stay byte-identical in those cases without repeating the
 * check.
 */
export function displayedCreditsUsd(
  obscureCredits: boolean,
  balance: string,
  availableUsageBalance: string | null | undefined,
): string {
  if (!obscureCredits) {
    return balance;
  }
  const balanceUsd = parseUsd(balance);
  const availableUsd = parseUsd(availableUsageBalance);
  if (balanceUsd == null || availableUsd == null) {
    return balance;
  }
  return Math.max(0, balanceUsd - availableUsd).toFixed(2);
}
