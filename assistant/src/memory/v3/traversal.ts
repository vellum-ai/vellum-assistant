/**
 * Memory v3 — Tree traversal primitives.
 *
 * The *mechanical* half of the v3 read loop: a deterministic, provider-free
 * walk over the {@link TreeIndex} DAG. The intelligence — *which* child nodes
 * to recurse into at each level — is injected via the `descend` callback so
 * this module stays pure and unit-testable without an LLM. The driver PR wires
 * `descend` to the model's descend/skip decision; here `descend` is just a
 * function `(nodeId, children) => chosen node-children`.
 *
 * `walkTree` fans out from a `start` node and any `seeds`, level by level:
 *   - At each node it resolves the ordered child refs, hands them to `descend`,
 *     and recurses into the chosen `node:` children (capped by `breadthBudget`).
 *   - The `page:` children the `descend` decision chooses to *keep* are collected
 *     into the returned `pages` set — pages are leaves, never recursed into. A
 *     page the decision does not keep is dropped, so the walk emits a curated
 *     selection rather than every page it passes.
 *   - A `visited` set keyed by canonical id (`node:<id>`) dedups shared
 *     sub-nodes (the DAG case) and terminates cycles (A ↔ B). A node is walked
 *     at most once regardless of how many parents reference it.
 *   - `maxDepth` bounds how deep the recursion goes; the start/seed level is
 *     depth 0.
 *
 * Each walked node emits one {@link TreeLevel} (the `harness/trace.ts` shape)
 * recording what was considered, descended, and skipped. `reasoning` is
 * supplied by the `descend` callback (the driver attaches the model's stated
 * reason); the mechanical walk defaults it to `""`.
 *
 * Processing is strictly level-by-level so `visited` mutations are never raced:
 * within a level the per-node `descend` calls run concurrently (`Promise.all`),
 * but the chosen children for the *next* level are only dedup'd and enqueued
 * after the whole level resolves.
 */

import type { TreeLevel } from "../v2/harness/trace.js";
import type { ChildRef, TreeIndex } from "./tree-index.js";

/**
 * The decision injected into {@link walkTree}. Given a node id and its ordered
 * child refs, return the *node* children to recurse into and the *page* children
 * to keep for the answer. The driver wires this to the LLM; tests pass a
 * deterministic stub.
 *
 * Returning a `reasoning` string is optional — when present it is threaded into
 * the emitted {@link TreeLevel}; absent, the level's `reasoning` defaults to
 * `""`. Returned `descend` refs that are not `node:` children of `nodeId`, and
 * `keep` refs that are not `page:` children of `nodeId`, are ignored by the walk
 * (it only acts on the distinct children it actually offered).
 */
export type DescendDecision = (
  nodeId: string,
  children: ReadonlyArray<ChildRef>,
) => Promise<DescendResult> | DescendResult;

/**
 * The result of a {@link DescendDecision}. `descend` lists the `node:` children
 * chosen for recursion; `keep` lists the `page:` children to collect into the
 * walk's result; `reasoning` is the optional model rationale recorded on the
 * level.
 */
export interface DescendResult {
  descend: ChildRef[];
  keep: ChildRef[];
  reasoning?: string;
}

/** Options controlling a {@link walkTree} run. */
export interface WalkOptions {
  /** Entry node id; defaults to `tree.root`. */
  start?: string;
  /** Extra node ids to start from in parallel with `start`. */
  seeds?: string[];
  /** Max `node:` children to descend into per node (after the `descend` pick). */
  breadthBudget: number;
  /** Max recursion depth; the start/seed level is depth 0. */
  maxDepth: number;
  /** Injected descend decision (the LLM hook). */
  descend: DescendDecision;
}

/** The result of a {@link walkTree} run. */
export interface WalkResult {
  /** Every `page:` slug the descend decision kept across the walk, dedup'd. */
  pages: Set<string>;
  /** One {@link TreeLevel} per walked node, in walk order. */
  levels: TreeLevel[];
}

/**
 * Resolve the ordered child refs for `nodeId`. Thin accessor over
 * `tree.childrenByNode`; returns an empty array for an unknown / leaf node id so
 * callers never branch on `undefined`.
 */
export function resolveChildren(
  tree: TreeIndex,
  nodeId: string,
): ReadonlyArray<ChildRef> {
  return tree.childrenByNode.get(nodeId) ?? [];
}

/** Canonical visited-set key for a node id. */
function nodeKey(nodeId: string): string {
  return `node:${nodeId}`;
}

/**
 * Walk the {@link TreeIndex} DAG from `start` (default `tree.root`) plus any
 * `seeds`, driven by the injected `descend` decision. Deterministic and
 * provider-free — see the module docstring for the full contract.
 *
 * Returns the collected leaf `pages` and the per-node `levels` trace.
 */
export async function walkTree(
  tree: TreeIndex,
  opts: WalkOptions,
): Promise<WalkResult> {
  const { breadthBudget, maxDepth, descend } = opts;
  const start = opts.start ?? tree.root;

  const pages = new Set<string>();
  const levels: TreeLevel[] = [];
  const visited = new Set<string>();

  // Seed the frontier with `start` + `seeds`, dedup'd and marked visited up
  // front so a node that is both the start and a seed is walked once.
  let frontier: string[] = [];
  for (const id of [start, ...(opts.seeds ?? [])]) {
    const key = nodeKey(id);
    if (visited.has(key)) continue;
    visited.add(key);
    frontier.push(id);
  }

  // Depth 0 is the start/seed level; stop once we'd exceed `maxDepth`.
  for (let depth = 0; depth <= maxDepth && frontier.length > 0; depth++) {
    // Resolve every node on this level concurrently. `visited` is not mutated
    // here — only after the whole level settles — so the concurrency is safe.
    const levelResults = await Promise.all(
      frontier.map(async (nodeId) => {
        const children = resolveChildren(tree, nodeId);
        const result = await descend(nodeId, children);
        return { nodeId, children, result };
      }),
    );

    const nextFrontier: string[] = [];

    for (const { nodeId, children, result } of levelResults) {
      // Collect only the page children the decision chose to keep, filtered to
      // the page children this node actually offered — a decision can't keep a
      // page the node never presented.
      const offeredPageRefs = new Set(
        children.filter((c) => c.kind === "page").map((c) => c.ref),
      );
      for (const choice of result.keep) {
        if (choice.kind === "page" && offeredPageRefs.has(choice.ref)) {
          pages.add(choice.ref);
        }
      }

      // The set of node children this node legitimately offered, in order. The
      // descend pick is intersected with this so a stub returning bogus or
      // duplicate refs can't make the walk recurse into something not offered.
      const offeredNodes = children.filter((c) => c.kind === "node");
      const offeredRefs = new Set(offeredNodes.map((c) => c.ref));

      // Honor the descend pick in the order it was returned, dedup'd, filtered
      // to genuinely-offered node children, skipping nodes already visited
      // elsewhere in the DAG, and capped by `breadthBudget`. Filtering visited
      // nodes *before* the budget check ensures the budget is spent only on
      // nodes the walk will actually descend — an already-visited pick must not
      // consume a slot that an unvisited sibling could use.
      const descended: string[] = [];
      const descendedSet = new Set<string>();
      for (const choice of result.descend) {
        if (choice.kind !== "node") continue;
        if (!offeredRefs.has(choice.ref)) continue;
        if (descendedSet.has(choice.ref)) continue;
        if (visited.has(nodeKey(choice.ref))) continue;
        if (descended.length >= breadthBudget) break;
        descendedSet.add(choice.ref);
        descended.push(choice.ref);
      }

      const considered = offeredNodes.map((c) => c.ref);
      const skipped = considered.filter((ref) => !descendedSet.has(ref));

      levels.push({
        node: nodeId,
        considered,
        descended,
        skipped,
        reasoning: result.reasoning ?? "",
      });

      // Enqueue chosen node children for the next level. Mark visited now (the
      // level has fully resolved) so a shared sub-node or a cycle is enqueued at
      // most once across the whole walk.
      for (const ref of descended) {
        const key = nodeKey(ref);
        if (visited.has(key)) continue;
        visited.add(key);
        nextFrontier.push(ref);
      }
    }

    frontier = nextFrontier;
  }

  return { pages, levels };
}
