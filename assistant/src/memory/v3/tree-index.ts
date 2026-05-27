/**
 * Memory v3 — Tree index (DAG build + cache).
 *
 * The v3 tree is a DAG *overlay* over the flat `memory/concepts/` pages: every
 * node carries an ordered `children` list whose entries are either
 * `"page:<slug>"` (a leaf concept page, canonical content untouched by v3) or
 * `"node:<id>"` (a sub-node in the tree). A page or node may be referenced by
 * more than one parent — hence DAG, not tree.
 *
 * This module scans every node on disk and materializes that edge list into
 * forward and reverse adjacency maps so downstream routing/validation can walk
 * the graph without re-reading the filesystem:
 *   - `childrenByNode` — node id → ordered child refs (forward edges).
 *   - `parentsByNode` — node id → set of parent node ids (reverse edges for
 *     `node:` children).
 *   - `pageParents` — page slug → set of parent node ids (reverse edges for
 *     `page:` children).
 *
 * The build is **structural only**: it never verifies that a referenced page
 * or node actually exists. Dangling refs are retained in the adjacency maps so
 * a later validation pass can report them. Root detection prefers the reserved
 * `_root` id; absent that it picks the single node with no parents (warning and
 * picking deterministically if the choice is ambiguous).
 *
 * The build is cached module-locally per `workspaceDir`, mirroring
 * `../v2/page-index.ts`. Callers must invalidate via `invalidateTreeIndex` when
 * tree nodes change — `tree-store.ts`'s `writeNode` / `deleteNode` already do.
 */

import { getLogger } from "../../util/logger.js";
import { listNodes, readNode, ROOT_NODE_ID } from "./tree-store.js";
import type { TreeNode } from "./types.js";

const log = getLogger("memory-v3-tree-index");

/** Prefix marking a child ref that targets a leaf concept page. */
const PAGE_REF_PREFIX = "page:";

/** Prefix marking a child ref that targets a sub-node in the tree. */
const NODE_REF_PREFIX = "node:";

/**
 * A single parsed `children` entry. `kind` distinguishes a leaf concept page
 * (`"page"`) from a sub-node (`"node"`); `ref` is the bare slug or node id with
 * the `page:` / `node:` prefix stripped.
 */
export interface ChildRef {
  kind: "page" | "node";
  ref: string;
}

/**
 * Snapshot of the v3 tree DAG for one workspace.
 *
 * `nodes` is every readable node keyed by id. The three adjacency maps are
 * derived from each node's `children`:
 *   - `childrenByNode` — forward edges, preserving `children` order.
 *   - `parentsByNode` — reverse edges restricted to `node:` children.
 *   - `pageParents` — reverse edges restricted to `page:` children, keyed by
 *     page slug.
 *
 * `root` is the entry-point node id (`_root` when present). Dangling refs (a
 * `node:`/`page:` target with no on-disk file) are retained throughout —
 * validation, not the index build, is responsible for surfacing them.
 */
export interface TreeIndex {
  nodes: Map<string, TreeNode>;
  childrenByNode: Map<string, ReadonlyArray<ChildRef>>;
  parentsByNode: Map<string, Set<string>>;
  pageParents: Map<string, Set<string>>;
  root: string;
}

interface CachedIndex {
  workspaceDir: string;
  index: TreeIndex;
}

let cache: CachedIndex | null = null;

/**
 * Parse a raw `children` entry into a {@link ChildRef}. Returns `null` for any
 * entry that does not carry a recognized `page:` / `node:` prefix or whose ref
 * body is empty — those are malformed and dropped (with a warn) rather than
 * faithfully threaded through adjacency.
 */
function parseChildRef(raw: string): ChildRef | null {
  if (raw.startsWith(PAGE_REF_PREFIX)) {
    const ref = raw.slice(PAGE_REF_PREFIX.length);
    return ref.length > 0 ? { kind: "page", ref } : null;
  }
  if (raw.startsWith(NODE_REF_PREFIX)) {
    const ref = raw.slice(NODE_REF_PREFIX.length);
    return ref.length > 0 ? { kind: "node", ref } : null;
  }
  return null;
}

/** Append `parent` to the parent-set for `key`, creating the set on demand. */
function addParent(
  map: Map<string, Set<string>>,
  key: string,
  parent: string,
): void {
  let parents = map.get(key);
  if (!parents) {
    parents = new Set();
    map.set(key, parents);
  }
  parents.add(parent);
}

/**
 * Pick the root node id from the materialized adjacency. Prefers the reserved
 * {@link ROOT_NODE_ID} when a node with that id exists. Otherwise the root is
 * the single node with no parents; if several nodes are parentless the choice
 * is ambiguous, so warn and pick the ASCII-smallest id for determinism. With no
 * nodes at all the root is `_root` (the well-known handle a migration authors
 * first), matching the empty-workspace contract.
 */
function pickRoot(
  nodes: Map<string, TreeNode>,
  parentsByNode: Map<string, Set<string>>,
): string {
  if (nodes.has(ROOT_NODE_ID)) {
    return ROOT_NODE_ID;
  }

  const parentless = [...nodes.keys()].filter(
    (id) => !parentsByNode.has(id) || parentsByNode.get(id)!.size === 0,
  );
  parentless.sort();

  if (parentless.length === 1) {
    return parentless[0];
  }
  if (parentless.length === 0) {
    return ROOT_NODE_ID;
  }
  log.warn(
    { parentless },
    "Ambiguous tree root — no '_root' node and multiple parentless nodes; picking ASCII-smallest deterministically",
  );
  return parentless[0];
}

/**
 * Return a `TreeIndex` for `workspaceDir`. Cached module-locally; the cache is
 * invalidated by `invalidateTreeIndex` (called by `tree-store.ts` hooks when
 * nodes change).
 *
 * Cold builds list every node and read them in parallel, dropping any whose
 * read rejects with a warn so one broken node never blocks the rest of the
 * index. Each readable node's `children` is parsed into {@link ChildRef}s and
 * threaded into forward (`childrenByNode`) and reverse (`parentsByNode` /
 * `pageParents`) adjacency. The build is structural only — referenced
 * pages/nodes are never verified to exist; dangling refs are retained for a
 * later validation pass.
 */
export async function getTreeIndex(workspaceDir: string): Promise<TreeIndex> {
  if (cache && cache.workspaceDir === workspaceDir) {
    return cache.index;
  }

  const ids = await listNodes(workspaceDir);

  // Read every node in parallel; nodes whose read rejects are dropped with a
  // warn so a single broken node never blocks the rest of the index.
  const settled = await Promise.allSettled(
    ids.map((id) => readNode(workspaceDir, id)),
  );

  const nodes = new Map<string, TreeNode>();
  const childrenByNode = new Map<string, ReadonlyArray<ChildRef>>();
  const parentsByNode = new Map<string, Set<string>>();
  const pageParents = new Map<string, Set<string>>();

  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    const id = ids[i];
    if (result.status === "rejected") {
      log.warn(
        { id, err: result.reason },
        "Dropping tree node from index — read failed",
      );
      continue;
    }
    const node = result.value;
    // `readNode` returns null only on ENOENT; a node listed by `listNodes`
    // that vanishes between list and read is a benign race — drop it silently.
    if (!node) continue;
    nodes.set(id, node);
  }

  // Build adjacency in a second pass so every node is registered first — that
  // keeps a deterministic, list-order iteration independent of read timing.
  for (const node of nodes.values()) {
    const childRefs: ChildRef[] = [];
    for (const raw of node.frontmatter.children) {
      const parsed = parseChildRef(raw);
      if (!parsed) {
        log.warn(
          { id: node.id, raw },
          "Dropping malformed child ref — expected 'page:<slug>' or 'node:<id>'",
        );
        continue;
      }
      childRefs.push(parsed);
      const reverse = parsed.kind === "node" ? parentsByNode : pageParents;
      addParent(reverse, parsed.ref, node.id);
    }
    childrenByNode.set(node.id, childRefs);
  }

  const root = pickRoot(nodes, parentsByNode);

  const index: TreeIndex = {
    nodes,
    childrenByNode,
    parentsByNode,
    pageParents,
    root,
  };
  cache = { workspaceDir, index };
  return index;
}

/**
 * Clear the cached index. Pass `workspaceDir` to scope invalidation to a
 * specific cache entry; omit it to clear unconditionally.
 */
export function invalidateTreeIndex(workspaceDir?: string): void {
  if (!cache) return;
  if (workspaceDir === undefined || cache.workspaceDir === workspaceDir) {
    cache = null;
  }
}
