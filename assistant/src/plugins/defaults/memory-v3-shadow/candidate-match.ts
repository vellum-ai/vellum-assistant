// ---------------------------------------------------------------------------
// Procedural-memory candidate-identity matcher (Tier 0 + Tier 1)
// ---------------------------------------------------------------------------
//
// Recurrence-gating needs to recognize that a freshly-captured procedure is
// *the same procedure* as one we have seen before, so it can count toward the
// distillation threshold. Identity keys on the procedure's **goal/intent**, not
// its step sequence — two runs of one procedure routinely differ in steps (one
// hit a retry), and averaging out that noise is the whole point of waiting for
// recurrence.
//
// The matcher is tiered, cheap → expensive, riding existing memory infra (no
// new substrate):
//
//   Tier 0 — existing skill. ANN the goal against the **skill catalog** first.
//     A high-similarity hit means this is a *run of an existing skill*, not a
//     new candidate — the caller routes any knowledge to a `skill:`-linked
//     fact rather than opening a cluster.
//   Tier 1 — candidate cluster. ANN the goal against the **candidate-note pool**
//     (member-note slugs already embedded as ordinary memory). A high hit means
//     it is provisionally the same procedure → join that cluster. A gray-band
//     hit is ambiguous → defer to the caller's Tier-2 LLM judge (a later PR).
//     Below the gray band → a genuinely new procedure.
//
// This module is a **pure, read-only matcher**: it embeds + queries but never
// writes, never touches the registry except to read member slugs, and never
// calls an LLM (the Tier-2 judge is the caller's job). The ANN/embedding seam
// and the catalog/registry reads are dependency-injected so tests exercise the
// tier logic without standing up Qdrant.

import { getConfig } from "../../../config/loader.js";
import { loadSkillCatalog } from "../../../config/skills.js";
import type { AssistantConfig } from "../../../config/types.js";
import {
  EMBED_BASE_DELAY_MS,
  EMBED_MAX_RETRIES,
  isAbortError,
  isTransientEmbeddingError,
} from "../../../memory/embed.js";
import { simBatch } from "../../../memory/v2/sim.js";
import { skillSlugFor } from "../../../memory/v2/skill-store.js";
import { getLogger } from "../../../util/logger.js";
import { abortableSleep, computeRetryDelay } from "../../../util/retry.js";

const log = getLogger("memory-v3-candidate-match");

// ─── Thresholds ──────────────────────────────────────────────────────────────
//
// Bias precision over recall (per the design doc). Over-merging ships a skill
// that conflates two procedures — a permanent bad catalog entry, the exact
// pollution we are killing. Under-merging just delays a promotion, nearly free.
// So both bars are HIGH, and the gray band between them is narrow.

/**
 * Tier 0 — a goal at or above this fused similarity to a skill capability page
 * is treated as a *run of that existing skill*. High, since a false positive
 * here silently suppresses a legitimately new procedure.
 */
export const EXISTING_SKILL_THRESHOLD = 0.82;

/**
 * Tier 1 — a goal at or above this fused similarity to a candidate note joins
 * that note's cluster. Deliberately high: over-merging two distinct procedures
 * is the costly failure, so the bar to declare "same procedure" is strict.
 */
export const CLUSTER_MATCH_THRESHOLD = 0.78;

/**
 * Tier 1 gray band — a goal whose best candidate similarity falls in
 * `[GRAY_BAND_THRESHOLD, CLUSTER_MATCH_THRESHOLD)` is ambiguous (a borderline
 * match or a dangerous near-miss like "deploy preview" vs "deploy production").
 * The matcher reports `gray` and the caller's Tier-2 LLM judge breaks the tie
 * — toward "different" — in a later PR.
 */
export const GRAY_BAND_THRESHOLD = 0.7;

/** A scored ANN hit: a corpus slug and its fused dense+sparse similarity. */
export interface ScoredSlug {
  slug: string;
  score: number;
}

/**
 * The injectable scoring seam. Given the goal text and a slug restriction,
 * return each restricted slug's fused dense+sparse similarity to the goal.
 * Defaults to {@link simBatch} (the v2 slug-restricted hybrid scorer, including
 * its adaptive dense/sparse reweighting, so candidate-match scores stay on the
 * same scale as v2 recall); tests pass a fake so the tier logic runs without a
 * live collection.
 */
export type ScoreSlugsFn = (
  goal: string,
  restrictToSlugs: readonly string[],
) => Promise<ScoredSlug[]>;

/**
 * A registered candidate cluster reduced to what Tier 1 needs: its identity
 * (`clusterId` — the registry/store key) and the member-note slugs embedded for
 * it. The matcher restricts the ANN to the member-note slugs but always reports
 * the OWNING `clusterId`, never a note slug — the store keys every mutator
 * (`getCandidate`/`incrementCandidate`/`addMemberNote`) on `cluster_id`.
 */
export interface CandidateClusterRef {
  clusterId: string;
  memberNoteSlugs: readonly string[];
}

export interface MatchCandidateOptions {
  /**
   * Existing candidate clusters (Tier 1 targets), each carrying its `clusterId`
   * and its embedded member-note slugs. The matcher ANN-restricts to the union
   * of member-note slugs but maps any hit back to its owning `clusterId`. The
   * caller owns enumeration of the candidate pool (the trigger re-reads it per
   * note so a cluster opened earlier in the pass is visible to later notes).
   */
  listCandidateClusters: () => CandidateClusterRef[];
  /** Config used for embedding + fusion weights. Defaults to `getConfig()`. */
  config?: AssistantConfig;
  /** ANN scorer (Tier 0 + Tier 1). Defaults to the {@link simBatch} scorer. */
  scoreSlugs?: ScoreSlugsFn;
  /** Live skill catalog (Tier 0 targets). Defaults to `loadSkillCatalog()`. */
  loadCatalog?: () => { id: string }[];
}

/** The matcher's verdict — which tier (if any) claimed the goal. */
export type MatchResult =
  | { kind: "existing-skill"; skillId: string }
  | { kind: "cluster"; clusterId: string }
  | { kind: "gray"; clusterId: string }
  | { kind: "new" };

/**
 * Classify a captured procedure's `goal` against existing skills (Tier 0) and
 * candidate clusters (Tier 1).
 *
 *   - `existing-skill` — the goal matches a live skill at/above
 *     {@link EXISTING_SKILL_THRESHOLD}; it is a run of that skill, not a new
 *     candidate.
 *   - `cluster` — the goal matches a candidate note at/above
 *     {@link CLUSTER_MATCH_THRESHOLD}; it joins that note's cluster.
 *   - `gray` — the best candidate match is in the gray band; ambiguous, deferred
 *     to the caller's Tier-2 judge. Carries the borderline `clusterId` so the
 *     judge knows which cluster it is weighing the goal against.
 *   - `new` — no skill or candidate is close enough; a genuinely new procedure.
 *
 * Pure and read-only: no writes, no LLM call.
 */
export async function matchCandidate(
  goal: string,
  opts: MatchCandidateOptions,
): Promise<MatchResult> {
  const config = opts.config ?? getConfig();
  const scoreSlugs =
    opts.scoreSlugs ?? ((g, slugs) => scoreSlugsWithSimBatch(config, g, slugs));
  const loadCatalog = opts.loadCatalog ?? (() => loadSkillCatalog());
  const { listCandidateClusters } = opts;

  // ── Tier 0 — existing skill. ───────────────────────────────────────────────
  // Map each skill id to its capability-page slug, score them, and resolve the
  // best back to its id.
  const slugToSkillId = new Map<string, string>();
  for (const skill of loadCatalog()) {
    slugToSkillId.set(skillSlugFor(skill.id), skill.id);
  }
  const skillBest = await bestHit(scoreSlugs, goal, [...slugToSkillId.keys()]);
  if (skillBest && skillBest.score >= EXISTING_SKILL_THRESHOLD) {
    const skillId = slugToSkillId.get(skillBest.slug);
    if (skillId) {
      return { kind: "existing-skill", skillId };
    }
  }

  // ── Tier 1 — candidate cluster. ────────────────────────────────────────────
  // Member-note slugs are EMBEDDED, so the ANN must run against them — but a
  // note slug is NOT a clusterId. Build a `memberNoteSlug → clusterId` map so a
  // hit resolves back to the OWNING cluster's store key; the caller keys every
  // mutator (`incrementCandidate`/`addMemberNote`) on `cluster_id`, so returning
  // a note slug would update zero rows or fork a duplicate cluster.
  const slugToClusterId = new Map<string, string>();
  for (const cluster of listCandidateClusters()) {
    for (const slug of cluster.memberNoteSlugs) {
      slugToClusterId.set(slug, cluster.clusterId);
    }
  }
  const candidateBest = await bestHit(scoreSlugs, goal, [
    ...slugToClusterId.keys(),
  ]);
  if (candidateBest) {
    const clusterId = slugToClusterId.get(candidateBest.slug);
    if (clusterId) {
      if (candidateBest.score >= CLUSTER_MATCH_THRESHOLD) {
        return { kind: "cluster", clusterId };
      }
      if (candidateBest.score >= GRAY_BAND_THRESHOLD) {
        return { kind: "gray", clusterId };
      }
    }
  }

  return { kind: "new" };
}

/** Score a slug restriction and return its single best (highest-scoring) hit. */
async function bestHit(
  scoreSlugs: ScoreSlugsFn,
  goal: string,
  restrictToSlugs: readonly string[],
): Promise<ScoredSlug | null> {
  if (restrictToSlugs.length === 0) return null;
  const scored = await scoreSlugs(goal, restrictToSlugs);
  let best: ScoredSlug | null = null;
  for (const hit of scored) {
    if (!best || hit.score > best.score) best = hit;
  }
  return best;
}

/**
 * Default scorer: delegate to {@link simBatch}, the v2 slug-restricted hybrid
 * scorer. `simBatch` embeds the goal (dense + BM25 sparse), runs the
 * slug-restricted hybrid query, applies the adaptive dense/sparse reweighting,
 * and fuses the body/summary halves — so candidate-match scores land on the
 * same scale as v2 recall scores against the configured thresholds.
 *
 * `simBatch` embeds via `embedWithBackend` ONCE (not `embedWithRetry`), so a
 * brief provider blip (429 / 5xx / transient network error) would throw and
 * make this scorer return `[]` — a no-hit. For the matcher that silently means
 * "treat as new", so a momentary outage could miss an existing skill or fork a
 * duplicate cluster (a permanent bad catalog entry). To prevent that we wrap
 * the `simBatch` call in a bounded retry mirroring {@link embedWithRetry}'s
 * policy (same max-retries / base-delay / exponential backoff, same transient
 * predicate, same abort handling). Only AFTER retries are exhausted — or on a
 * non-transient error (a real Qdrant/config bug, where retrying is pointless) —
 * do we degrade to `[]`, logged at warn.
 */
async function scoreSlugsWithSimBatch(
  config: AssistantConfig,
  goal: string,
  restrictToSlugs: readonly string[],
): Promise<ScoredSlug[]> {
  try {
    const scores = await simBatchWithRetry(config, goal, restrictToSlugs);
    return [...scores].map(([slug, score]) => ({ slug, score }));
  } catch (err) {
    log.warn(
      { err },
      "candidate-match scorer failed after retries; degrading to no hits (treat as new)",
    );
    return [];
  }
}

/**
 * Run {@link simBatch} with the same bounded retry policy as `embedWithRetry`
 * (`simBatch` itself embeds via `embedWithBackend` with no retry). Retries only
 * transient embedding failures (429 / 5xx / retryable network error); a
 * non-transient error or an exhausted retry budget rethrows so the caller can
 * degrade to no-hit. Aborts propagate immediately and are never retried.
 */
async function simBatchWithRetry(
  config: AssistantConfig,
  goal: string,
  restrictToSlugs: readonly string[],
): Promise<Map<string, number>> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= EMBED_MAX_RETRIES; attempt++) {
    try {
      return await simBatch(goal, restrictToSlugs, config);
    } catch (err) {
      lastError = err;
      if (isAbortError(err)) throw err;
      if (!isTransientEmbeddingError(err) || attempt === EMBED_MAX_RETRIES) {
        throw err;
      }
      const delay = computeRetryDelay(attempt, EMBED_BASE_DELAY_MS);
      log.warn(
        { err, attempt: attempt + 1, delayMs: Math.round(delay) },
        "transient candidate-match embedding failure, retrying",
      );
      await abortableSleep(delay);
    }
  }
  throw lastError;
}
