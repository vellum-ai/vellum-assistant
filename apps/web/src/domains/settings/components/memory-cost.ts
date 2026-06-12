/**
 * Pure helpers for the Memory card's cost summary. Kept free of generated-SDK
 * and React imports so they can be unit-tested in isolation.
 */

export interface MemoryCostCallSite {
  id: string;
  domain: string;
}

export interface MemoryCostBreakdownRow {
  groupKey?: string | null;
  totalEstimatedCostUsd: number;
}

/**
 * Sum the estimated cost of breakdown rows whose call site belongs to the
 * "memory" domain. Rows without a `groupKey` (events recorded before
 * call-site attribution existed) are excluded rather than over-attributed.
 */
export function sumMemoryCallSiteCostUsd(
  breakdown: readonly MemoryCostBreakdownRow[],
  callSites: readonly MemoryCostCallSite[],
): number {
  const memoryCallSiteIds = new Set(
    callSites.filter((site) => site.domain === "memory").map((site) => site.id),
  );
  let total = 0;
  for (const row of breakdown) {
    if (row.groupKey && memoryCallSiteIds.has(row.groupKey)) {
      total += row.totalEstimatedCostUsd;
    }
  }
  return total;
}

export function formatMemoryCostUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) {
    return "$0.00";
  }
  if (usd < 0.01) {
    return "Less than $0.01";
  }
  return `$${usd.toFixed(2)}`;
}
