// ---------------------------------------------------------------------------
// Memory v2 — Per-turn activation update
// ---------------------------------------------------------------------------
//
// Implements the activation formula from §4 of the design doc:
//
//   A_o(n, t+1) = d · A(n, t)
//               + c_user      · sim(User_{t+1},  n)
//               + c_assistant · sim(Assistant_t, n)
//               + c_now       · sim(NOW.md,      n)
//
//   A(n, t+1) = [ A_o(n)
//               + k  · Σ_{m∈1hop} A_o(m)
//               + k² · Σ_{m∈2hop} A_o(m) ]
//             / (1 + k · #1hop(n) + k² · #2hop(n))
//
// Bounded in [0, 1]. Orphan nodes (no neighbors within `hops`) reduce to
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
import {
  embedWithBackend,
  generateSparseEmbedding,
} from "../embedding-backend.js";
import { clampUnitInterval } from "../validation.js";
import { hybridQueryConceptPages } from "./qdrant.js";
import { simBatch, simSkillBatch } from "./sim.js";
import { hybridQuerySkills } from "./skill-qdrant.js";
import type {
  ActivationState,
  EdgesIndex,
  EverInjectedEntry,
} from "./types.js";

/**
 * Top-K size for the un-restricted ANN candidate query against the v2
 * concept-page collection. The design doc fixes this at 50 — small enough to
 * keep the per-turn round-trip cheap, large enough to surface relevant pages
 * outside the prior active set.
 */
const ANN_CANDIDATE_LIMIT = 50;

// ---------------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------------

export interface SelectCandidatesParams {
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
}

/**
 * Build the per-turn candidate set: the union of slugs in the prior state
 * (above epsilon) and the top-50 ANN hits against the concatenated turn
 * text. The ANN call runs un-restricted (no slug filter) so it can surface
 * pages outside the active set.
 *
 * Empty candidate sets are valid and propagate downstream — both
 * `computeOwnActivation` and `spreadActivation` short-circuit on them.
 */
export async function selectCandidates(
  params: SelectCandidatesParams,
): Promise<Set<string>> {
  const { priorState, userText, assistantText, nowText, config } = params;

  const candidates = new Set<string>();

  // (1) Carry forward prior-state slugs above epsilon.
  if (priorState) {
    const epsilon = config.memory.v2.epsilon;
    for (const [slug, activation] of Object.entries(priorState.state)) {
      if (activation > epsilon) candidates.add(slug);
    }
  }

  // (2) ANN top-50 against the concatenated turn text. Pure whitespace joins
  // (no separators) keep the embedding behavior aligned with how callers
  // would naturally read the three texts together.
  const annQueryText = [userText, assistantText, nowText]
    .filter((s) => s.length > 0)
    .join("\n");

  if (annQueryText.length > 0) {
    const denseResult = await embedWithBackend(config, [annQueryText]);
    const dense = denseResult.vectors[0];
    const sparse = generateSparseEmbedding(annQueryText);
    const hits = await hybridQueryConceptPages(
      dense,
      sparse,
      ANN_CANDIDATE_LIMIT,
    );
    for (const hit of hits) candidates.add(hit.slug);
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Own activation
// ---------------------------------------------------------------------------

export interface ComputeOwnActivationParams {
  candidates: ReadonlySet<string>;
  priorState: ActivationState | null;
  userText: string;
  assistantText: string;
  nowText: string;
  config: AssistantConfig;
}

/**
 * Apply the own-activation formula
 *   A_o(n) = d · prev(n) + c_user · sim_u + c_assistant · sim_a + c_now · sim_n
 * over the candidate set. Returns a sparse map keyed by slug; slugs whose
 * computed value rounds to 0 are still included so callers can see the
 * candidate set explicitly.
 *
 * The three `simBatch` calls run concurrently — they hit independent named
 * vectors and embed independent query texts.
 */
export async function computeOwnActivation(
  params: ComputeOwnActivationParams,
): Promise<Map<string, number>> {
  const { candidates, priorState, userText, assistantText, nowText, config } =
    params;

  const result = new Map<string, number>();
  if (candidates.size === 0) return result;

  const { d, c_user, c_assistant, c_now } = config.memory.v2;
  const slugList = [...candidates];

  const [simUser, simAssistant, simNow] = await Promise.all([
    simBatch(userText, slugList, config),
    simBatch(assistantText, slugList, config),
    simBatch(nowText, slugList, config),
  ]);

  for (const slug of slugList) {
    const prev = priorState?.state[slug] ?? 0;
    const value =
      d * prev +
      c_user * (simUser.get(slug) ?? 0) +
      c_assistant * (simAssistant.get(slug) ?? 0) +
      c_now * (simNow.get(slug) ?? 0);
    result.set(slug, clampUnitInterval(value));
  }

  return result;
}

// ---------------------------------------------------------------------------
// Spreading activation
// ---------------------------------------------------------------------------

/**
 * Apply 2-hop spreading activation with neighborhood normalization:
 *
 *   A(n) = [ A_o(n) + k · Σ_{m∈1hop} A_o(m) + k² · Σ_{m∈2hop} A_o(m) ]
 *        / (1 + k · #1hop(n) + k² · #2hop(n))
 *
 * The denominator counts *structural* neighbors at each hop (whether or not
 * they appear in `ownActivation`) so an orphan node's denominator collapses
 * to 1 and `A == A_o`. Missing neighbors contribute 0 to the numerator.
 *
 * Bounded in [0, 1]: with `A_o ∈ [0, 1]` and `k ∈ [0, 1]`, the numerator is
 * at most `1 + k · #1hop + k² · #2hop` — exactly the denominator — so the
 * ratio is at most 1. `clampUnitInterval` guards against numerical drift
 * and out-of-range inputs.
 *
 * Pure function — no I/O. Builds an adjacency map once from `edgesIdx` and
 * runs a per-source BFS bounded by `hops`.
 */
export function spreadActivation(
  ownActivation: ReadonlyMap<string, number>,
  edgesIdx: EdgesIndex,
  k: number,
  hops: number,
): Map<string, number> {
  const result = new Map<string, number>();
  if (ownActivation.size === 0) return result;

  // Short-circuit: with no spread the formula collapses to A == A_o.
  if (hops <= 0 || k <= 0) {
    for (const [slug, ownValue] of ownActivation) {
      result.set(slug, clampUnitInterval(ownValue));
    }
    return result;
  }

  const adjacency = buildAdjacency(edgesIdx);

  for (const [slug, ownValue] of ownActivation) {
    // Single bounded BFS from `slug`. `distance` maps neighbor → hop count
    // (1..hops). Source is excluded so it contributes hop-0 only via
    // `numerator = ownValue`.
    const distance = bfsDistances(adjacency, slug, hops);

    let numerator = ownValue;
    let denominator = 1;
    let kPow = 1;
    // Accumulate per-hop contributions in a single pass. We need per-hop
    // counts to weight by k^r, so bucket as we go.
    const ringCounts: number[] = new Array(hops + 1).fill(0);
    const ringSums: number[] = new Array(hops + 1).fill(0);
    for (const [neighbor, hop] of distance) {
      ringCounts[hop] += 1;
      ringSums[hop] += ownActivation.get(neighbor) ?? 0;
    }
    for (let r = 1; r <= hops; r++) {
      kPow *= k;
      if (ringCounts[r] === 0) continue;
      numerator += kPow * ringSums[r];
      denominator += kPow * ringCounts[r];
    }

    result.set(slug, clampUnitInterval(numerator / denominator));
  }

  return result;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a slug → neighbors map from a canonicalized undirected edges index.
 * Mirrors `edges.ts#buildAdjacency` but is local so `spreadActivation` can
 * stay independent of `edges.ts`'s currently-private helper.
 */
function buildAdjacency(idx: EdgesIndex): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  const ensure = (slug: string): Set<string> => {
    let set = adjacency.get(slug);
    if (!set) {
      set = new Set<string>();
      adjacency.set(slug, set);
    }
    return set;
  };
  for (const [a, b] of idx.edges) {
    if (a === b) continue;
    ensure(a).add(b);
    ensure(b).add(a);
  }
  return adjacency;
}

/**
 * Bounded BFS that returns each reachable slug's hop-distance in [1, maxHops]
 * from `source`. The source itself is excluded.
 */
function bfsDistances(
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
  source: string,
  maxHops: number,
): Map<string, number> {
  const distance = new Map<string, number>();
  let frontier: string[] = [source];
  const visited = new Set<string>([source]);
  for (let hop = 1; hop <= maxHops && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const node of frontier) {
      const neighbors = adjacency.get(node);
      if (!neighbors) continue;
      for (const neighbor of neighbors) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        distance.set(neighbor, hop);
        next.push(neighbor);
      }
    }
    frontier = next;
  }
  return distance;
}

// ---------------------------------------------------------------------------
// Injection selection
// ---------------------------------------------------------------------------

export interface SelectInjectionsParams {
  /** Final activation map after spread. */
  A: ReadonlyMap<string, number>;
  /** Slugs already attached to a prior user message (with their turn). */
  priorEverInjected: readonly EverInjectedEntry[];
  /** Cap on the per-turn injection slate, e.g. `config.memory.v2.top_k`. */
  topK: number;
}

export interface SelectInjectionsResult {
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

// ---------------------------------------------------------------------------
// Skill autoinjection — candidate / activation / injection selection
// ---------------------------------------------------------------------------
//
// Skills are stateless: there is no decay carry-over (`d · prev`), no
// spreading activation, and no `everInjected` dedup. The agent re-presents
// the top-K active skills every turn so it can drop or pick them up freely.
// The pipeline therefore reduces to:
//   1. ANN candidate selection against the dedicated skills collection.
//   2. Pure similarity-only activation: A_skill = c_user·sim_u +
//      c_assistant·sim_a + c_now·sim_n, clamped to [0, 1].
//   3. Top-K by activation, lexicographic tie-break, no injection delta.
//
// The activation coefficients are reused from `config.memory.v2.{c_user,
// c_assistant, c_now}` — the design doc (§9) deliberately shares them with
// concept-page activation rather than introducing parallel knobs.

export interface SelectSkillCandidatesParams {
  userText: string;
  assistantText: string;
  nowText: string;
  config: AssistantConfig;
  /** Top-K size for the ANN query against `memory_v2_skills`. */
  topK: number;
}

/**
 * ANN top-K against the skills collection using the concatenated turn text.
 * Runs a single embedding pass over `concat(user, assistant, now)` and a
 * single hybrid Qdrant query — there is no prior-state carry-forward (skills
 * are stateless).
 *
 * Returns a `Set<string>` of skill ids that hit either channel. Empty when
 * the joined text is empty or `topK <= 0`.
 */
export async function selectSkillCandidates(
  params: SelectSkillCandidatesParams,
): Promise<Set<string>> {
  const { userText, assistantText, nowText, config, topK } = params;

  const candidates = new Set<string>();
  if (topK <= 0) return candidates;

  const annQueryText = [userText, assistantText, nowText]
    .filter((s) => s.length > 0)
    .join("\n");
  if (annQueryText.length === 0) return candidates;

  const denseResult = await embedWithBackend(config, [annQueryText]);
  const dense = denseResult.vectors[0];
  const sparse = generateSparseEmbedding(annQueryText);
  const hits = await hybridQuerySkills(dense, sparse, topK);
  for (const hit of hits) candidates.add(hit.id);

  return candidates;
}

export interface ComputeSkillActivationParams {
  candidates: ReadonlySet<string>;
  userText: string;
  assistantText: string;
  nowText: string;
  config: AssistantConfig;
}

/**
 * Apply the skill-side activation formula (no decay carry-over, no spread):
 *   A_skill(s) = clamp01(c_user · sim_u + c_assistant · sim_a + c_now · sim_n)
 *
 * Reuses the activation coefficients from `config.memory.v2`. The three
 * `simSkillBatch` calls run concurrently — they hit independent named
 * vectors and embed independent query texts.
 *
 * Empty candidates short-circuits to an empty map without touching the
 * embedding backend or Qdrant.
 */
export async function computeSkillActivation(
  params: ComputeSkillActivationParams,
): Promise<Map<string, number>> {
  const { candidates, userText, assistantText, nowText, config } = params;

  const result = new Map<string, number>();
  if (candidates.size === 0) return result;

  const { c_user, c_assistant, c_now } = config.memory.v2;
  const idList = [...candidates];

  const [simUser, simAssistant, simNow] = await Promise.all([
    simSkillBatch(userText, idList, config),
    simSkillBatch(assistantText, idList, config),
    simSkillBatch(nowText, idList, config),
  ]);

  for (const id of idList) {
    const value =
      c_user * (simUser.get(id) ?? 0) +
      c_assistant * (simAssistant.get(id) ?? 0) +
      c_now * (simNow.get(id) ?? 0);
    result.set(id, clampUnitInterval(value));
  }

  return result;
}

export interface SelectSkillInjectionsParams {
  /** Final skill activation map. */
  A: ReadonlyMap<string, number>;
  /** Cap on the per-turn skill slate, e.g. `config.memory.v2.skills_top_k`. */
  topK: number;
}

export interface SelectSkillInjectionsResult {
  /**
   * Top-K skill ids by activation (descending), tie-broken lexicographically.
   * Skills are re-presented every turn — no `toInject` delta — so the caller
   * uses this list verbatim to render the skill slate.
   */
  topNow: string[];
}

/**
 * Pick the top-K skill ids by activation (descending; stable on ties via id
 * lexicographic order). Skills are stateless — there is no `everInjected`
 * dedup, so the same id can appear on consecutive turns.
 *
 * Returns `{ topNow: [] }` for an empty activation map or `topK <= 0`.
 */
export function selectSkillInjections(
  params: SelectSkillInjectionsParams,
): SelectSkillInjectionsResult {
  const { A, topK } = params;
  if (A.size === 0 || topK <= 0) {
    return { topNow: [] };
  }

  const ranked = [...A.entries()].sort(([idA, valA], [idB, valB]) => {
    if (valB !== valA) return valB - valA; // higher activation first
    return idA < idB ? -1 : idA > idB ? 1 : 0; // stable tie-break
  });

  const topNow = ranked.slice(0, topK).map(([id]) => id);
  return { topNow };
}
