/**
 * Tests for `assistant/src/memory/v3/index-composition.ts`.
 *
 * `composeNodeIndex` is a pure function over an already-built `TreeIndex` and
 * `PageIndex`, so these tests hand-build both fixtures (no filesystem / no I/O)
 * and assert on the rendered string.
 *
 * Coverage matrix:
 *   - mixed node:/page: children render one summary line each, in authored
 *     order, with the node's routing hints appended as a trailer.
 *   - a `page:` ref whose slug is absent from the index is silently omitted.
 *   - a `node:` ref whose id is absent from the tree is silently omitted.
 *   - empty / missing children → just the routing hints, or the empty string
 *     when there are none either.
 *   - a `node:` child with no summary falls back to the first non-empty body
 *     line; with neither, only its header is emitted.
 */

import { describe, expect, test } from "bun:test";

import type { PageIndex, PageIndexEntry } from "../../v2/page-index.js";
import { composeNodeIndex } from "../index-composition.js";
import type { ChildRef, TreeIndex } from "../tree-index.js";
import type { TreeNode } from "../types.js";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function treeNode(
  id: string,
  opts: { summary?: string; routing_hints?: string; body?: string } = {},
): TreeNode {
  return {
    id,
    frontmatter: {
      children: [],
      summary: opts.summary,
      routing_hints: opts.routing_hints,
    },
    body: opts.body ?? "",
  };
}

/**
 * Build a `TreeIndex` from a list of nodes and an explicit child-ref list for
 * the node under test. Only the fields `composeNodeIndex` reads (`nodes`,
 * `childrenByNode`) are populated; the reverse-adjacency maps are left empty.
 */
function treeIndex(
  nodes: TreeNode[],
  childrenByNode: Record<string, ChildRef[]>,
): TreeIndex {
  return {
    nodes: new Map(nodes.map((n) => [n.id, n])),
    childrenByNode: new Map(Object.entries(childrenByNode)),
    parentsByNode: new Map(),
    pageParents: new Map(),
    root: "_root",
  };
}

function pageEntry(slug: string, summary: string): PageIndexEntry {
  return { id: 1, slug, summary, edges: [], modifiedAt: 0 };
}

function pageIndex(entries: PageIndexEntry[]): PageIndex {
  return {
    entries,
    bySlug: new Map(entries.map((e) => [e.slug, e])),
    byId: new Map(entries.map((e) => [e.id, e])),
    rendered: "",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("composeNodeIndex", () => {
  test("composes mixed node:/page: children in authored order with routing hints", () => {
    const tree = treeIndex(
      [
        treeNode("people", {
          summary: "People you know",
          routing_hints: "for work contacts see node:colleagues",
        }),
        treeNode("colleagues", { summary: "Work relationships" }),
      ],
      {
        people: [
          { kind: "node", ref: "colleagues" },
          { kind: "page", ref: "alice" },
        ],
      },
    );
    const pages = pageIndex([
      pageEntry("alice", "Alice — neighbor and friend"),
    ]);

    const block = composeNodeIndex("people", tree, pages);

    expect(block).toBe(
      [
        "[node:colleagues] Work relationships",
        "[page:alice] Alice — neighbor and friend",
        "Routing hints: for work contacts see node:colleagues",
      ].join("\n"),
    );
  });

  test("emits children in authored order regardless of map insertion", () => {
    const tree = treeIndex(
      [treeNode("a", { summary: "Node A" }), treeNode("root", {})],
      {
        root: [
          { kind: "page", ref: "zeta" },
          { kind: "node", ref: "a" },
          { kind: "page", ref: "beta" },
        ],
      },
    );
    const pages = pageIndex([
      pageEntry("beta", "Beta page"),
      pageEntry("zeta", "Zeta page"),
    ]);

    const block = composeNodeIndex("root", tree, pages);

    expect(block).toBe(
      [
        "[page:zeta] Zeta page",
        "[node:a] Node A",
        "[page:beta] Beta page",
      ].join("\n"),
    );
  });

  test("silently omits a page ref absent from the index", () => {
    const tree = treeIndex([treeNode("root", {})], {
      root: [
        { kind: "page", ref: "present" },
        { kind: "page", ref: "missing" },
      ],
    });
    const pages = pageIndex([pageEntry("present", "I exist")]);

    const block = composeNodeIndex("root", tree, pages);

    expect(block).toBe("[page:present] I exist");
  });

  test("silently omits a node ref absent from the tree", () => {
    const tree = treeIndex([treeNode("present", { summary: "Here" })], {
      root: [
        { kind: "node", ref: "present" },
        { kind: "node", ref: "ghost" },
      ],
    });
    const pages = pageIndex([]);

    const block = composeNodeIndex("root", tree, pages);

    expect(block).toBe("[node:present] Here");
  });

  test("empty children → just the routing hints", () => {
    const tree = treeIndex(
      [treeNode("leaf", { routing_hints: "this is a leaf branch" })],
      { leaf: [] },
    );

    const block = composeNodeIndex("leaf", tree, pageIndex([]));

    expect(block).toBe("Routing hints: this is a leaf branch");
  });

  test("no children and no routing hints → empty string", () => {
    const tree = treeIndex([treeNode("bare", {})], { bare: [] });

    expect(composeNodeIndex("bare", tree, pageIndex([]))).toBe("");
  });

  test("node with no childrenByNode entry composes from routing hints alone", () => {
    const tree = treeIndex(
      [treeNode("orphan", { routing_hints: "hint only" })],
      {},
    );

    expect(composeNodeIndex("orphan", tree, pageIndex([]))).toBe(
      "Routing hints: hint only",
    );
  });

  test("node child with no summary falls back to first non-empty body line", () => {
    const tree = treeIndex(
      [
        treeNode("root", {}),
        treeNode("bodyonly", {
          body: "\n  \nFirst real line\nSecond line",
        }),
      ],
      { root: [{ kind: "node", ref: "bodyonly" }] },
    );

    const block = composeNodeIndex("root", tree, pageIndex([]));

    expect(block).toBe("[node:bodyonly] First real line");
  });

  test("node child with empty summary string falls back to body line", () => {
    const tree = treeIndex(
      [
        treeNode("root", {}),
        treeNode("blank", { summary: "   ", body: "fallback line" }),
      ],
      { root: [{ kind: "node", ref: "blank" }] },
    );

    expect(composeNodeIndex("root", tree, pageIndex([]))).toBe(
      "[node:blank] fallback line",
    );
  });

  test("node child with neither summary nor body emits only its header", () => {
    const tree = treeIndex(
      [treeNode("root", {}), treeNode("empty", { body: "   \n\t" })],
      { root: [{ kind: "node", ref: "empty" }] },
    );

    expect(composeNodeIndex("root", tree, pageIndex([]))).toBe("[node:empty]");
  });
});
