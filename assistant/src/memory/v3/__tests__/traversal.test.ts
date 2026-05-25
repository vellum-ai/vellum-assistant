/**
 * Tests for `assistant/src/memory/v3/traversal.ts`.
 *
 * Provider-free: `descend` is always a deterministic stub. Coverage:
 *   - resolveChildren is a thin accessor (known node / leaf / unknown id).
 *   - linear descent collects the expected leaf pages and emits a TreeLevel per
 *     walked node in walk order.
 *   - a DAG (sub-node shared by two parents) is walked exactly once.
 *   - an injected cycle (A ↔ B) terminates.
 *   - breadthBudget caps the descents per level.
 *   - maxDepth halts the recursion at the right level.
 *   - seeds start the walk mid-tree (alongside / instead of the root).
 *   - reasoning from the descend result is threaded onto the level; defaults
 *     to "" when omitted.
 *
 * Fixtures are plain in-memory `TreeIndex` objects — no disk, no workspace.
 */

import { describe, expect, test } from "bun:test";

import type { DescendResult } from "../traversal.js";
import { resolveChildren, walkTree } from "../traversal.js";
import type { ChildRef, TreeIndex } from "../tree-index.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function page(ref: string): ChildRef {
  return { kind: "page", ref };
}

function node(ref: string): ChildRef {
  return { kind: "node", ref };
}

/**
 * Build a minimal in-memory `TreeIndex` from a forward-adjacency spec. Only
 * `childrenByNode` and `root` are exercised by the traversal, so the reverse
 * adjacency maps and `nodes` are left empty — the walk never reads them.
 */
function makeTree(
  root: string,
  childrenByNode: Record<string, ChildRef[]>,
): TreeIndex {
  return {
    nodes: new Map(),
    childrenByNode: new Map(Object.entries(childrenByNode)),
    parentsByNode: new Map(),
    pageParents: new Map(),
    root,
  };
}

/** Descend into every node child offered (mechanical "descend all" stub). */
function descendAll(
  _nodeId: string,
  children: ReadonlyArray<ChildRef>,
): DescendResult {
  return { descend: children.filter((c) => c.kind === "node") };
}

// ---------------------------------------------------------------------------
// resolveChildren
// ---------------------------------------------------------------------------

describe("resolveChildren", () => {
  test("returns the ordered child refs for a known node", () => {
    const tree = makeTree("_root", {
      _root: [node("a"), page("p")],
    });
    expect(resolveChildren(tree, "_root")).toEqual([node("a"), page("p")]);
  });

  test("returns [] for a leaf / unknown node id", () => {
    const tree = makeTree("_root", { _root: [] });
    expect(resolveChildren(tree, "missing")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Linear descent
// ---------------------------------------------------------------------------

describe("walkTree — linear descent", () => {
  test("collects expected leaf pages and emits a level per walked node", async () => {
    // _root → node:a → node:b → page:leaf  (plus a page on each level)
    const tree = makeTree("_root", {
      _root: [page("p-root"), node("a")],
      a: [page("p-a"), node("b")],
      b: [page("leaf")],
    });

    const { pages, levels } = await walkTree(tree, {
      breadthBudget: 8,
      maxDepth: 8,
      descend: descendAll,
    });

    expect([...pages].sort()).toEqual(["leaf", "p-a", "p-root"]);
    expect(levels.map((l) => l.node)).toEqual(["_root", "a", "b"]);

    expect(levels[0]).toMatchObject({
      node: "_root",
      considered: ["a"],
      descended: ["a"],
      skipped: [],
      reasoning: "",
    });
    expect(levels[2]).toMatchObject({
      node: "b",
      considered: [],
      descended: [],
      skipped: [],
    });
  });

  test("defaults start to tree.root", async () => {
    const tree = makeTree("home", {
      home: [page("only")],
    });
    const { pages, levels } = await walkTree(tree, {
      breadthBudget: 4,
      maxDepth: 4,
      descend: descendAll,
    });
    expect([...pages]).toEqual(["only"]);
    expect(levels.map((l) => l.node)).toEqual(["home"]);
  });
});

// ---------------------------------------------------------------------------
// DAG dedup
// ---------------------------------------------------------------------------

describe("walkTree — DAG dedup", () => {
  test("a sub-node shared by two parents is walked exactly once", async () => {
    // _root → {node:left, node:right}; both → node:shared → page:s
    const tree = makeTree("_root", {
      _root: [node("left"), node("right")],
      left: [node("shared")],
      right: [node("shared")],
      shared: [page("s")],
    });

    const { pages, levels } = await walkTree(tree, {
      breadthBudget: 8,
      maxDepth: 8,
      descend: descendAll,
    });

    expect([...pages]).toEqual(["s"]);
    // `shared` appears once even though both left and right descend into it.
    const walked = levels.map((l) => l.node);
    expect(walked.filter((n) => n === "shared")).toHaveLength(1);
    expect(walked.sort()).toEqual(["_root", "left", "right", "shared"]);
  });
});

// ---------------------------------------------------------------------------
// Cycle termination
// ---------------------------------------------------------------------------

describe("walkTree — cycle termination", () => {
  test("an injected A ↔ B cycle terminates and walks each once", async () => {
    const tree = makeTree("a", {
      a: [node("b"), page("pa")],
      b: [node("a"), page("pb")],
    });

    const { pages, levels } = await walkTree(tree, {
      breadthBudget: 8,
      maxDepth: 100,
      descend: descendAll,
    });

    expect([...pages].sort()).toEqual(["pa", "pb"]);
    const walked = levels.map((l) => l.node).sort();
    expect(walked).toEqual(["a", "b"]);
  });

  test("a self-loop terminates", async () => {
    const tree = makeTree("solo", {
      solo: [node("solo"), page("p")],
    });
    const { pages, levels } = await walkTree(tree, {
      breadthBudget: 4,
      maxDepth: 100,
      descend: descendAll,
    });
    expect([...pages]).toEqual(["p"]);
    expect(levels.map((l) => l.node)).toEqual(["solo"]);
  });
});

// ---------------------------------------------------------------------------
// Breadth budget
// ---------------------------------------------------------------------------

describe("walkTree — breadthBudget", () => {
  test("caps the descents per node and records the rest as skipped", async () => {
    const tree = makeTree("_root", {
      _root: [node("a"), node("b"), node("c"), node("d")],
      a: [page("pa")],
      b: [page("pb")],
      c: [page("pc")],
      d: [page("pd")],
    });

    const { pages, levels } = await walkTree(tree, {
      breadthBudget: 2,
      maxDepth: 8,
      descend: descendAll,
    });

    const rootLevel = levels.find((l) => l.node === "_root")!;
    expect(rootLevel.considered).toEqual(["a", "b", "c", "d"]);
    expect(rootLevel.descended).toEqual(["a", "b"]);
    expect(rootLevel.skipped).toEqual(["c", "d"]);

    // Only the first two children's pages are reached.
    expect([...pages].sort()).toEqual(["pa", "pb"]);
    expect(levels.map((l) => l.node).sort()).toEqual(["_root", "a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// Depth budget
// ---------------------------------------------------------------------------

describe("walkTree — maxDepth", () => {
  test("halts recursion at the configured depth", async () => {
    // _root(0) → a(1) → b(2) → c(3)
    const tree = makeTree("_root", {
      _root: [node("a")],
      a: [node("b"), page("pa")],
      b: [node("c"), page("pb")],
      c: [page("pc")],
    });

    // maxDepth 1 walks depth 0 (_root) and depth 1 (a) only; b/c never walked.
    const { pages, levels } = await walkTree(tree, {
      breadthBudget: 8,
      maxDepth: 1,
      descend: descendAll,
    });

    expect(levels.map((l) => l.node)).toEqual(["_root", "a"]);
    // `a`'s page is collected; b/c and their pages are not reached.
    expect([...pages]).toEqual(["pa"]);
  });

  test("maxDepth 0 walks only the start level", async () => {
    const tree = makeTree("_root", {
      _root: [node("a"), page("pr")],
      a: [page("pa")],
    });
    const { pages, levels } = await walkTree(tree, {
      breadthBudget: 8,
      maxDepth: 0,
      descend: descendAll,
    });
    expect(levels.map((l) => l.node)).toEqual(["_root"]);
    expect([...pages]).toEqual(["pr"]);
  });
});

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

describe("walkTree — seeds", () => {
  test("seeds start the walk mid-tree alongside start", async () => {
    const tree = makeTree("_root", {
      _root: [node("a"), page("pr")],
      a: [page("pa")],
      mid: [page("pm"), node("deep")],
      deep: [page("pd")],
    });

    const { pages, levels } = await walkTree(tree, {
      seeds: ["mid"],
      breadthBudget: 8,
      maxDepth: 8,
      descend: descendAll,
    });

    // Both the root branch and the seeded `mid` subtree are explored.
    expect([...pages].sort()).toEqual(["pa", "pd", "pm", "pr"]);
    expect(levels.map((l) => l.node).sort()).toEqual([
      "_root",
      "a",
      "deep",
      "mid",
    ]);
  });

  test("a node that is both start and seed is walked once", async () => {
    const tree = makeTree("dup", {
      dup: [page("p")],
    });
    const { levels } = await walkTree(tree, {
      start: "dup",
      seeds: ["dup"],
      breadthBudget: 4,
      maxDepth: 4,
      descend: descendAll,
    });
    expect(levels.map((l) => l.node)).toEqual(["dup"]);
  });
});

// ---------------------------------------------------------------------------
// Descend decision threading
// ---------------------------------------------------------------------------

describe("walkTree — descend decision", () => {
  test("threads the descend reasoning onto the level", async () => {
    const tree = makeTree("_root", {
      _root: [node("a"), node("b")],
      a: [page("pa")],
      b: [page("pb")],
    });

    const descend = (
      _nodeId: string,
      children: ReadonlyArray<ChildRef>,
    ): DescendResult => ({
      // Pick only "a".
      descend: children.filter((c) => c.kind === "node" && c.ref === "a"),
      reasoning: "a is more relevant",
    });

    const { pages, levels } = await walkTree(tree, {
      breadthBudget: 8,
      maxDepth: 8,
      descend,
    });

    const rootLevel = levels.find((l) => l.node === "_root")!;
    expect(rootLevel.reasoning).toBe("a is more relevant");
    expect(rootLevel.descended).toEqual(["a"]);
    expect(rootLevel.skipped).toEqual(["b"]);
    expect([...pages]).toEqual(["pa"]);
  });

  test("ignores descend picks that were not offered node children", async () => {
    const tree = makeTree("_root", {
      _root: [node("a"), page("pr")],
      a: [page("pa")],
    });

    const descend = (): DescendResult => ({
      // "ghost" was never offered; "pr" is a page, not a node child.
      descend: [node("ghost"), page("pr")],
    });

    const { pages, levels } = await walkTree(tree, {
      breadthBudget: 8,
      maxDepth: 8,
      descend,
    });

    const rootLevel = levels.find((l) => l.node === "_root")!;
    expect(rootLevel.considered).toEqual(["a"]);
    expect(rootLevel.descended).toEqual([]);
    expect(rootLevel.skipped).toEqual(["a"]);
    // No node descent happened; only the root's own page is collected.
    expect([...pages]).toEqual(["pr"]);
    expect(levels.map((l) => l.node)).toEqual(["_root"]);
  });

  test("dedups repeated descend picks before applying breadthBudget", async () => {
    const tree = makeTree("_root", {
      _root: [node("a"), node("b")],
      a: [page("pa")],
      b: [page("pb")],
    });

    const descend = (): DescendResult => ({
      // "a" repeated should count once; budget of 2 then still admits "b".
      descend: [node("a"), node("a"), node("b")],
    });

    const { levels } = await walkTree(tree, {
      breadthBudget: 2,
      maxDepth: 8,
      descend,
    });

    const rootLevel = levels.find((l) => l.node === "_root")!;
    expect(rootLevel.descended).toEqual(["a", "b"]);
    expect(rootLevel.skipped).toEqual([]);
  });
});
