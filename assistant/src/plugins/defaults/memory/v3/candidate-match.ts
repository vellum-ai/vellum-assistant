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

import { listInstalledSkills } from "@vellumai/plugin-api";

import { getConfig } from "../../../../config/loader.js";
import type { AssistantConfig } from "../../../../config/types.js";
import {
  EMBED_BASE_DELAY_MS,
  EMBED_MAX_RETRIES,
  isAbortError,
  isTransientEmbeddingError,
} from "../../../../persistence/embeddings/embed.js";
import { abortableSleep, computeRetryDelay } from "../host-utils.js";
import { getLogger } from "../logging.js";
import { simBatch } from "../substrate/sim.js";
import { skillSlugFor } from "../substrate/skill-store.js";

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
  /** Live skill catalog. Defaults to `listInstalledSkills()`. */
  loadCatalog?: () => { id: string }[] | Promise<{ id: string }[]>;
  /** Max shortlist entries. Defaults to {@link DEFAULT_SHORTLIST_LIMIT}. */
  limit?: number;
}

/**
 * A shortlist paired with the matcher's health. `degraded: true` means the
 * scorer failed (after its bounded retries, or non-transiently) and the empty
 * hit list is NOT evidence of novelty; callers that gate writes on the
 * shortlist must fail closed on it.
 */
export interface SkillShortlistResult {
  hits: SkillShortlistHit[];
  degraded: boolean;
}

/**
 * Rank the existing skills whose capability pages are most similar to `goal`
 * and return the top-K at or above {@link SHORTLIST_THRESHOLD}, descending by
 * score. An empty catalog (or no hit clearing the floor) yields `[]`.
 *
 * Pure and read-only: no writes, no LLM call. Scorer failure degrades to an
 * empty shortlist (logged at warn); callers that must distinguish "no similar
 * skill" from "matcher unavailable" use
 * {@link nearestExistingSkillsDetailed} instead.
 */
export async function nearestExistingSkills(
  goal: string,
  opts: NearestExistingSkillsOptions = {},
): Promise<SkillShortlistHit[]> {
  const { hits } = await nearestExistingSkillsDetailed(goal, opts);
  return hits;
}

/**
 * {@link nearestExistingSkills} with the matcher's health made explicit. A
 * scorer failure (injected seam throwing, or the default simBatch path
 * exhausting its retries) yields `{ hits: [], degraded: true }` instead of a
 * silently successful empty shortlist, so write-gating callers can fail
 * closed rather than mistake an outage for novelty.
 */
export async function nearestExistingSkillsDetailed(
  goal: string,
  opts: NearestExistingSkillsOptions = {},
): Promise<SkillShortlistResult> {
  const config = opts.config ?? getConfig();
  const scoreSlugs =
    opts.scoreSlugs ?? ((g, slugs) => scoreSlugsWithSimBatch(config, g, slugs));
  const loadCatalog = opts.loadCatalog ?? (() => listInstalledSkills());
  const limit = opts.limit ?? DEFAULT_SHORTLIST_LIMIT;

  // Map each skill id to its capability-page slug, score them, and resolve each
  // hit back to its id.
  const slugToSkillId = new Map<string, string>();
  for (const skill of await loadCatalog()) {
    slugToSkillId.set(skillSlugFor(skill.id), skill.id);
  }
  const slugs = [...slugToSkillId.keys()];
  if (slugs.length === 0) {
    return { hits: [], degraded: false };
  }

  let scored: ScoredSlug[];
  try {
    scored = await scoreSlugs(goal, slugs);
  } catch (err) {
    log.warn(
      { err },
      "nearest-existing-skills scorer failed; degrading to empty shortlist",
    );
    return { hits: [], degraded: true };
  }
  const hits: SkillShortlistHit[] = [];
  for (const { slug, score } of scored) {
    if (score < SHORTLIST_THRESHOLD) {
      continue;
    }
    const skillId = slugToSkillId.get(slug);
    if (skillId) {
      hits.push({ skillId, score });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return { hits: hits.slice(0, limit), degraded: false };
}

/**
 * Default scorer: delegate to {@link simBatch}, the v2 slug-restricted hybrid
 * scorer. `simBatch` embeds the goal (dense + BM25 sparse), runs the
 * slug-restricted hybrid query, applies the adaptive dense/sparse reweighting,
 * and fuses the body/summary halves — so shortlist scores land on the same
 * scale as v2 recall scores against {@link SHORTLIST_THRESHOLD}.
 *
 * `simBatch` embeds via `embedWithBackend` ONCE (not `embedWithRetry`), so a
 * brief provider blip (429 / 5xx / transient network error) would throw on
 * the first attempt. To avoid a momentary outage hiding an existing skill,
 * the `simBatch` call is wrapped in a bounded retry mirroring
 * {@link embedWithRetry}'s policy (same max-retries / base-delay /
 * exponential backoff, same transient predicate, same abort handling). An
 * exhausted retry budget, or a non-transient error (a real Qdrant/config bug,
 * where retrying is pointless), THROWS to the shortlist wrapper, which
 * reports it as a degraded (not silently empty) shortlist.
 */
async function scoreSlugsWithSimBatch(
  config: AssistantConfig,
  goal: string,
  restrictToSlugs: readonly string[],
): Promise<ScoredSlug[]> {
  const scores = await simBatchWithRetry(config, goal, restrictToSlugs);
  return [...scores].map(([slug, score]) => ({ slug, score }));
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
      if (isAbortError(err)) {
        throw err;
      }
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
