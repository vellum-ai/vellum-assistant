/**
 * Memory v3 — corpus-size-adaptive retrieval tuning.
 *
 * The full retrieval machinery (dense lane, selector LLM call, learned-edge
 * lane, wide candidate pools) earns its latency only once an assistant has a
 * real corpus to retrieve from. Brand-new and sparse-corpus assistants run a
 * lean profile instead: smaller pools, no dense embedding, no selector call —
 * minimizing time-to-first-token when there is little or nothing to surface.
 *
 * {@link resolveV3Tuning} picks the profile by the assistant's real concept-page
 * count, measured at lane build. Below {@link MEMORY_V3_FULL_PROFILE_MIN_PAGES}
 * pages it returns {@link MEMORY_V3_NEW_USER_TUNING}; at or above it returns the
 * configured values (the full profile shipped as the schema default, or the
 * user's explicit overrides).
 */

import type { AssistantConfig } from "../../../../config/schema.js";

/**
 * The v3 tuning fields that switch between the lean new-user profile and the
 * full profile. Lane-build params (`hotSetK`, `freshSetK`, `learnedEdgesCap`)
 * and per-turn orchestrate params are resolved together at lane build so they
 * never disagree mid-conversation.
 */
export interface ResolvedV3Tuning {
  hotSetK: number;
  freshSetK: number;
  needleK: number;
  denseK: number;
  replyQueryK: number;
  selectorEnabled: boolean;
  learnedEdgesCap: number;
  edgeSeedCount: number;
  edgePerSeed: number;
  edgeCap: number;
}

/**
 * Real concept pages an assistant must have before retrieval switches from the
 * lean new-user profile to the full profile. Below this the BM25 needle alone
 * covers the whole corpus, so the full machinery's cost (selector LLM call +
 * dense embedding) is not yet earned. The single knob for where "doesn't have
 * much memory" ends.
 */
export const MEMORY_V3_FULL_PROFILE_MIN_PAGES = 10;

/**
 * Lean profile for brand-new / sparse-corpus assistants: dense lane off,
 * selector off, learned-edge lane off, and small pools. Applied until the
 * corpus crosses {@link MEMORY_V3_FULL_PROFILE_MIN_PAGES} real concept pages.
 */
export const MEMORY_V3_NEW_USER_TUNING: ResolvedV3Tuning = {
  hotSetK: 8,
  freshSetK: 8,
  needleK: 12,
  denseK: 0,
  replyQueryK: 0,
  selectorEnabled: false,
  learnedEdgesCap: 0,
  edgeSeedCount: 6,
  edgePerSeed: 1,
  edgeCap: 6,
};

/**
 * Select the v3 tuning for this lane build by corpus size. Below the threshold,
 * the lean new-user profile; at or above it, the configured values — which are
 * the full profile by default, or whatever an established assistant's config
 * overrides resolve to.
 */
export function resolveV3Tuning(
  config: AssistantConfig,
  realConceptPageCount: number,
): ResolvedV3Tuning {
  if (realConceptPageCount < MEMORY_V3_FULL_PROFILE_MIN_PAGES) {
    return MEMORY_V3_NEW_USER_TUNING;
  }
  const v3 = config.memory.v3;
  return {
    hotSetK: v3.hotSet.k,
    freshSetK: v3.freshSet.k,
    needleK: v3.needleK,
    denseK: v3.denseK,
    replyQueryK: v3.replyQueryK,
    selectorEnabled: v3.selectorEnabled,
    learnedEdgesCap: v3.learnedEdges.cap,
    edgeSeedCount: v3.edge.seedCount,
    edgePerSeed: v3.edge.perSeed,
    edgeCap: v3.edge.cap,
  };
}
