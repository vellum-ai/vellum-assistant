/**
 * Memory v2 — `memory/edges.json` read/write and neighbor resolution.
 *
 * This module is the sole owner of the `memory/edges.json` file. The edges
 * index is the source of truth for v2 graph topology — concept-page
 * frontmatter only mirrors a derived view of it.
 *
 * Edges are unweighted, undirected, and stored as canonicalized 2-tuples
 * (alphabetically-first slug first). Self-loops are rejected at write time.
 *
 * Writes are atomic (write to `<file>.tmp-<uuid>`, then `rename(2)` onto the
 * destination) so a crashed writer never leaves a torn JSON file behind —
 * readers always see either the previous or the new index.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { EdgesIndex } from "./types.js";
import { EdgesIndexSchema } from "./types.js";

const EDGES_FILENAME = "edges.json";

/** Path to `memory/edges.json` inside `workspaceDir`. */
function edgesPath(workspaceDir: string): string {
  return join(workspaceDir, "memory", EDGES_FILENAME);
}

/**
 * Canonicalize a single tuple so `[a, b]` and `[b, a]` collapse to the same
 * representation. Keeps writes deterministic regardless of caller order.
 */
function canonicalTuple(a: string, b: string): [string, string] {
  return a <= b ? [a, b] : [b, a];
}

/** Stable string key for a canonical tuple, used for de-duplication. */
function tupleKey(t: readonly [string, string]): string {
  return `${t[0]}\u0000${t[1]}`;
}

/**
 * Read `memory/edges.json` and validate it against `EdgesIndexSchema`.
 * Returns the canonical empty index when the file is missing.
 *
 * Any JSON parse error or schema-validation failure throws — the file should
 * never be silently quarantined, since a broken edges.json signals a bug in
 * a writer or external tampering.
 */
export async function readEdges(workspaceDir: string): Promise<EdgesIndex> {
  let raw: string;
  try {
    raw = await readFile(edgesPath(workspaceDir), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, edges: [] };
    }
    throw err;
  }
  const parsed = JSON.parse(raw);
  return EdgesIndexSchema.parse(parsed);
}

/**
 * Write `memory/edges.json` atomically. The on-disk tuples are canonicalized
 * and de-duplicated before serialization, so the output is independent of
 * insertion order and free of redundant pairs.
 *
 * Atomicity: bytes are written to a sibling temp file then renamed onto the
 * destination. `rename(2)` on the same filesystem is atomic, so a reader
 * concurrent with the writer sees either the prior file or the new one in
 * full — never a partial write.
 */
export async function writeEdges(
  workspaceDir: string,
  idx: EdgesIndex,
): Promise<void> {
  const canonical = canonicalizeIndex(idx);
  const finalPath = edgesPath(workspaceDir);
  await mkdir(dirname(finalPath), { recursive: true });
  const tmpPath = `${finalPath}.tmp-${randomUUID()}`;
  const body = `${JSON.stringify(canonical, null, 2)}\n`;
  await writeFile(tmpPath, body, "utf-8");
  await rename(tmpPath, finalPath);
}

/**
 * Pure helper: return a new index with `(a, b)` added (canonicalized). If the
 * edge already exists the index is returned unchanged. Self-loops are
 * rejected — concept-page graphs are simple graphs.
 */
export function addEdge(idx: EdgesIndex, a: string, b: string): EdgesIndex {
  if (a === b) {
    throw new Error(`addEdge: refusing to add self-loop on slug "${a}"`);
  }
  const tuple = canonicalTuple(a, b);
  const key = tupleKey(tuple);
  for (const existing of idx.edges) {
    if (tupleKey(canonicalTuple(existing[0], existing[1])) === key) {
      return idx;
    }
  }
  return { version: idx.version, edges: [...idx.edges, tuple] };
}

/**
 * Pure helper: return a new index with `(a, b)` removed (matched on its
 * canonical form). No-op if the edge is not present.
 */
export function removeEdge(idx: EdgesIndex, a: string, b: string): EdgesIndex {
  const target = tupleKey(canonicalTuple(a, b));
  const filtered = idx.edges.filter(
    ([x, y]) => tupleKey(canonicalTuple(x, y)) !== target,
  );
  if (filtered.length === idx.edges.length) return idx;
  return { version: idx.version, edges: filtered };
}

/**
 * Iterative BFS over the undirected edge graph starting at `slug`. Returns
 * every slug reachable within `hops` edges, *excluding* the start slug. An
 * orphan node (or unknown slug) yields the empty set.
 *
 * `hops` is clamped at 0 — a non-positive value collapses to an immediate
 * empty result so callers never need to special-case it.
 */
export function getNeighbors(
  idx: EdgesIndex,
  slug: string,
  hops: number,
): Set<string> {
  const result = new Set<string>();
  if (hops <= 0) return result;

  const adjacency = buildAdjacency(idx);
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

/**
 * Validate an edges index against a known set of concept-page slugs. Returns
 * the unique list of endpoints that are referenced by an edge but missing
 * from `knownSlugs`. `ok` mirrors `missing.length === 0` for caller
 * convenience.
 */
export function validateEdges(
  idx: EdgesIndex,
  knownSlugs: Set<string>,
): { ok: boolean; missing: string[] } {
  const missing = new Set<string>();
  for (const [a, b] of idx.edges) {
    if (!knownSlugs.has(a)) missing.add(a);
    if (!knownSlugs.has(b)) missing.add(b);
  }
  const list = [...missing].sort();
  return { ok: list.length === 0, missing: list };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Canonicalize tuples + dedup, returning a deterministically-sorted index.
 * Self-loops are dropped silently here (writer-side) so a malformed in-memory
 * value can still be persisted as a clean file.
 */
function canonicalizeIndex(idx: EdgesIndex): EdgesIndex {
  const seen = new Map<string, [string, string]>();
  for (const [a, b] of idx.edges) {
    if (a === b) continue;
    const tuple = canonicalTuple(a, b);
    seen.set(tupleKey(tuple), tuple);
  }
  // Sort by canonical key (NUL-separated) — gives a lexicographic order on
  // the (left, right) pair without a multi-clause comparator.
  const tuples = [...seen.entries()]
    .sort(([keyX], [keyY]) => (keyX < keyY ? -1 : keyX > keyY ? 1 : 0))
    .map(([, tuple]) => tuple);
  return { version: idx.version, edges: tuples };
}

/** Build slug → neighbors map from canonicalized tuples (undirected). */
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
