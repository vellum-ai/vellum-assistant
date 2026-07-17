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

  it("re-prunes a functionality node stranded by truncation", () => {
    const { nodes, edges, truncated } = assembleMemoryGraph({
      entries: [
        entry("hub"),
        entry("h1"),
        entry("h2"),
        entry("h3"),
        entry("p"),
        entry("q"),
        entry("skills/s", { modifiedAt: 0 }),
      ],
      // hub has degree 3; skills/s has degree 2 (p, q). The cap keeps the top 2
      // by degree (hub, skills/s) but drops every one of skills/s's neighbors.
      staticAdjacency: adjacency([
        ["hub", "h1", undefined],
        ["hub", "h2", undefined],
        ["hub", "h3", undefined],
        ["skills/s", "p", undefined],
        ["skills/s", "q", undefined],
      ]),
      maxNodes: 2,
      pruneDisconnectedNonConcepts: true,
    });

    expect(truncated).toBe(true);
    // skills/s survived the cap but lost both neighbors → re-pruned as isolated;
    // the isolated concept hub is kept (concepts always survive).
    expect(nodes.map((n) => n.id)).toEqual(["hub"]);
    expect(edges).toEqual([]);
  });

  it("treats a real page under a reserved prefix as a concept, not a prunable skill", () => {
    // A non-colliding user page like `skills/my-notes` survives the page index
    // with a real mtime; it must classify as a concept (by modifiedAt, not the
    // slug prefix) and therefore never be pruned as a disconnected skill.
    const { nodes } = assembleMemoryGraph({
      entries: [entry("skills/my-notes", { modifiedAt: 5 })],
      staticAdjacency: adjacency([]),
      pruneDisconnectedNonConcepts: true,
    });
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ id: "skills/my-notes", kind: "concept" });
  });
});
