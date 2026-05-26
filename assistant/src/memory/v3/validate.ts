/**
 * Memory v3 — Tree structure validator.
 *
 * The v3 tree is hand-authored by a data-migration during the v2 → v3 rollout
 * (nodes reference pages and sub-nodes by `page:`/`node:` refs). Because the
 * structure is authored, not derived, it can drift: a ref can dangle, a page
 * can be left unwired, two nodes can reference each other into a cycle, a
 * parent node's compositional summary can fall behind a freshly-edited child,
 * or a page `edges:` entry can point at a slug with no page.
 *
 * `validateTree` is the read-only report the migration (and any later
 * structure-health probe) runs to surface those defects. It is deliberately
 * **non-throwing**: the migration is in progress, so an incomplete tree is
 * expected — the report is informational, and the caller decides what (if
 * anything) is fatal. It builds the three indices it needs (tree, page, edge),
 * walks the DAG, and returns counts plus the offending ids for each category.
 *
 * Categories:
 *   - `danglingChildRefs` — a node `children` entry (`node:`/`page:`) whose
 *     target node/page does not exist on disk.
 *   - `orphanPages` — concept pages present in the page index but not reachable
 *     from the tree root by descending every `node:` child. Informational while
 *     the migration is mid-flight (not every page is wired in yet). Synthetic
 *     page-index entries (skills, CLI commands) are excluded — they are never
 *     tree members.
 *   - `cycles` — back-edges found during a full DFS over `node:` adjacency
 *     (A → B → A). A cycle would make a naive descent loop forever.
 *   - `staleIndex` — a node whose own file mtime predates one of its `node:`
 *     children's mtime, hinting its compositional index/summary may be out of
 *     date relative to the child it composes.
 *   - `unknownEdgeTargets` — page `edges:` targets with no corresponding page
 *     index slug, reusing v2's `validateEdgeTargets`.
 */

import { CLI_COMMAND_SLUG_PREFIX } from "../v2/cli-command-store.js";
import { getEdgeIndex, validateEdgeTargets } from "../v2/edge-index.js";
import { getPageIndex } from "../v2/page-index.js";
import { SKILL_SLUG_PREFIX } from "../v2/skill-store.js";
import { getTreeIndex, type TreeIndex } from "./tree-index.js";
import { getNodeMtimeMs } from "./tree-store.js";

/**
 * A `node:` child whose mtime is newer than the parent node that composes it.
 * `node` is the parent, `child` the fresher child, and the two `*MtimeMs`
 * fields are their epoch-ms mtimes (parent < child triggers the report).
 */
export interface StaleIndexEntry {
  node: string;
  child: string;
  nodeMtimeMs: number;
  childMtimeMs: number;
}

/**
 * Read-only health report over the v3 tree + its referenced pages/edges.
 * Every list is sorted for deterministic output; `*Count` fields mirror the
 * corresponding list length so callers can summarize without re-counting.
 */
export interface TreeValidationReport {
  /** `node:`/`page:` children whose target does not exist. */
  danglingChildRefs: Array<{
    node: string;
    ref: string;
    kind: "node" | "page";
  }>;
  danglingChildRefCount: number;
  /** Concept pages not reachable from the root by descending all node children. */
  orphanPages: string[];
  orphanPageCount: number;
  /** Back-edges (`from → to`) closing a cycle during the full DFS descent. */
  cycles: Array<{ from: string; to: string }>;
  cycleCount: number;
  /** Nodes whose mtime predates a child node's mtime. */
  staleIndex: StaleIndexEntry[];
  staleIndexCount: number;
  /** Page `edges:` targets with no corresponding page-index slug. */
  unknownEdgeTargets: Array<{ from: string; to: string }>;
  unknownEdgeTargetCount: number;
}

/** True when a page-index slug is a synthetic (non-concept-page) entry. */
function isSyntheticSlug(slug: string): boolean {
  return (
    slug.startsWith(SKILL_SLUG_PREFIX) ||
    slug.startsWith(CLI_COMMAND_SLUG_PREFIX)
  );
}

/**
 * Collect dangling `node:`/`page:` child refs: every node child whose target
 * node id is absent from `tree.nodes`, and every page child whose slug is
 * absent from `knownPageSlugs`. Sorted by `(node, kind, ref)`.
 */
function collectDanglingChildRefs(
  tree: TreeIndex,
  knownPageSlugs: ReadonlySet<string>,
): Array<{ node: string; ref: string; kind: "node" | "page" }> {
  const dangling: Array<{ node: string; ref: string; kind: "node" | "page" }> =
    [];
  for (const [nodeId, children] of tree.childrenByNode) {
    for (const child of children) {
      const exists =
        child.kind === "node"
          ? tree.nodes.has(child.ref)
          : knownPageSlugs.has(child.ref);
      if (!exists) {
        dangling.push({ node: nodeId, ref: child.ref, kind: child.kind });
      }
    }
  }
  dangling.sort(
    (a, b) =>
      a.node.localeCompare(b.node) ||
      a.kind.localeCompare(b.kind) ||
      a.ref.localeCompare(b.ref),
  );
  return dangling;
}

/**
 * Resolve the existing `node:` children of `nodeId`, in `children` order. Refs
 * to absent nodes are skipped (those are reported separately as dangling) so
 * the descent never recurses into a node that isn't on disk.
 */
function nodeChildrenOf(tree: TreeIndex, nodeId: string): string[] {
  const children = tree.childrenByNode.get(nodeId) ?? [];
  const out: string[] = [];
  for (const child of children) {
    if (child.kind === "node" && tree.nodes.has(child.ref)) {
      out.push(child.ref);
    }
  }
  return out;
}

/**
 * Full DFS over `node:` adjacency. Returns the set of nodes reachable from
 * `tree.root` (for orphan-page reachability) and the back-edges that close a
 * cycle. A back-edge is an edge into a node still on the active recursion stack
 * (classic gray-node cycle detection); `visited` (black) prevents re-walking
 * shared DAG sub-nodes.
 *
 * The walk runs in two phases. The first seeds from the root and records every
 * node it reaches in `reachableNodes`. The second sweeps any node still
 * unvisited — a disconnected component that the root cannot reach — so cycles
 * living entirely outside the root's reach are still reported. Sweep-only nodes
 * are deliberately kept out of `reachableNodes`: they are *not* reachable from
 * the root, and pages hanging off them must still surface as orphans.
 */
function descend(tree: TreeIndex): {
  reachableNodes: Set<string>;
  cycles: Array<{ from: string; to: string }>;
} {
  const reachableNodes = new Set<string>();
  const visited = new Set<string>();
  const cycles: Array<{ from: string; to: string }> = [];

  // Iterative DFS with an explicit stack so deep trees don't blow the call
  // stack. Each frame tracks its child cursor; we push a child frame, and on
  // exhaustion pop the parent off the recursion stack (`onStack`).
  type Frame = { node: string; children: string[]; cursor: number };

  function walkFrom(start: string, trackReachable: boolean): void {
    const onStack = new Set<string>();
    const stack: Frame[] = [];

    function enter(nodeId: string): void {
      visited.add(nodeId);
      if (trackReachable) reachableNodes.add(nodeId);
      onStack.add(nodeId);
      stack.push({
        node: nodeId,
        children: nodeChildrenOf(tree, nodeId),
        cursor: 0,
      });
    }

    enter(start);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame.cursor >= frame.children.length) {
        onStack.delete(frame.node);
        stack.pop();
        continue;
      }
      const child = frame.children[frame.cursor++];
      if (onStack.has(child)) {
        // Edge into an ancestor still on the stack → cycle-closing back-edge.
        cycles.push({ from: frame.node, to: child });
        continue;
      }
      if (visited.has(child)) {
        // Already fully explored (shared DAG sub-node or an earlier sweep).
        continue;
      }
      enter(child);
    }
  }

  if (tree.nodes.has(tree.root)) {
    walkFrom(tree.root, true);
  }

  // Cover nodes the root never reached (disconnected components) so a cycle
  // among them is not silently missed. These are not root-reachable, so their
  // pages stay eligible for the orphan-page report.
  for (const nodeId of tree.nodes.keys()) {
    if (!visited.has(nodeId)) {
      walkFrom(nodeId, false);
    }
  }

  cycles.sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  );
  return { reachableNodes, cycles };
}

/**
 * Concept pages reachable from the tree: every `page:` child of a reachable
 * node. Pages hanging off unreachable nodes are *not* counted reachable — they
 * only become reachable once their parent chain links back to the root.
 */
function reachablePages(
  tree: TreeIndex,
  reachableNodes: ReadonlySet<string>,
): Set<string> {
  const pages = new Set<string>();
  for (const nodeId of reachableNodes) {
    for (const child of tree.childrenByNode.get(nodeId) ?? []) {
      if (child.kind === "page") pages.add(child.ref);
    }
  }
  return pages;
}

/**
 * Nodes whose own mtime predates one of their `node:` children's mtime. A
 * missing node file reads as mtime 0 (oldest), so the check never flags a
 * parent against an absent child. Sorted by `(node, child)`.
 */
async function collectStaleIndex(
  workspaceDir: string,
  tree: TreeIndex,
): Promise<StaleIndexEntry[]> {
  const ids = [...tree.nodes.keys()];
  const mtimes = new Map<string, number>();
  await Promise.all(
    ids.map(async (id) => {
      mtimes.set(id, await getNodeMtimeMs(workspaceDir, id));
    }),
  );

  const stale: StaleIndexEntry[] = [];
  for (const node of ids) {
    const nodeMtimeMs = mtimes.get(node) ?? 0;
    for (const child of nodeChildrenOf(tree, node)) {
      const childMtimeMs = mtimes.get(child) ?? 0;
      if (nodeMtimeMs < childMtimeMs) {
        stale.push({ node, child, nodeMtimeMs, childMtimeMs });
      }
    }
  }
  stale.sort(
    (a, b) => a.node.localeCompare(b.node) || a.child.localeCompare(b.child),
  );
  return stale;
}

/**
 * Validate the hand-authored v3 tree structure for `workspaceDir` and return a
 * {@link TreeValidationReport}. Builds the tree, page, and edge indices, walks
 * the DAG from the root, and reports the five defect categories. Never throws —
 * it is a report, not an assertion.
 */
export async function validateTree(
  workspaceDir: string,
): Promise<TreeValidationReport> {
  const [tree, pageIndex, edgeIndex] = await Promise.all([
    getTreeIndex(workspaceDir),
    getPageIndex(workspaceDir),
    getEdgeIndex(workspaceDir),
  ]);

  const knownPageSlugs = new Set(pageIndex.bySlug.keys());

  // Kick off the stale-index mtime stats up front — it only depends on the
  // tree, not on the DAG walk below — so its filesystem reads overlap the
  // (synchronous) descent rather than running strictly after it.
  const staleIndexPromise = collectStaleIndex(workspaceDir, tree);

  const danglingChildRefs = collectDanglingChildRefs(tree, knownPageSlugs);

  const { reachableNodes, cycles } = descend(tree);

  const reached = reachablePages(tree, reachableNodes);
  const orphanPages = [...knownPageSlugs]
    .filter((slug) => !isSyntheticSlug(slug) && !reached.has(slug))
    .sort();

  const staleIndex = await staleIndexPromise;

  // Edge graph is page-only; knownSlugs is the full page-index slug set so an
  // edge pointing at a skill/CLI entry is not spuriously flagged unknown.
  const unknownEdgeTargets = validateEdgeTargets(
    edgeIndex,
    knownPageSlugs,
  ).missing;

  return {
    danglingChildRefs,
    danglingChildRefCount: danglingChildRefs.length,
    orphanPages,
    orphanPageCount: orphanPages.length,
    cycles,
    cycleCount: cycles.length,
    staleIndex,
    staleIndexCount: staleIndex.length,
    unknownEdgeTargets,
    unknownEdgeTargetCount: unknownEdgeTargets.length,
  };
}
