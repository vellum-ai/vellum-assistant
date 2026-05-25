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
 * with seeds themselves excluded) plus a per-seed `EdgeExpansion[]` trace so a
 * harness can attribute each pulled slug to the seed it came from.
 */

import { getEdgeIndex, getReachable } from "../v2/edge-index.js";
import type { EdgeExpansion } from "../v2/harness/trace.js";

/** Default hop budget. The design calls for a 1–2 hop walk; 2 is the ceiling. */
const DEFAULT_HOPS = 2;

export interface ExpandEdgesArgs {
  workspaceDir: string;
  /** Confident seed slugs to expand from. */
  seeds: Iterable<string>;
  /** Hop budget for the outgoing walk. Defaults to {@link DEFAULT_HOPS}. */
  hops?: number;
  /**
   * Extra *outgoing* adjacency (`from → Set<to>`) merged with the curated graph
   * during traversal. The injection seam for learned weighted auto-edges; this
   * module never reads or thresholds weights itself — the caller pre-filters to
   * above-threshold edges before passing them in.
   */
  extraAdjacency?: ReadonlyMap<string, ReadonlySet<string>>;
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
 * Each seed produces one `EdgeExpansion { from, pulled }` entry (sorted slugs
 * for deterministic output); the seed itself is never in its own `pulled`. The
 * top-level `pulled` set is the union across all seeds — a slug pulled by more
 * than one seed appears once there but in each contributing seed's expansion.
 *
 * Provider-free and read-only: the only I/O is `getEdgeIndex`, which reads
 * concept-page frontmatter from disk (and caches module-locally in v2).
 */
export async function expandEdges(
  args: ExpandEdgesArgs,
): Promise<ExpandEdgesResult> {
  const { workspaceDir, seeds, hops = DEFAULT_HOPS, extraAdjacency } = args;

  const index = await getEdgeIndex(workspaceDir);
  const pulled = new Set<string>();
  const expansions: EdgeExpansion[] = [];

  // De-dupe seeds while preserving first-seen order for a stable trace.
  const seenSeeds = new Set<string>();

  for (const seed of seeds) {
    if (seenSeeds.has(seed)) continue;
    seenSeeds.add(seed);

    const reachable = extraAdjacency
      ? reachableMerged(index.outgoing, extraAdjacency, seed, hops)
      : getReachable(index, seed, hops, "out");

    expansions.push({ from: seed, pulled: [...reachable].sort() });
    for (const slug of reachable) pulled.add(slug);
  }

  return { pulled, expansions };
}
