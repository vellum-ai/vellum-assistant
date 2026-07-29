/**
 * The monthly dollar amount a credit tier key names. Tier keys are shaped
 * `credits_<usd>`, so a held or legacy tier the plan catalog no longer lists
 * still carries its own amount and can be priced without it. Returns null for
 * any key not in that shape, and callers decide what to show instead.
 */
export function creditTierKeyUsd(
  tier: string | null | undefined,
): number | null {
  const usd = tier?.match(/^credits_(\d+)$/)?.[1];
  return usd != null ? Number(usd) : null;
}
