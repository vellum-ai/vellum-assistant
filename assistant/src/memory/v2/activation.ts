// ---------------------------------------------------------------------------
// Memory v2 — Per-turn activation update
// ---------------------------------------------------------------------------
//
// Implements the activation formula from §4 of the design doc plus an
// additive cross-encoder rerank boost on the unified top-K-by-A_o pool:
//
//   A_o(n, t+1) = d · A(n, t)
//               + c_user      · sim(User_{t+1},  n)
//               + c_assistant · sim(Assistant_t, n)
//               + c_now       · sim(NOW.md,      n)
//               + c_user      · α · r_norm(User_{t+1},  n)   [n ∈ topK]
//               + c_assistant · α · r_norm(Assistant_t, n)   [n ∈ topK]
//
//   A(n, t+1) = [ A_o(n)
//               + k  · Σ_{m∈in1(n)} A_o(m)
//               + k² · Σ_{m∈in2(n)} A_o(m) ]
//             / (1 + k · #in1(n) + k² · #in2(n))
//
// Edges are directed: edge A→B means A's activation contributes to B's. The
// per-target BFS walks *incoming* adjacency, so `in1(n)` is the set of nodes
// with an edge A→n and `in2(n)` adds another hop in the same direction.
//
// Bounded in [0, 1]. Pure sources (no incoming edges within `hops`) reduce to
// A == A_o because both numerator and denominator collapse to `A_o(n)` and
// `1`, respectively.
//
// Candidate selection (§6) keeps the per-turn cost linear in the size of the
// active set rather than the entire concept-page collection. The candidate
// set is the union of:
//   - Slugs whose prior activation exceeds `epsilon` (the persisted state).
//   - The top-50 by ANN hybrid query against `concat(user, assistant, now)` —
//     a single batched call to `hybridQueryConceptPages` with no slug
//     restriction. Pages outside the candidate set decay via `d · A(n, t)`
//     for the next turn and drop below `epsilon` if no longer relevant.

import type { AssistantConfig } from "../../config/types.js";
import { applyCorrectionIfCalibrated } from "../anisotropy.js";
import {
  embedWithBackend,
  generateSparseEmbedding,
} from "../embedding-backend.js";
import { clampUnitInterval } from "../validation.js";
import type { EdgeIndex } from "./edge-index.js";
import { hybridQueryConceptPages } from "./qdrant.js";
import { rerankCandidates } from "./reranker.js";
import { simBatch } from "./sim.js";
import type { ActivationState, EverInjectedEntry } from "./types.js";

/**
 * Sentinel passed to Qdrant when `config.memory.v2.ann_candidate_limit` is
 * `null` (unlimited). Qdrant's query API requires an explicit numeric
 * `limit`, so unlimited is represented as a number large enough that any
 * realistic concept-page collection is returned in full.
 *
 * Why not `Number.MAX_SAFE_INTEGER`: Qdrant's sparse-vector `SearchContext`
 * pre-allocates `limit * 16` bytes per query, so passing `MAX_SAFE_INTEGER`
 * triggers a ~144 PB allocation and SIGABRTs the Qdrant process. 1_000_000
 * is ~16 MB of pre-allocation in Qdrant — generous headroom over realistic
 * concept-page counts (low thousands today) while staying well clear of
 * the OOM cliff. Bump explicitly via `ann_candidate_limit` if you ever
 * outgrow it.
 */
const UNLIMITED_ANN_CANDIDATE_LIMIT = 1_000_000;

// ---------------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------------

interface SelectCandidatesParams {
  /**
   * Prior-turn activation snapshot. Slugs with activation strictly greater
   * than `config.memory.v2.epsilon` are carried forward as candidates so the
   * decay term `d · A(n, t)` continues to influence them next turn.
   */
  priorState: ActivationState | null;
  /** User message text for this turn. */
  userText: string;
  /** Assistant message text from the prior turn (empty string at conv start). */
  assistantText: string;
  /** NOW context string (essentials/threads/recent or NOW.md). */
  nowText: string;
  config: AssistantConfig;
  signal?: AbortSignal;
}

interface SelectCandidatesResult {
  /** Union of `fromPrior` and `fromAnn` — the per-turn candidate set. */
  candidates: Set<string>;
  /** Slugs carried forward from `priorState` because their activation > epsilon. */
  fromPrior: Set<string>;
  /** Slugs surfaced by the unrestricted ANN top-50 against the joined turn text. */
  fromAnn: Set<string>;
}

/**
 * Build the per-turn candidate set: the union of slugs in the prior state
 * (above epsilon) and the top-50 ANN hits against the concatenated turn
 * text. The ANN call runs un-restricted (no slug filter) so it can surface
 * pages outside the active set.
 *
 * Returns the union plus the two source sets separately so downstream
 * telemetry can attribute each candidate to `prior_state`, `ann_top50`, or
 * both. A slug present in both sources appears in `fromPrior ∩ fromAnn`.
 *
 * Empty candidate sets are valid and propagate downstream — both
 * `computeOwnActivation` and `spreadActivation` short-circuit on them.
 */
export async function selectCandidates(
  params: SelectCandidatesParams,
): Promise<SelectCandidatesResult> {
  const { priorState, userText, assistantText, nowText, config, signal } =
    params;

  const fromPrior = new Set<string>();
  const fromAnn = new Set<string>();

  // (1) Carry forward prior-state slugs above epsilon.
  if (priorState) {
    const epsilon = config.memory.v2.epsilon;
    for (const [slug, activation] of Object.entries(priorState.state)) {
      if (activation > epsilon) fromPrior.add(slug);
    }
  }

  // (2) ANN top-50 against the concatenated turn text. Pure whitespace joins
  // (no separators) keep the embedding behavior aligned with how callers
  // would naturally read the three texts together. Whitespace-only channels
  // contribute no semantic content, so trim before deciding whether to embed.
  const annQueryText = [userText, assistantText, nowText]
    .filter((s) => s.trim().length > 0)
    .join("\n");

  if (annQueryText.trim().length > 0) {
    throwIfAborted(signal);
    const denseResult = await embedWithBackend(config, [annQueryText], {
      signal,
    });
    const dense = await applyCorrectionIfCalibrated(
      denseResult.vectors[0],
      denseResult.provider,
      denseResult.model,
    );
    throwIfAborted(signal);
    const sparse = generateSparseEmbedding(annQueryText);
    const limit =
      config.memory.v2.ann_candidate_limit ?? UNLIMITED_ANN_CANDIDATE_LIMIT;
    const hits = await hybridQueryConceptPages(dense, sparse, limit);
    for (const hit of hits) fromAnn.add(hit.slug);
  }

  const candidates = new Set<string>([...fromPrior, ...fromAnn]);

  return { candidates, fromPrior, fromAnn };
}

// ---------------------------------------------------------------------------
// Own activation
// ---------------------------------------------------------------------------

interface ComputeOwnActivationParams {
  candidates: ReadonlySet<string>;
  priorState: ActivationState | null;
  userText: string;
  assistantText: string;
  nowText: string;
  config: AssistantConfig;
  signal?: AbortSignal;
}

/**
 * Per-slug breakdown of the own-activation inputs, captured before any
 * coefficient weighting is applied. Surfaced for telemetry / inspector views
 * so the UI can show how each term contributed to the final value.
 */
interface OwnActivationBreakdown {
  /** `d * prev(slug)` — the decayed prior-turn activation contribution. */
  priorContribution: number;
  /** Raw fused `sim(user, slug)`, before `c_user` weighting. */
  simUser: number;
  /** Raw fused `sim(assistant, slug)`, before `c_assistant` weighting. */
  simAssistant: number;
  /** Raw fused `sim(now, slug)`, before `c_now` weighting. */
  simNow: number;
  /** Rerank delta `α · r_norm_u`; 0 outside the top-K pool. Applied to `A_o` weighted by `c_user`. */
  simUserRerankBoost: number;
  /** Rerank delta `α · r_norm_a`; 0 outside the top-K pool. Applied to `A_o` weighted by `c_assistant`. NOW skips rerank. */
  simAssistantRerankBoost: number;
  /** True when this slug was in the unified top-K rerank pool. Lets the inspector distinguish "cross-encoder normalised to 0" from "rerank skipped this slug." */
  inRerankPool: boolean;
}

interface ComputeOwnActivationResult {
  /** Final clamped own-activation value per slug. */
  activation: Map<string, number>;
  /** Per-slug breakdown of the inputs that fed into `activation`. */
  breakdown: Map<string, OwnActivationBreakdown>;
}

/**
 * Apply the own-activation formula
 *   A_o(n) = d · prev(n)
 *          + c_user · sim_u + c_assistant · sim_a + c_now · sim_n
 *          + c_user · α · r_norm_u + c_assistant · α · r_norm_a
 * over the candidate set, where the rerank terms only fire for slugs that
 * land in the unified top-K-by-pre-rerank-A_o window. Returns a sparse map
 * keyed by slug; slugs whose computed value rounds to 0 are still included
 * so callers can see the candidate set explicitly. Also returns a per-slug
 * breakdown of the raw inputs (decayed prior + raw sims + rerank deltas) so
 * callers can render contribution diagnostics without re-running the math.
 *
 * The three `simBatch` calls run concurrently — they hit independent named
 * vectors and embed independent query texts. Cross-encoder rerank then runs
 * once on the unified top-K (selected by pre-rerank A_o, not per-channel
 * fused sim) so an entry strong in both channels can't double-boost itself
 * past entries that only land in one channel.
 */
export async function computeOwnActivation(
  params: ComputeOwnActivationParams,
): Promise<ComputeOwnActivationResult> {
  const {
    candidates,
    priorState,
    userText,
    assistantText,
    nowText,
    config,
    signal,
  } = params;

  const activation = new Map<string, number>();
  const breakdown = new Map<string, OwnActivationBreakdown>();
  if (candidates.size === 0) return { activation, breakdown };

  const { d, c_user, c_assistant, c_now } = config.memory.v2;
  const slugList = [...candidates];

  // NOW context is structured (timestamps, current focus) — outside the
  // cross-encoder's training distribution, so it never participates in rerank.
  const [simUser, simAssistant, simNow] = await Promise.all([
    simBatch(userText, slugList, config, { signal }),
    simBatch(assistantText, slugList, config, { signal }),
    simBatch(nowText, slugList, config, { signal }),
  ]);

  interface SlugInputs {
    slug: string;
    priorContribution: number;
    simU: number;
    simA: number;
    simN: number;
    /** Pre-rerank A_o; ranking signal for the unified rerank pool. */
    preRerank: number;
  }
  const inputs: SlugInputs[] = slugList.map((slug) => {
    const prev = priorState?.state[slug] ?? 0;
    const simU = simUser.get(slug) ?? 0;
    const simA = simAssistant.get(slug) ?? 0;
    const simN = simNow.get(slug) ?? 0;
    const priorContribution = d * prev;
    return {
      slug,
      priorContribution,
      simU,
      simA,
      simN,
      preRerank:
        priorContribution + c_user * simU + c_assistant * simA + c_now * simN,
    };
  });

  // Unified top-K by pre-rerank A_o. Both channels rerank against the **same**
  // slug set, so a slug strong on user can't crowd out one strong on assistant
  // by virtue of appearing in both per-channel top-Ks. Both channel queries
  // ride in a single `rerankCandidates` call so the worker tokenizes and
  // forward-passes them together — half the per-call overhead of two
  // serialised round-trips.
  let userRerankBoost: ReadonlyMap<string, number> = new Map();
  let assistantRerankBoost: ReadonlyMap<string, number> = new Map();
  let inPoolSet: ReadonlySet<string> = new Set();
  const rerankCfg = config.memory.v2.rerank;
  if (rerankCfg?.enabled) {
    throwIfAborted(signal);
    const topSlugs = inputs
      .slice()
      .sort((a, b) => b.preRerank - a.preRerank)
      .slice(0, rerankCfg.top_k)
      .map((e) => e.slug);
    if (topSlugs.length > 0) {
      inPoolSet = new Set(topSlugs);
      const [userScores, assistantScores] = await rerankCandidates(
        [userText, assistantText],
        topSlugs,
        config,
      );
      throwIfAborted(signal);
      userRerankBoost = normalizeRerankScores(userScores, rerankCfg.alpha);
      assistantRerankBoost = normalizeRerankScores(
        assistantScores,
        rerankCfg.alpha,
      );
    }
  }

  for (const e of inputs) {
    const boostU = userRerankBoost.get(e.slug) ?? 0;
    const boostA = assistantRerankBoost.get(e.slug) ?? 0;
    activation.set(
      e.slug,
      clampUnitInterval(e.preRerank + c_user * boostU + c_assistant * boostA),
    );
    breakdown.set(e.slug, {
      priorContribution: e.priorContribution,
      simUser: e.simU,
      simAssistant: e.simA,
      simNow: e.simN,
      simUserRerankBoost: boostU,
      simAssistantRerankBoost: boostA,
      inRerankPool: inPoolSet.has(e.slug),
    });
  }

  return { activation, breakdown };
}

/**
 * Per-batch normalisation: divide raw cross-encoder scores by the channel's
 * own max and return `alpha · r_norm` per slug. Empty input or all-zero
 * scores yield an empty Map so the channel contributes 0 boost.
 */
function normalizeRerankScores(
  rawScores: ReadonlyMap<string, number>,
  alpha: number,
): Map<string, number> {
  const out = new Map<string, number>();
  if (rawScores.size === 0) return out;
  let maxScore = 0;
  for (const v of rawScores.values()) {
    if (v > maxScore) maxScore = v;
  }
  if (maxScore === 0) return out;
  for (const [slug, raw] of rawScores) {
    out.set(slug, alpha * (raw / maxScore));
  }
  return out;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}

// ---------------------------------------------------------------------------
// Spreading activation
// ---------------------------------------------------------------------------

interface SpreadActivationResult {
  /** Final activation value per slug after spreading. */
  final: Map<string, number>;
  /**
   * Per-slug spread delta: `final[slug] - own[slug]`. Captures how much
   * the spread step nudged each node above (or below) its own activation —
   * useful for inspector views that want to show graph contributions
   * separate from raw sim contributions. Always 0 when `hops == 0` or
   * `k == 0` because both short-circuit to `final == own`.
   */
  contribution: Map<string, number>;
}

/**
 * Apply 2-hop spreading activation with neighborhood normalization. Edges are
 * directed: an edge A→B means A's activation contributes to B's final value.
 *
 *   A(n) = [ A_o(n) + Σ_{r: |active_inR(n)| > 0} k^r · L2(active_inR(n)) ]
 *        / [ 1     + Σ_{r: |active_inR(n)| > 0} k^r ]
 *
 * `active_inR(n)` is the subset of structural predecessors at hop `r` that
 * also appear in `ownActivation` (i.e. made the candidate set). `L2(.)` is
 * the quadratic mean √(mean(A_o²)) — a mild bias toward strong outliers
 * compared to the arithmetic mean, without letting a single high-cosine
 * predecessor dominate the way `max` would.
 *
 * Hops with **no** active predecessors are dropped from BOTH numerator and
 * denominator so a high-in-degree hub with mostly-inactive neighbors stays
 * near `A_o` instead of being crushed by the structural count. A pure
 * source (no incoming edges, or every edge points at a non-candidate)
 * collapses to `A == A_o`.
 *
 * Bounded in [0, 1]: every `L2` term ≤ max active A_o ≤ 1, so the numerator
 * is at most `1 + Σ k^r` — exactly the denominator — so the ratio is at most
 * 1. `clampUnitInterval` guards against numerical drift and out-of-range
 * inputs.
 *
 * Pure function — no I/O. Reads the precomputed `incoming` map from
 * `edgeIndex` and runs a per-source BFS bounded by `hops`.
 */
export function spreadActivation(
  ownActivation: ReadonlyMap<string, number>,
  edgeIndex: EdgeIndex,
  k: number,
  hops: number,
): SpreadActivationResult {
  const final = new Map<string, number>();
  const contribution = new Map<string, number>();
  if (ownActivation.size === 0) return { final, contribution };

  // Short-circuit: with no spread the formula collapses to A == A_o.
  if (hops <= 0 || k <= 0) {
    for (const [slug, ownValue] of ownActivation) {
      final.set(slug, clampUnitInterval(ownValue));
      contribution.set(slug, 0);
    }
    return { final, contribution };
  }

  for (const [slug, ownValue] of ownActivation) {
    // Single bounded BFS from `slug` over incoming edges. `distance` maps
    // predecessor → hop count (1..hops). Source is excluded so it contributes
    // hop-0 only via `numerator = ownValue`.
    const distance = bfsPredecessorDistances(edgeIndex.incoming, slug, hops);

    // Bucket only predecessors that are in `ownActivation` (the candidate
    // set). Structural predecessors that didn't make the cut contribute
    // nothing — neither to the numerator nor the denominator — so hub
    // in-degree alone never penalizes a node.
    const ringActiveCounts: number[] = new Array(hops + 1).fill(0);
    const ringSquareSums: number[] = new Array(hops + 1).fill(0);
    for (const [predecessor, hop] of distance) {
      const predValue = ownActivation.get(predecessor);
      if (predValue === undefined) continue;
      ringActiveCounts[hop] += 1;
      ringSquareSums[hop] += predValue * predValue;
    }

    let numerator = ownValue;
    let denominator = 1;
    let kPow = 1;
    for (let r = 1; r <= hops; r++) {
      kPow *= k;
      if (ringActiveCounts[r] === 0) continue;
      const rms = Math.sqrt(ringSquareSums[r] / ringActiveCounts[r]);
      numerator += kPow * rms;
      denominator += kPow;
    }

    const finalValue = clampUnitInterval(numerator / denominator);
    final.set(slug, finalValue);
    contribution.set(slug, finalValue - ownValue);
  }

  return { final, contribution };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Bounded BFS over the *incoming* adjacency map. Returns each reachable
 * predecessor's hop-distance in [1, maxHops] from `target` — i.e. nodes from
 * which a directed path of that length leads into `target`. The target itself
 * is excluded.
 */
function bfsPredecessorDistances(
  incoming: ReadonlyMap<string, ReadonlySet<string>>,
  target: string,
  maxHops: number,
): Map<string, number> {
  const distance = new Map<string, number>();
  let frontier: string[] = [target];
  const visited = new Set<string>([target]);
  for (let hop = 1; hop <= maxHops && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const node of frontier) {
      const predecessors = incoming.get(node);
      if (!predecessors) continue;
      for (const predecessor of predecessors) {
        if (visited.has(predecessor)) continue;
        visited.add(predecessor);
        distance.set(predecessor, hop);
        next.push(predecessor);
      }
    }
    frontier = next;
  }
  return distance;
}

// ---------------------------------------------------------------------------
// Injection selection
// ---------------------------------------------------------------------------

interface SelectInjectionsParams {
  /** Final activation map after spread. */
  A: ReadonlyMap<string, number>;
  /** Slugs already attached to a prior user message (with their turn). */
  priorEverInjected: readonly EverInjectedEntry[];
  /** Cap on the per-turn injection slate, e.g. `config.memory.v2.top_k`. */
  topK: number;
}

interface SelectInjectionsResult {
  /** Top-K slugs by activation (descending), used for the cached top-now view. */
  topNow: string[];
  /**
   * Slugs in `topNow` that have not yet been attached to any prior user
   * message — the new injections to render on the current user message.
   */
  toInject: string[];
}

/**
 * Pick the top-K slugs by activation (descending; stable on ties via slug
 * lexicographic order) and subtract slugs already in `priorEverInjected` to
 * yield the per-turn injection delta. Empty activation map → empty results.
 */
export function selectInjections(
  params: SelectInjectionsParams,
): SelectInjectionsResult {
  const { A, priorEverInjected, topK } = params;
  if (A.size === 0 || topK <= 0) {
    return { topNow: [], toInject: [] };
  }

  const ranked = [...A.entries()].sort(([slugA, valA], [slugB, valB]) => {
    if (valB !== valA) return valB - valA; // higher activation first
    return slugA < slugB ? -1 : slugA > slugB ? 1 : 0; // stable tie-break
  });

  const topNow = ranked.slice(0, topK).map(([slug]) => slug);
  const everSet = new Set(priorEverInjected.map((entry) => entry.slug));
  const toInject = topNow.filter((slug) => !everSet.has(slug));

  return { topNow, toInject };
}
