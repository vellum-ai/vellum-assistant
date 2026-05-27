/**
 * Memory v3 — Curated edge-expansion lane.
 *
 * Given a set of confident seed slugs, pull their 1–2 hop *outgoing*
 * neighborhood from the curated `edges:` graph (each concept page's
 * frontmatter `edges:` list, surfaced by v2's `getEdgeIndex`). This is a
 * provider-free, read-only structural expansion — no LLM, no scoring. It
 * answers "given that we're confident about A, what does A's curated graph
 * say we should also pull in?".
 *
 * The optional `extraAdjacency` parameter is the seam a later PR uses to inject
 * above-threshold *weighted auto-edges* (edges the system learned, not ones a
 * human curated) WITHOUT modifying this module. When supplied, it is treated as
 * additional out-edges merged with the curated graph during traversal: the
 * effective out-neighborhood of a node is `curated[node] ∪ extraAdjacency[node]`.
 *
 * The result is the union of every seed's reachable neighborhood (`pulled`,
 * with the full seed set excluded — a seed reachable from another seed is still
 * a seed, not a neighbor) plus a per-seed `EdgeExpansion[]` trace so a harness
 * can attribute each pulled slug to the seed it came from.
 */

import { getEdgeIndex, getReachable } from "../v2/edge-index.js";
import type { EdgeExpansion } from "../v2/harness/trace.js";

/** Default hop budget. The design calls for a 1–2 hop walk; 2 is the ceiling. */
const DEFAULT_HOPS = 2;

// ---------------------------------------------------------------------------
// Expansion bounds
// ---------------------------------------------------------------------------
//
// The seed set handed to this lane is the *union* of every upstream lane's
// candidates (scouts + dense filter + tree-walk descent), so on a mature corpus
// it can run to one-to-two-thousand slugs. Expanding all of them — each to its
// full 1–2 hop neighborhood — pulls in tens of thousands of slugs, which inflates
// the downstream selection gate's candidate pool toward the entire corpus and
// drowns the high-confidence signal. The expansion is also purely structural
// (no scoring), so a larger pool buys no precision; it only adds gate cost.
//
// These bounds keep the lane's output proportional to a curated neighborhood
// rather than the corpus. They are module-level constants (mirroring
// `LANE_QUERY_LIMIT` in `scouts.ts`) rather than config fields so the lane stays
// self-contained — the caps protect the gate regardless of how callers compose
// the seed union. Truncation is deterministic (sorted slugs) so a given seed
// graph always yields the same bounded result.

/**
 * Cap on the number of distinct seeds expanded. Seeds are processed in
 * first-seen order; once this many have been expanded the rest are dropped. The
 * upstream lanes already rank their hits, so the earliest seeds are the most
 * confident — truncating the long tail costs little recall.
 */
const MAX_SEEDS_EXPANDED = 150;

/**
 * Cap on how many slugs a single seed may contribute. A hub node in a dense
 * curated graph can reach a large 2-hop neighborhood on its own; without this a
 * single highly-connected seed could dominate the union. The per-seed
 * neighborhood is truncated to its lexicographically-first slugs.
 */
const MAX_PULLS_PER_SEED = 32;

/**
 * Default ceiling on the size of the unioned `pulled` set. This is the
 * load-bearing bound: it caps the lane's contribution to the gate's pool no
 * matter how many seeds or how dense the graph. Once reached, no further seeds
 * are expanded. Overridable per call via {@link ExpandEdgesArgs.maxTotalPulls}
 * (the loop wires it to `memory.v3.edges.maxPulls`).
 */
const MAX_TOTAL_PULLS = 400;

// ---------------------------------------------------------------------------
// Seed ranking
// ---------------------------------------------------------------------------

/**
 * Lane-trust order used to rank seeds *before* the {@link MAX_SEEDS_EXPANDED}
 * cap (lower = expanded first). The seed union arrives in lane order (hot
 * first), so without reordering the seed budget is spent on the hot recency
 * lane and the LLM-vetted tree/dense seeds — the most query-relevant — are the
 * ones truncated. Ranking tree > dense > sparse > hot spends the budget on
 * relevance first. A seed whose lane is unknown/absent (or edge-pulled) ranks
 * last. Requires `laneBySlug`; without it the incoming order is kept.
 */
const SEED_LANE_RANK: Readonly<Record<string, number>> = {
  tree: 0,
  dense: 1,
  sparse: 2,
  hot: 3,
};
const SEED_LANE_RANK_LAST = 4;

function seedRank(
  slug: string,
  laneBySlug: ReadonlyMap<string, string>,
): number {
  const lane = laneBySlug.get(slug);
  return lane !== undefined
    ? (SEED_LANE_RANK[lane] ?? SEED_LANE_RANK_LAST)
    : SEED_LANE_RANK_LAST;
}

export interface ExpandEdgesArgs {
  workspaceDir: string;
  /** Confident seed slugs to expand from. */
  seeds: Iterable<string>;
  /**
   * Per-seed lane provenance (slug → first lane that surfaced it). When present,
   * seeds are ranked by lane trust ({@link SEED_LANE_RANK}) before the seed cap,
   * so the budget is spent on query-relevant seeds rather than recency. Typed as
   * a plain string map to avoid importing the loop's `LaneSource` (circular).
   */
  laneBySlug?: ReadonlyMap<string, string>;
  /** Hop budget for the outgoing walk. Defaults to {@link DEFAULT_HOPS}. */
  hops?: number;
  /**
   * Extra *outgoing* adjacency (`from → Set<to>`) merged with the curated graph
   * during traversal. The injection seam for learned weighted auto-edges; this
   * module never reads or thresholds weights itself — the caller pre-filters to
   * above-threshold edges before passing them in.
   */
  extraAdjacency?: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * Hard ceiling on the unioned `pulled` set — the lane's contribution to the
   * gate pool. Defaults to {@link MAX_TOTAL_PULLS} when omitted or not a finite
   * number ≥ 0.
   */
  maxTotalPulls?: number;
}

export interface ExpandEdgesResult {
  /** Union of every seed's reachable neighborhood, seeds excluded. */
  pulled: Set<string>;
  /** Per-seed attribution: which slugs each seed pulled in. */
  expansions: EdgeExpansion[];
}

/**
 * BFS the outgoing neighborhood of `seed` within `hops`, walking the union of
 * the curated `outgoing` adjacency and any `extraAdjacency`. Mirrors v2's
 * `getReachable` semantics — start excluded, bounded by `hops` and a visited
 * set so cycles can't loop — but over a merged adjacency view.
 */
function reachableMerged(
  curated: ReadonlyMap<string, ReadonlySet<string>>,
  extra: ReadonlyMap<string, ReadonlySet<string>>,
  seed: string,
  hops: number,
): Set<string> {
  const result = new Set<string>();
  if (hops <= 0) return result;

  const visited = new Set<string>([seed]);
  let frontier: string[] = [seed];

  for (let depth = 0; depth < hops && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const node of frontier) {
      const curatedNeighbors = curated.get(node);
      const extraNeighbors = extra.get(node);
      for (const neighbors of [curatedNeighbors, extraNeighbors]) {
        if (!neighbors) continue;
        for (const neighbor of neighbors) {
          if (visited.has(neighbor)) continue;
          visited.add(neighbor);
          result.add(neighbor);
          next.push(neighbor);
        }
      }
    }
    frontier = next;
  }

  return result;
}

/**
 * Expand a set of confident seed slugs to their 1–2 hop curated neighborhood.
 *
 * Each expanded seed produces one `EdgeExpansion { from, pulled }` entry (sorted
 * slugs for deterministic output); no seed ever appears in `pulled` — not its
 * own entry and not another seed's, even when one seed is a neighbor of another
 * (the seeds-excluded contract). The top-level `pulled` set is the union across
 * all expanded seeds — a slug pulled by more than one seed appears once there
 * but in each contributing seed's expansion.
 *
 * Bounded by {@link MAX_SEEDS_EXPANDED}, {@link MAX_PULLS_PER_SEED}, and
 * {@link MAX_TOTAL_PULLS} so a large seed union or a dense graph can't balloon
 * the downstream gate's pool — see the bounds block above. Seeds past the count
 * cap, or any seed reached after the union ceiling is full, are skipped entirely
 * and get no expansion entry; every entry that is emitted lists exactly the
 * slugs that seed contributed to the bounded union, so the trace stays faithful.
 *
 * Provider-free and read-only: the only I/O is `getEdgeIndex`, which reads
 * concept-page frontmatter from disk (and caches module-locally in v2).
 */
export async function expandEdges(
  args: ExpandEdgesArgs,
): Promise<ExpandEdgesResult> {
  const {
    workspaceDir,
    seeds,
    hops = DEFAULT_HOPS,
    extraAdjacency,
    laneBySlug,
  } = args;

  // Per-call override of the union ceiling, falling back to the default constant
  // for an omitted or invalid (negative/NaN) value.
  const maxTotal =
    typeof args.maxTotalPulls === "number" &&
    Number.isFinite(args.maxTotalPulls) &&
    args.maxTotalPulls >= 0
      ? args.maxTotalPulls
      : MAX_TOTAL_PULLS;

  const index = await getEdgeIndex(workspaceDir);
  const pulled = new Set<string>();
  const expansions: EdgeExpansion[] = [];

  // Rank seeds by lane trust before the seed cap so the budget goes to the most
  // query-relevant seeds (tree/dense/sparse) rather than recency (hot), which
  // leads the incoming candidate order. `Array.prototype.sort` is stable, so
  // seeds within a tier keep their candidate order. Without `laneBySlug` the
  // incoming order is preserved.
  const orderedSeeds = [...seeds];
  if (laneBySlug) {
    orderedSeeds.sort(
      (a, b) => seedRank(a, laneBySlug) - seedRank(b, laneBySlug),
    );
  }

  // De-dupe seeds while preserving (ranked) order for a stable trace. The full
  // de-duped seed set is also the exclusion set: a seed reachable from another
  // seed is itself a confident hit, not a neighbor, so it must never land in
  // `pulled` (the seeds-excluded contract) — `getReachable` only excludes the
  // walk's own start node, so a B reachable from A would otherwise leak in.
  const seedSet = new Set<string>();
  for (const seed of orderedSeeds) seedSet.add(seed);

  const seenSeeds = new Set<string>();

  for (const seed of orderedSeeds) {
    if (seenSeeds.has(seed)) continue;
    seenSeeds.add(seed);

    // Bound the number of seeds expanded, and stop once the union is full —
    // the remaining seeds would only inflate the gate's pool. Checked before
    // doing any per-seed work so an oversized seed set is cheap to truncate.
    if (seenSeeds.size > MAX_SEEDS_EXPANDED || pulled.size >= maxTotal) {
      break;
    }

    const reachable = extraAdjacency
      ? reachableMerged(index.outgoing, extraAdjacency, seed, hops)
      : getReachable(index, seed, hops, "out");

    // Drop any other seed from this seed's neighborhood (seeds-excluded
    // contract) and split the rest into slugs already in the union vs. fresh
    // ones. The per-seed fan-out cap and the union's remaining headroom apply
    // only to fresh slugs, so a slot is never spent on a duplicate an earlier
    // seed already pulled — at the cap that would silently drop a unique
    // neighbor. Sorting first keeps truncation deterministic. The trace lists
    // every reached slug that made it into the bounded union (fresh admissions
    // plus the duplicates this seed also reaches), so it stays a faithful
    // attribution while the budget is reserved for new recall.
    const sorted = [...reachable].sort();
    const alreadyPulled = sorted.filter(
      (slug) => !seedSet.has(slug) && pulled.has(slug),
    );
    const fresh = sorted.filter(
      (slug) => !seedSet.has(slug) && !pulled.has(slug),
    );

    const remaining = maxTotal - pulled.size;
    const perSeedCap = Math.min(MAX_PULLS_PER_SEED, remaining);
    const admitted = fresh.slice(0, perSeedCap);
    for (const slug of admitted) pulled.add(slug);

    const seedPulled = [...alreadyPulled, ...admitted].sort();
    expansions.push({ from: seed, pulled: seedPulled });
  }

  return { pulled, expansions };
}
