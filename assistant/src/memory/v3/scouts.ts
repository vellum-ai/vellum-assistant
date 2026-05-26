// ---------------------------------------------------------------------------
// Memory v3 — Always-on scout lanes (hot / sparse / dense)
// ---------------------------------------------------------------------------
//
// The v3 retrieval loop opens each pass by fanning out a small set of cheap,
// always-on "scout" lanes over the v2 read-substrate. Scouts surface candidate
// concept-page slugs from three complementary signals before any LLM judging
// (the dense judge lives in a later PR) or tree descent runs:
//
//   - hot:    corpus-global access-frequency EMA via `computeInjectionScores`.
//             Retriever-agnostic — v2 keeps writing `memory_v2_injection_events`,
//             so a page the user has been touching is "hot" regardless of which
//             retriever surfaced it. Hits are marked **sticky** so the downstream
//             gate keeps them in the running.
//   - sparse: BM25 keyword match. Near-exact (high-score) hits are both
//             **sticky** and **tree-bypass** — a literal keyword hit is a strong
//             enough signal that we shouldn't make the slug earn its place by
//             walking the tree.
//   - dense:  embedding-similarity match, then an asymmetric per-subtree quota
//             (generous active-domain slice, thin off-domain slice) plus MMR for
//             diversity so a single dominant subtree can't crowd out the slate.
//
// Each lane is individually toggleable via `config.memory.v3.lanes`. This module
// performs **no** LLM calls and writes nothing — it is a pure read over the v2
// substrate. A later PR composes `runScouts` into the full descent loop.

import type { AssistantConfig } from "../../config/types.js";
import { applyCorrectionIfCalibrated } from "../anisotropy.js";
import type { DrizzleDb } from "../db-connection.js";
import { embedWithBackend } from "../embedding-backend.js";
import type { RetrievalInput } from "../v2/harness/retriever.js";
import type { ScoutResult } from "../v2/harness/trace.js";
import { computeInjectionScores } from "../v2/injection-events.js";
import { getPageIndex } from "../v2/page-index.js";
import { hybridQueryConceptPages } from "../v2/qdrant.js";
import { generateBm25QueryEmbedding } from "../v2/sparse-bm25.js";

/** Result of running the always-on scout fanout for one pass. */
export interface RunScoutsResult {
  /** Per-lane contributions, one entry per *enabled* lane that produced hits. */
  scouts: ScoutResult[];
  /**
   * Slugs the downstream gate should keep in the running regardless of later
   * scoring — hot hits and near-exact sparse hits.
   */
  sticky: Set<string>;
  /**
   * Slugs strong enough (near-exact sparse) to skip the tree-descent gate
   * entirely. A subset of `sticky`.
   */
  bypass: Set<string>;
}

/** Substrate dependencies injected for testability. */
export interface ScoutDeps {
  db: DrizzleDb;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Per-lane hit cap before quota/diversity post-processing. The lanes are
 * always-on and run every pass, so a generous-but-bounded cap keeps the dense
 * Qdrant round-trip and the per-lane bookkeeping cheap while still giving the
 * quota/MMR step enough raw candidates to choose from.
 */
const LANE_QUERY_LIMIT = 100;

/**
 * Sparse score at or above which a hit is treated as **near-exact** — sticky
 * and tree-bypass. BM25 scores are unbounded above and corpus-relative, so the
 * threshold is taken relative to the top sparse hit in the same pass rather
 * than as a fixed magnitude: a hit within this fraction of the best sparse
 * score for the query is "near-exact". A lone strong hit (it is its own max)
 * always qualifies.
 */
const SPARSE_NEAR_EXACT_FRACTION = 0.9;

/**
 * MMR trade-off: `λ · relevance − (1 − λ) · redundancy`. Closer to 1 favors
 * raw dense relevance; lower values push harder for subtree diversity. 0.7
 * keeps relevance in the driver's seat while still breaking up runs of
 * same-subtree hits.
 */
const DENSE_MMR_LAMBDA = 0.7;

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run the always-on scout lanes for one retrieval pass.
 *
 * `queryText` is derived from the last user turn in `input.recentTurnPairs`
 * joined with `input.nowText` — the same shape the v2 router/activation path
 * embeds. Disabled lanes (per `config.memory.v3.lanes`) are skipped entirely:
 * no substrate call, no `ScoutResult` entry.
 *
 * Honors `input.signal` — aborts between lanes and around the dense embed.
 */
export async function runScouts(
  input: RetrievalInput,
  deps: ScoutDeps,
): Promise<RunScoutsResult> {
  const { config, signal } = input;
  const lanes = config.memory.v3.lanes;
  const queryText = deriveQueryText(input);

  const scouts: ScoutResult[] = [];
  const sticky = new Set<string>();
  const bypass = new Set<string>();

  // Hot lane — corpus-global EMA over the full slug universe. Cheap (single
  // SQL pass) so it runs first and seeds sticky.
  if (lanes.hot) {
    signal?.throwIfAborted();
    const hot = await runHotLane(input, deps);
    if (hot) {
      scouts.push(hot);
      for (const slug of hot.slugs) sticky.add(slug);
    }
  }

  // Sparse lane — BM25 keyword match. Near-exact hits seed sticky + bypass.
  if (lanes.sparse && queryText.length > 0) {
    signal?.throwIfAborted();
    const sparse = await runSparseLane(queryText, signal);
    if (sparse) {
      scouts.push(sparse.result);
      for (const slug of sparse.nearExact) {
        sticky.add(slug);
        bypass.add(slug);
      }
    }
  }

  // Dense lane — embedding similarity, then per-subtree quota + MMR.
  if (lanes.dense && queryText.length > 0) {
    signal?.throwIfAborted();
    const dense = await runDenseLane(queryText, config, signal);
    if (dense) scouts.push(dense);
  }

  return { scouts, sticky, bypass };
}

// ---------------------------------------------------------------------------
// Query-text derivation
// ---------------------------------------------------------------------------

/**
 * Build the scout query text from the just-arrived user turn plus the NOW
 * context. Mirrors the v2 activation path (`selectCandidates`): join the
 * non-empty channels with a newline. The last `recentTurnPairs` entry's
 * `userMessage` is the turn being routed.
 */
function deriveQueryText(input: RetrievalInput): string {
  const lastPair = input.recentTurnPairs[input.recentTurnPairs.length - 1];
  const userText = lastPair?.userMessage ?? "";
  return [userText, input.nowText]
    .filter((s) => s.trim().length > 0)
    .join("\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Hot lane
// ---------------------------------------------------------------------------

async function runHotLane(
  input: RetrievalInput,
  deps: ScoutDeps,
): Promise<ScoutResult | null> {
  const index = await getPageIndex(input.workspaceDir);
  const allSlugs = index.entries.map((e) => e.slug);
  if (allSlugs.length === 0) return null;

  const now = Date.now();
  const scores = computeInjectionScores(deps.db, allSlugs, now);
  if (scores.size === 0) return null;

  // Slugs with no events in the read window are omitted by
  // `computeInjectionScores`, so every entry here has score > 0. Cap to the
  // top `hotLimit` by EMA: hot hits are sticky (forced past the gate), so an
  // uncapped lane on a mature corpus — where nearly every page has been
  // injected at some point — would force the entire corpus into the selection.
  const ranked = [...scores.entries()]
    .sort((a, b) => sortByScoreDesc(a, b))
    .slice(0, input.config.memory.v3.hotLimit);
  const slugs = ranked.map(([slug]) => slug);
  const scoreBySlug = Object.fromEntries(ranked);
  return { lane: "hot", slugs, scoreBySlug };
}

// ---------------------------------------------------------------------------
// Sparse lane
// ---------------------------------------------------------------------------

async function runSparseLane(
  queryText: string,
  signal: AbortSignal | undefined,
): Promise<{ result: ScoutResult; nearExact: string[] } | null> {
  const sparse = generateBm25QueryEmbedding(queryText);
  if (sparse.indices.length === 0) return null;

  // Dense channel intentionally empty — this lane is BM25-only. `skipSparse:
  // false` keeps the sparse round-trip on; we read `sparseScore` and ignore
  // any dense scores the query happens to surface.
  const hits = await hybridQueryConceptPages(
    [],
    sparse,
    LANE_QUERY_LIMIT,
    undefined,
    {
      skipSparse: false,
    },
  );
  signal?.throwIfAborted();

  const scored = hits
    .map((hit) => ({ slug: hit.slug, score: hit.sparseScore }))
    .filter((h): h is { slug: string; score: number } => h.score !== undefined)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return null;

  const slugs = scored.map((h) => h.slug);
  const scoreBySlug = Object.fromEntries(scored.map((h) => [h.slug, h.score]));

  // Near-exact: within SPARSE_NEAR_EXACT_FRACTION of the top sparse score.
  const topScore = scored[0].score;
  const threshold = topScore * SPARSE_NEAR_EXACT_FRACTION;
  const nearExact = scored
    .filter((h) => topScore > 0 && h.score >= threshold)
    .map((h) => h.slug);

  return { result: { lane: "sparse", slugs, scoreBySlug }, nearExact };
}

// ---------------------------------------------------------------------------
// Dense lane
// ---------------------------------------------------------------------------

async function runDenseLane(
  queryText: string,
  config: AssistantConfig,
  signal: AbortSignal | undefined,
): Promise<ScoutResult | null> {
  // Embed + apply anisotropy correction, mirroring v2 activation's read path.
  const embedded = await embedWithBackend(config, [queryText], { signal });
  const dense = await applyCorrectionIfCalibrated(
    embedded.vectors[0],
    embedded.provider,
    embedded.model,
  );
  signal?.throwIfAborted();

  const sparse = generateBm25QueryEmbedding(queryText);
  const hits = await hybridQueryConceptPages(dense, sparse, LANE_QUERY_LIMIT);
  signal?.throwIfAborted();

  const scored = hits
    .map((hit) => ({ slug: hit.slug, score: hit.denseScore }))
    .filter((h): h is { slug: string; score: number } => h.score !== undefined)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return null;

  const selected = applyQuotaAndMmr(scored, config.memory.v3);
  if (selected.length === 0) return null;

  const slugs = selected.map((h) => h.slug);
  const scoreBySlug = Object.fromEntries(
    selected.map((h) => [h.slug, h.score]),
  );
  return { lane: "dense", slugs, scoreBySlug };
}

interface ScoredSlug {
  slug: string;
  score: number;
}

/**
 * Apply the asymmetric per-subtree quota then MMR re-ranking to the dense hits.
 *
 * Quota: the conversation's **active domain** is the top-path segment of the
 * single highest-scoring dense hit. That domain gets a generous slice
 * (`denseQuota.activeDomain`); every other (off-)domain shares a thin slice
 * (`denseQuota.offDomain`) so exploratory hits aren't fully starved but can't
 * dominate either. Quotas are per-domain caps applied in score-descending
 * order.
 *
 * MMR: re-rank the quota-passing pool by `λ · relevance − (1 − λ) · redundancy`
 * where redundancy is how represented the candidate's subtree already is in the
 * selected slate. Without per-page embeddings we use subtree co-membership as
 * the diversity signal — same subtree ⇒ maximally redundant. This breaks up
 * runs of same-subtree hits without an extra Qdrant round-trip.
 */
function applyQuotaAndMmr(
  scored: readonly ScoredSlug[],
  v3: AssistantConfig["memory"]["v3"],
): ScoredSlug[] {
  if (scored.length === 0) return [];

  const activeDomain = domainOf(scored[0].slug);
  const { activeDomain: activeQuota, offDomain: offQuota } = v3.denseQuota;

  // Per-subtree quota: active domain gets activeQuota slots; all off-domain
  // hits compete for a shared offQuota pool. Walk in score-desc order so the
  // strongest hits claim each quota first.
  const perDomainCount = new Map<string, number>();
  let offDomainCount = 0;
  const quotaPassing: ScoredSlug[] = [];
  for (const hit of scored) {
    const domain = domainOf(hit.slug);
    if (domain === activeDomain) {
      const used = perDomainCount.get(domain) ?? 0;
      if (used >= activeQuota) continue;
      perDomainCount.set(domain, used + 1);
    } else {
      if (offDomainCount >= offQuota) continue;
      offDomainCount += 1;
    }
    quotaPassing.push(hit);
  }

  return mmrReorder(quotaPassing, DENSE_MMR_LAMBDA);
}

/**
 * Greedy MMR over a score-ranked pool using subtree co-membership as the
 * redundancy signal. Each pick maximizes
 * `λ · normalizedScore − (1 − λ) · subtreeShareInSelected`, so once a subtree
 * is well-represented its remaining members are deprioritized in favor of
 * fresh subtrees of comparable relevance. Pure / deterministic.
 */
function mmrReorder(pool: readonly ScoredSlug[], lambda: number): ScoredSlug[] {
  if (pool.length <= 1) return [...pool];

  // Normalize relevance to [0, 1] by the pool max so it shares a scale with the
  // redundancy term (also [0, 1]). All-zero scores collapse to pure diversity.
  const maxScore = pool[0].score;
  const relevance = (hit: ScoredSlug): number =>
    maxScore > 0 ? hit.score / maxScore : 0;

  const remaining = [...pool];
  const selected: ScoredSlug[] = [];
  const selectedDomainCount = new Map<string, number>();

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestMmr = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const hit = remaining[i];
      const domain = domainOf(hit.slug);
      const share =
        selected.length === 0
          ? 0
          : (selectedDomainCount.get(domain) ?? 0) / selected.length;
      const mmr = lambda * relevance(hit) - (1 - lambda) * share;
      if (mmr > bestMmr) {
        bestMmr = mmr;
        bestIdx = i;
      }
    }
    const [pick] = remaining.splice(bestIdx, 1);
    selected.push(pick);
    const domain = domainOf(pick.slug);
    selectedDomainCount.set(domain, (selectedDomainCount.get(domain) ?? 0) + 1);
  }

  return selected;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The "domain" (subtree) of a page slug — its top path segment. Slugs are
 * path-relative with `/` separators (e.g. `people/alice` → `people`); a flat
 * slug (`essentials`) is its own domain.
 */
function domainOf(slug: string): string {
  const slash = slug.indexOf("/");
  return slash === -1 ? slug : slug.slice(0, slash);
}

/** Score-desc with a stable slug-ASCII tiebreak. */
function sortByScoreDesc(
  a: readonly [string, number],
  b: readonly [string, number],
): number {
  if (b[1] !== a[1]) return b[1] - a[1];
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}
