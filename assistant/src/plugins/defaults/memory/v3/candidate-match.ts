// ---------------------------------------------------------------------------
// Nearest-existing-skills shortlist (skill-catalog ANN)
// ---------------------------------------------------------------------------
//
// Given a procedure's **goal/intent**, return a ranked shortlist of the existing
// skills whose capability pages are most similar to it. Identity keys on the
// goal, not the step sequence — two runs of one procedure routinely differ in
// steps, so the goal is the stable signal.
//
// The shortlist lets a caller judge whether a freshly-captured procedure is a
// run of a skill it already has (overwrite that skill) or something genuinely
// new (author a new skill). The confident same-skill mark
// ({@link EXISTING_SKILL_THRESHOLD}) is kept as a score the caller can compare
// against, but the shortlist floor ({@link SHORTLIST_THRESHOLD}) is lower so
// near-matches still surface for the caller to weigh.
//
// This module is a **pure, read-only matcher**: it embeds + queries the skill
// catalog but never writes and never calls an LLM. The ANN/embedding seam and
// the catalog read are dependency-injected so tests exercise the ranking without
// standing up Qdrant.

import { getConfig } from "../../../../config/loader.js";
import { loadSkillCatalog } from "../../../../config/skills.js";
import type { AssistantConfig } from "../../../../config/types.js";
import {
  EMBED_BASE_DELAY_MS,
  EMBED_MAX_RETRIES,
  isAbortError,
  isTransientEmbeddingError,
} from "../../../../persistence/embeddings/embed.js";
import { getLogger } from "../../../../util/logger.js";
import { abortableSleep, computeRetryDelay } from "../../../../util/retry.js";
import { simBatch } from "../v2/sim.js";
import { skillSlugFor } from "../v2/skill-store.js";

const log = getLogger("memory-v3-candidate-match");

// ─── Thresholds ──────────────────────────────────────────────────────────────

/**
 * A goal at or above this fused similarity to a skill capability page is the
 * "confident same-skill" mark — a caller can treat such a hit as a run of that
 * existing skill. High, since a false positive here conflates two procedures.
 */
export const EXISTING_SKILL_THRESHOLD = 0.82;

/**
 * The shortlist floor. Hits at or above this similarity surface in the
 * shortlist so near-matches (below the confident mark) are still presented for
 * the caller to judge. Lower than {@link EXISTING_SKILL_THRESHOLD} so a
 * borderline skill is not dropped before the caller can weigh it.
 */
export const SHORTLIST_THRESHOLD = 0.6;

/** How many shortlist entries to return when the caller does not specify. */
export const DEFAULT_SHORTLIST_LIMIT = 5;

/** A scored ANN hit: a corpus slug and its fused dense+sparse similarity. */
export interface ScoredSlug {
  slug: string;
  score: number;
}

/** A shortlisted existing skill and its similarity to the goal. */
export interface SkillShortlistHit {
  skillId: string;
  score: number;
}

/**
 * The injectable scoring seam. Given the goal text and a slug restriction,
 * return each restricted slug's fused dense+sparse similarity to the goal.
 * Defaults to {@link simBatch} (the v2 slug-restricted hybrid scorer, including
 * its adaptive dense/sparse reweighting, so shortlist scores stay on the same
 * scale as v2 recall); tests pass a fake so the ranking runs without a live
 * collection.
 */
export type ScoreSlugsFn = (
  goal: string,
  restrictToSlugs: readonly string[],
) => Promise<ScoredSlug[]>;

export interface NearestExistingSkillsOptions {
  /** Config used for embedding + fusion weights. Defaults to `getConfig()`. */
  config?: AssistantConfig;
  /** ANN scorer. Defaults to the {@link simBatch} scorer. */
  scoreSlugs?: ScoreSlugsFn;
  /** Live skill catalog. Defaults to `loadSkillCatalog()`. */
  loadCatalog?: () => { id: string }[];
  /** Max shortlist entries. Defaults to {@link DEFAULT_SHORTLIST_LIMIT}. */
  limit?: number;
}

/**
 * Rank the existing skills whose capability pages are most similar to `goal`
 * and return the top-K at or above {@link SHORTLIST_THRESHOLD}, descending by
 * score. An empty catalog (or no hit clearing the floor) yields `[]`.
 *
 * Pure and read-only: no writes, no LLM call.
 */
export async function nearestExistingSkills(
  goal: string,
  opts: NearestExistingSkillsOptions = {},
): Promise<SkillShortlistHit[]> {
  const config = opts.config ?? getConfig();
  const scoreSlugs =
    opts.scoreSlugs ?? ((g, slugs) => scoreSlugsWithSimBatch(config, g, slugs));
  const loadCatalog = opts.loadCatalog ?? (() => loadSkillCatalog());
  const limit = opts.limit ?? DEFAULT_SHORTLIST_LIMIT;

  // Map each skill id to its capability-page slug, score them, and resolve each
  // hit back to its id.
  const slugToSkillId = new Map<string, string>();
  for (const skill of loadCatalog()) {
    slugToSkillId.set(skillSlugFor(skill.id), skill.id);
  }
  const slugs = [...slugToSkillId.keys()];
  if (slugs.length === 0) return [];

  const scored = await scoreSlugs(goal, slugs);
  const hits: SkillShortlistHit[] = [];
  for (const { slug, score } of scored) {
    if (score < SHORTLIST_THRESHOLD) continue;
    const skillId = slugToSkillId.get(slug);
    if (skillId) hits.push({ skillId, score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

/**
 * Default scorer: delegate to {@link simBatch}, the v2 slug-restricted hybrid
 * scorer. `simBatch` embeds the goal (dense + BM25 sparse), runs the
 * slug-restricted hybrid query, applies the adaptive dense/sparse reweighting,
 * and fuses the body/summary halves — so shortlist scores land on the same
 * scale as v2 recall scores against {@link SHORTLIST_THRESHOLD}.
 *
 * `simBatch` embeds via `embedWithBackend` ONCE (not `embedWithRetry`), so a
 * brief provider blip (429 / 5xx / transient network error) would throw and
 * make this scorer return `[]` — an empty shortlist. To avoid a momentary
 * outage hiding an existing skill, the `simBatch` call is wrapped in a bounded
 * retry mirroring {@link embedWithRetry}'s policy (same max-retries / base-delay
 * / exponential backoff, same transient predicate, same abort handling). Only
 * AFTER retries are exhausted — or on a non-transient error (a real
 * Qdrant/config bug, where retrying is pointless) — do we degrade to `[]`,
 * logged at warn.
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
      "nearest-existing-skills scorer failed after retries; degrading to empty shortlist",
    );
    return [];
  }
}

/**
 * Run {@link simBatch} with the same bounded retry policy as `embedWithRetry`
 * (`simBatch` itself embeds via `embedWithBackend` with no retry). Retries only
 * transient embedding failures (429 / 5xx / retryable network error); a
 * non-transient error or an exhausted retry budget rethrows so the caller can
 * degrade to an empty shortlist. Aborts propagate immediately and are never
 * retried.
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
        "transient nearest-existing-skills embedding failure, retrying",
      );
      await abortableSleep(delay);
    }
  }
  throw lastError;
}
