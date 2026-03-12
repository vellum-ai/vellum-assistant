import type { TieredCandidate } from "./tier-classifier.js";
import type { StalenessLevel } from "./types.js";

const BASE_LIFETIME_MS: Record<string, number> = {
  identity: 180 * 86_400_000, // 6 months
  preference: 90 * 86_400_000, // 3 months
  constraint: 30 * 86_400_000, // 1 month
  project: 14 * 86_400_000, // 2 weeks
  decision: 14 * 86_400_000, // 2 weeks
  event: 3 * 86_400_000, // 3 days
};

const DEFAULT_LIFETIME_MS = 30 * 86_400_000;

export function computeStaleness(
  item: {
    kind: string;
    firstSeenAt: number;
    sourceConversationCount: number;
  },
  now: number,
): { level: StalenessLevel; ratio: number } {
  const baseLifetime = BASE_LIFETIME_MS[item.kind] ?? DEFAULT_LIFETIME_MS;
  const reinforcement = 1 + 0.3 * (item.sourceConversationCount - 1);
  const effectiveLifetime = baseLifetime * reinforcement;
  const age = now - item.firstSeenAt;
  const ratio = age / effectiveLifetime;

  if (ratio < 0.5) return { level: "fresh", ratio };
  if (ratio <= 1) return { level: "aging", ratio };
  if (ratio <= 2) return { level: "stale", ratio };
  return { level: "very_stale", ratio };
}

/**
 * Demote very_stale tier-1 candidates to tier 2.
 */
export function applyStaleDemotion(
  candidates: TieredCandidate[],
): TieredCandidate[] {
  return candidates.map((c) => {
    if (c.tier === 1 && c.staleness === "very_stale") {
      return { ...c, tier: 2 as const };
    }
    return c;
  });
}
