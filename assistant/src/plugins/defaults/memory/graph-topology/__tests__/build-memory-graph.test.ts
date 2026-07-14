import { describe, expect, it } from "bun:test";

import type { PageIndexEntry } from "../../v2/page-index.js";
import type { Slug } from "../../v3/types.js";
import { assembleMemoryGraph } from "../build-memory-graph.js";

function entry(
  slug: string,
  over: Partial<PageIndexEntry> = {},
): PageIndexEntry {
  return {
    id: 0,
    slug,
    summary: "",
    edges: [],
    leaves: [],
    modifiedAt: 1,
    ...over,
  };
}

/** Build an adjacency map from `[source, target, description?]` triples. */
function adjacency(
  triples: Array<[string, string, (string | undefined)?]>,
): Map<Slug, Map<Slug, string | undefined>> {
  const map = new Map<Slug, Map<Slug, string | undefined>>();
  for (const [source, target, description] of triples) {
    let out = map.get(source);
    if (!out) {
      out = new Map();
      map.set(source, out);
    }
    out.set(target, description);
  }
  return map;
}

describe("assembleMemoryGraph", () => {
  it("maps entries to nodes with kind, humanized label, and degree weight", () => {
    const { nodes } = assembleMemoryGraph({
      entries: [
        entry("my-concept", { summary: "a concept", modifiedAt: 42 }),
        entry("skills/agent-mail", { modifiedAt: 0 }),
        entry("send-email", { modifiedAt: 0 }),
      ],
      staticAdjacency: adjacency([
        ["my-concept", "skills/agent-mail", undefined],
      ]),
    });

    const byId = new Map(nodes.map((n) => [n.id, n]));
    expect(byId.get("my-concept")).toMatchObject({
      label: "My Concept",
      kind: "concept",
      summary: "a concept",
      updatedAtMs: 42,
      weight: 1,
    });
    // slugs/ prefix → skill kind, label is the last segment humanized.
    expect(byId.get("skills/agent-mail")).toMatchObject({
      label: "Agent Mail",
      kind: "skill",
      weight: 1,
    });
    // synthetic (modifiedAt 0) non-skill → capability, no updatedAtMs, degree 0.
    const capability = byId.get("send-email");
    expect(capability?.kind).toBe("capability");
    expect(capability?.updatedAtMs).toBeUndefined();
    expect(capability?.weight).toBe(0);
  });

  it("emits static edges directed and carries the curated description", () => {
    const { edges } = assembleMemoryGraph({
      entries: [entry("a"), entry("b")],
      staticAdjacency: adjacency([["a", "b", "why they link"]]),
    });
    expect(edges).toEqual([
      {
        source: "a",
        target: "b",
        kind: "link",
        directed: true,
        description: "why they link",
      },
    ]);
  });

  it("drops edges whose endpoints are not nodes", () => {
    const { edges } = assembleMemoryGraph({
      entries: [entry("a")],
      staticAdjacency: adjacency([["a", "ghost", undefined]]),
    });
    expect(edges).toEqual([]);
  });

  it("emits learned edges undirected, deduped against static and themselves", () => {
    const { edges } = assembleMemoryGraph({
      entries: [entry("a"), entry("b"), entry("c")],
      staticAdjacency: adjacency([["a", "b", undefined]]),
      // b→a duplicates the static a–b pair (dropped); a↔c is symmetric (one edge).
      learnedAdjacency: adjacency([
        ["b", "a", undefined],
        ["a", "c", undefined],
        ["c", "a", undefined],
      ]),
    });

    const learned = edges.filter((e) => e.kind === "learned");
    expect(learned).toEqual([
      { source: "a", target: "c", kind: "learned", directed: false },
    ]);
  });

  it("caps nodes by degree and drops dangling edges when over the limit", () => {
    const { nodes, edges, truncated } = assembleMemoryGraph({
      entries: [entry("hub"), entry("x"), entry("y"), entry("lonely")],
      // hub connects to x and y (degree 2); lonely has degree 0.
      staticAdjacency: adjacency([
        ["hub", "x", undefined],
        ["hub", "y", undefined],
      ]),
      maxNodes: 3,
    });

    expect(truncated).toBe(true);
    expect(nodes).toHaveLength(3);
    // lonely (degree 0) is the one dropped; hub/x/y survive.
    expect(nodes.map((n) => n.id).sort()).toEqual(["hub", "x", "y"]);
    // all surviving edges reference kept nodes.
    for (const edge of edges) {
      expect(nodes.some((n) => n.id === edge.source)).toBe(true);
      expect(nodes.some((n) => n.id === edge.target)).toBe(true);
    }
  });

  it("prunes disconnected functionality nodes but keeps connected ones and all concepts", () => {
    const { nodes } = assembleMemoryGraph({
      entries: [
        entry("lonely-concept"), // concept, degree 0 → kept
        entry("linked-concept"), // concept, links to a skill
        entry("skills/connected", { modifiedAt: 0 }), // skill, degree 1 → kept
        entry("skills/orphan", { modifiedAt: 0 }), // skill, degree 0 → pruned
        entry("cli-commands/orphan", { modifiedAt: 0 }), // capability, degree 0 → pruned
      ],
      staticAdjacency: adjacency([
        ["linked-concept", "skills/connected", undefined],
      ]),
      pruneDisconnectedNonConcepts: true,
    });

    expect(nodes.map((n) => n.id).sort()).toEqual([
      "linked-concept",
      "lonely-concept",
      "skills/connected",
    ]);
  });

  it("keeps disconnected functionality nodes when pruning is off (default)", () => {
    const { nodes } = assembleMemoryGraph({
      entries: [entry("a"), entry("skills/orphan", { modifiedAt: 0 })],
      staticAdjacency: adjacency([]),
    });
    expect(nodes.map((n) => n.id).sort()).toEqual(["a", "skills/orphan"]);
  });
});
