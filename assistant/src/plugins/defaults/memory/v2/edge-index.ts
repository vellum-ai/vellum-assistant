/**
 * Memory v2 — In-memory directed edge index, derived from concept-page
 * frontmatter.
 *
 * Each concept page's `edges:` frontmatter list is the canonical source of
 * truth for that page's *outgoing* edges. Edges are directed: an entry of
 * `B` in A's `edges:` means "activating A pulls in B" — activation flows
 * A → B but not B → A. The full graph is the union of every page's
 * outgoing edges.
 *
 * `getEdgeIndex` builds an in-memory snapshot by walking pages and caches it
 * module-locally for fast per-turn reads. Page mutations invalidate the cache:
 *   - `page-store.ts` calls `invalidateEdgeIndex` from `writePage` / `deletePage`
 *     for programmatic writes (migration, future tools).
 *   - `daemon/tool-side-effects.ts` invalidates after any LLM-driven file
 *     mutation under `memory/concepts/`.
 *
 * Self-loops are dropped silently when the index is built — concept-page
 * graphs are simple graphs.
 */

import { listPages, readPage } from "./page-store.js";

/**
 * Snapshot of the v2 graph as outgoing + incoming adjacency maps.
 *
 * Both maps are derived from the same set of page-frontmatter `edges:` lists.
 * The asymmetry between them is intentional: callers walking outgoing
 * (`outgoing[slug]`) see what `slug` points at; callers walking incoming
 * (`incoming[slug]`) see who points at `slug`.
 */
export interface EdgeIndex {
  /** `from → Set<to>` — what each page points at. */
  outgoing: Map<string, Set<string>>;
  /** `to → Set<from>` — who points at each page. */
  incoming: Map<string, Set<string>>;
}

interface CachedIndex {
  workspaceDir: string;
  index: EdgeIndex;
}

let cache: CachedIndex | null = null;

function ensureSet(map: Map<string, Set<string>>, key: string): Set<string> {
  let set = map.get(key);
  if (!set) {
    set = new Set<string>();
    map.set(key, set);
  }
  return set;
}

/**
 * Return an `EdgeIndex` for `workspaceDir`. Cached module-locally; the cache is
 * invalidated by `invalidateEdgeIndex` (called from `writePage` / `deletePage`
 * and the file-tool post-execution hook).
 *
 * Cold builds walk every concept page in parallel and read its frontmatter.
 * Pages that fail to read are dropped silently — a single broken page
 * shouldn't block the rest of the index.
 */
export async function getEdgeIndex(workspaceDir: string): Promise<EdgeIndex> {
  if (cache && cache.workspaceDir === workspaceDir) {
    return cache.index;
  }

  const slugs = await listPages(workspaceDir);
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();

  await Promise.all(
    slugs.map(async (slug) => {
      let page;
      try {
        page = await readPage(workspaceDir, slug);
      } catch {
        return;
      }
      if (!page) return;
      const out = new Set<string>();
      for (const target of page.frontmatter.edges) {
        if (target === slug) continue;
        out.add(target);
      }
      if (out.size > 0) outgoing.set(slug, out);
      for (const target of out) {
        ensureSet(incoming, target).add(slug);
      }
    }),
  );

  const index: EdgeIndex = { outgoing, incoming };
  cache = { workspaceDir, index };
  return index;
}

/**
 * Clear the cached index. Pass a `workspaceDir` to scope the invalidation to
 * a specific cache entry (relevant when tests cycle through multiple
 * workspaces); omit it to clear unconditionally.
 */
export function invalidateEdgeIndex(workspaceDir?: string): void {
  if (!cache) return;
  if (workspaceDir === undefined || cache.workspaceDir === workspaceDir) {
    cache = null;
  }
}

export type EdgeDirection = "out" | "in";

/**
 * Iterative BFS returning every slug reachable from `slug` within `hops`
 * directed edges, walking either outgoing or incoming adjacency. The start
 * slug is excluded from the result; orphan nodes return the empty set.
 *
 * `hops` is clamped at 0 — non-positive values collapse to an empty result so
 * callers don't need to special-case it.
 */
export function getReachable(
  index: EdgeIndex,
  slug: string,
  hops: number,
  direction: EdgeDirection,
): Set<string> {
  const result = new Set<string>();
  if (hops <= 0) return result;

  const adjacency = direction === "out" ? index.outgoing : index.incoming;
  const visited = new Set<string>([slug]);
  let frontier: string[] = [slug];

  for (let depth = 0; depth < hops && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const node of frontier) {
      const neighbors = adjacency.get(node);
      if (!neighbors) continue;
      for (const neighbor of neighbors) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        result.add(neighbor);
        next.push(neighbor);
      }
    }
    frontier = next;
  }

  return result;
}

export interface EdgeValidationResult {
  ok: boolean;
  /**
   * Outgoing-edge targets that don't correspond to any known slug. Sorted by
   * `(from, to)` for deterministic output.
   */
  missing: Array<{ from: string; to: string }>;
}

/**
 * Validate every outgoing edge target against `knownSlugs`. Returns a sorted
 * list of `(from, to)` pairs whose `to` slug has no corresponding concept
 * page on disk.
 */
export function validateEdgeTargets(
  index: EdgeIndex,
  knownSlugs: ReadonlySet<string>,
): EdgeValidationResult {
  const missing: Array<{ from: string; to: string }> = [];
  const sources = [...index.outgoing.keys()].sort();
  for (const from of sources) {
    const targets = [...(index.outgoing.get(from) ?? [])].sort();
    for (const to of targets) {
      if (!knownSlugs.has(to)) missing.push({ from, to });
    }
  }
  return { ok: missing.length === 0, missing };
}

/**
 * Total count of directed edges in the index — i.e. the sum of every page's
 * outgoing-edge fanout. Each (from, to) pair counts once.
 */
export function totalEdgeCount(index: EdgeIndex): number {
  let n = 0;
  for (const targets of index.outgoing.values()) {
    n += targets.size;
  }
  return n;
}
