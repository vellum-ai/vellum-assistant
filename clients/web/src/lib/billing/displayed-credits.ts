/**
 * The dollar figure the "Credits" labels name: what was bought or earned on
 * top of the usage grants.
 *
 * The initial credit grant and a Pro sub's monthly bundle are what the Usage
 * Balance bar measures, so the credits figures leave those out. Shared by the
 * billing page's balance tile and the preferences menu's credits row so the
 * two can never quote different amounts for the same wallet.
 *
 * The banners and the exhausted/low-balance flags stay keyed on the full
 * effective balance, which is what the next turn can actually spend.
 */

import { parseUsd } from "@/lib/billing/parse-usd";

/**
 * The balance to display: the effective balance less whatever is still unused
 * on the usage grants, never below zero. Returns the balance untouched when
 * the platform reports no grant figure.
 */
export function displayedCreditsUsd(
  balance: string,
  availableUsageBalance: string | null | undefined,
): string {
  const balanceUsd = parseUsd(balance);
  const availableUsd = parseUsd(availableUsageBalance);
  if (balanceUsd == null || availableUsd == null) {
    return balance;
  }
  return Math.max(0, balanceUsd - availableUsd).toFixed(2);
}
