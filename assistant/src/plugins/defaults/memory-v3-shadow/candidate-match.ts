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
import { embedWithRetry } from "../../../memory/embed.js";
import { hybridQueryConceptPages } from "../../../memory/v2/qdrant.js";
import { fuseHalf } from "../../../memory/v2/sim.js";
import { generateBm25QueryEmbedding } from "../../../memory/v2/sparse-bm25.js";
import { getLogger } from "../../../util/logger.js";
import {
  listCandidatesByStatus,
  type ProcCandidateStatus,
} from "./proc-candidate-store.js";

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

/**
 * Per-channel ANN fetch limit. The candidate/skill pools are small (tens to low
 * thousands of pages), and we only ever read the single best hit, so a modest
 * limit is plenty of headroom while keeping each Qdrant round-trip cheap.
 */
const ANN_LIMIT = 32;

/** Prefix under which a skill `<id>` is embedded as a capability page. */
function skillSlug(id: string): string {
  return `skills/${id}`;
}

/** A scored ANN hit: a corpus slug and its fused dense+sparse similarity. */
export interface ScoredSlug {
  slug: string;
  score: number;
}

/**
 * The injectable scoring seam. Given the embedded goal and a slug restriction,
 * return each restricted slug's fused dense+sparse similarity to the goal.
 * Defaults to a real Qdrant-backed query (`scoreSlugsWithQdrant`); tests pass a
 * fake so the tier logic runs without a live collection.
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
  /** Config used for embedding + fusion weights. Defaults to `getConfig()`. */
  config?: AssistantConfig;
  /** ANN scorer (Tier 0 + Tier 1). Defaults to the Qdrant-backed scorer. */
  scoreSlugs?: ScoreSlugsFn;
  /** Live skill catalog (Tier 0 targets). Defaults to `loadSkillCatalog()`. */
  loadCatalog?: () => { id: string }[];
  /**
   * Existing candidate clusters (Tier 1 targets), each carrying its `clusterId`
   * and its embedded member-note slugs. The matcher ANN-restricts to the union
   * of member-note slugs but maps any hit back to its owning `clusterId`.
   * Defaults to every registered cluster across the tracked statuses.
   */
  listCandidateClusters?: () => CandidateClusterRef[];
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
  opts: MatchCandidateOptions = {},
): Promise<MatchResult> {
  const config = opts.config ?? getConfig();
  const scoreSlugs =
    opts.scoreSlugs ?? ((g, slugs) => scoreSlugsWithQdrant(config, g, slugs));
  const loadCatalog = opts.loadCatalog ?? (() => loadSkillCatalog());
  const listCandidateClusters =
    opts.listCandidateClusters ?? defaultCandidateClusters;

  // ── Tier 0 — existing skill. ───────────────────────────────────────────────
  // Map each skill id to its capability-page slug, score them, and resolve the
  // best back to its id.
  const slugToSkillId = new Map<string, string>();
  for (const skill of loadCatalog()) {
    slugToSkillId.set(skillSlug(skill.id), skill.id);
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
 * Default Tier-1 target set: every registered candidate cluster across the
 * tracked statuses, each carrying its `clusterId` and embedded member-note
 * slugs. Read-only — `listCandidatesByStatus` only SELECTs.
 */
const CANDIDATE_STATUSES: ProcCandidateStatus[] = [
  "observing",
  "ready",
  "distilled",
];

function defaultCandidateClusters(): CandidateClusterRef[] {
  const clusters: CandidateClusterRef[] = [];
  for (const status of CANDIDATE_STATUSES) {
    for (const candidate of listCandidatesByStatus(status)) {
      clusters.push({
        clusterId: candidate.clusterId,
        memberNoteSlugs: candidate.memberNoteSlugs,
      });
    }
  }
  return clusters;
}

/**
 * Default scorer: embed `goal` (dense via `embedWithRetry`, sparse via
 * `generateBm25QueryEmbedding` — the same pair `sources/memory-v2.ts` builds),
 * run a slug-restricted hybrid query, and fuse each hit's dense+sparse channels
 * into one similarity via `fuseHalf` with the configured `dense_weight` /
 * `sparse_weight`. Body and summary halves are fused independently and the max
 * is taken per slug, exactly as the recall source does. Returns `[]` on any
 * embedding/Qdrant failure (logged at warn) so a matcher outage degrades to
 * "treat as new" rather than throwing.
 */
async function scoreSlugsWithQdrant(
  config: AssistantConfig,
  goal: string,
  restrictToSlugs: readonly string[],
): Promise<ScoredSlug[]> {
  const trimmed = goal.trim();
  if (trimmed.length === 0 || restrictToSlugs.length === 0) return [];

  try {
    const denseResult = await embedWithRetry(config, [trimmed]);
    const denseVector = denseResult.vectors[0] ?? [];
    const sparseVector = generateBm25QueryEmbedding(trimmed);

    const hits = await hybridQueryConceptPages(
      denseVector,
      sparseVector,
      ANN_LIMIT,
      restrictToSlugs,
    );
    if (hits.length === 0) return [];

    const { dense_weight: denseWeight, sparse_weight: sparseWeight } =
      config.memory.v2;

    // Normalize each sparse channel against its own per-batch max, mirroring
    // sim.ts / the v2 recall source so scores are comparable to the thresholds.
    let maxBodySparse = 0;
    let maxSummarySparse = 0;
    for (const hit of hits) {
      if (hit.sparseScore !== undefined && hit.sparseScore > maxBodySparse) {
        maxBodySparse = hit.sparseScore;
      }
      if (
        hit.summarySparseScore !== undefined &&
        hit.summarySparseScore > maxSummarySparse
      ) {
        maxSummarySparse = hit.summarySparseScore;
      }
    }

    return hits.map((hit) => {
      const bodyScore = fuseHalf(
        hit.denseScore,
        hit.sparseScore,
        maxBodySparse,
        denseWeight,
        sparseWeight,
      );
      const summaryScore = fuseHalf(
        hit.summaryDenseScore,
        hit.summarySparseScore,
        maxSummarySparse,
        denseWeight,
        sparseWeight,
      );
      const score = Math.max(bodyScore ?? 0, summaryScore ?? bodyScore ?? 0);
      return { slug: hit.slug, score };
    });
  } catch (err) {
    log.warn(
      { err },
      "candidate-match scorer failed; degrading to no hits (treat as new)",
    );
    return [];
  }
}
