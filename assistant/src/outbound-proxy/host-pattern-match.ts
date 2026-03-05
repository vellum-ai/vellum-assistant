/**
 * Shared host-pattern matching primitive.
 *
 * Provides deterministic, case-insensitive hostname matching against
 * glob-style patterns (e.g. "*.fal.run") with configurable apex inclusion.
 * Used by the proxy router and policy engines.
 */

export type HostMatchKind = "none" | "wildcard" | "exact";

export interface MatchHostPatternOptions {
  /** When true, "*.domain" also matches bare "domain". Defaults to false. */
  includeApexForWildcard?: boolean;
}

/**
 * Match a hostname against a glob-style host pattern.
 *
 * Supports:
 * - Exact match: "api.fal.run" matches "api.fal.run"
 * - Wildcard match: "*.fal.run" matches "api.fal.run"
 * - Apex inclusion (opt-in): "*.fal.run" matches "fal.run"
 *
 * All comparisons are case-insensitive.
 */
export function matchHostPattern(
  host: string,
  pattern: string,
  options?: MatchHostPatternOptions,
): HostMatchKind {
  const lHost = host.toLowerCase();
  const lPattern = pattern.toLowerCase();

  if (lHost === lPattern) return "exact";

  if (lPattern.startsWith("*.")) {
    const suffix = lPattern.slice(1); // ".fal.run"
    // Subdomain match: "api.fal.run".endsWith(".fal.run") and is longer
    if (lHost.endsWith(suffix) && lHost.length > suffix.length) {
      return "wildcard";
    }
    // Apex inclusion: "*.fal.run" matches bare "fal.run"
    if (options?.includeApexForWildcard && lHost === lPattern.slice(2)) {
      return "wildcard";
    }
  }

  return "none";
}

/**
 * Compare two match results by specificity.
 * Returns negative if `a` is more specific, positive if `b` is, zero if equal.
 *
 * Ordering: exact > wildcard > none
 */
export function compareMatchSpecificity(
  a: HostMatchKind,
  b: HostMatchKind,
): number {
  const rank: Record<HostMatchKind, number> = {
    exact: 2,
    wildcard: 1,
    none: 0,
  };
  return rank[b] - rank[a];
}
