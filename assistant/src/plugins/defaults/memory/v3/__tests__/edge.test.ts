import { describe, expect, test } from "bun:test";

import type { PageIndexEntry } from "../../v2/page-index.js";
import { buildEdgeGraph, edgeExpand } from "../edge.js";
import type { Slug } from "../types.js";

/** Minimal page-index entry factory — only the fields the edge lane reads. */
function entry(id: number, slug: Slug, edges: number[] = []): PageIndexEntry {
  return { id, slug, summary: "", edges, leaves: [], modifiedAt: 0 };
}

/** Build a raw-page reader from a fixture map; missing slugs read as "". */
function rawReader(pages: Record<string, string>) {
  return async (slug: Slug): Promise<string> => pages[slug] ?? "";
}

/** Frontmatter helper: wrap a `links:` list around an optional body. */
function withLinks(links: string[], body = "body"): string {
  const block = links.map((l) => `  - "${l}"`).join("\n");
  return `---\ntitle: x\nlinks:\n${block}\n---\n\n${body}`;
}

describe("buildEdgeGraph — links: frontmatter", () => {
  test("parses target + description split on the first ' — '", async () => {
    const articles = [entry(1, "page-a"), entry(2, "page-b")];
    const graph = await buildEdgeGraph(
      articles,
      rawReader({
        "page-a": withLinks(["page-b — the b page — with an extra dash"]),
        "page-b": "no frontmatter",
      }),
    );
    const out = graph.adjacency.get("page-a")!;
    // Split on the FIRST ' — ' only: description keeps the trailing dash text.
    expect(out.get("page-b")).toBe("the b page — with an extra dash");
  });

  test("drops unknown/dangling link targets", async () => {
    const articles = [entry(1, "page-a"), entry(2, "page-b")];
    const graph = await buildEdgeGraph(
      articles,
      rawReader({
        "page-a": withLinks([
          "page-b — known target",
          "page-ghost — dangling target not in corpus",
        ]),
      }),
    );
    const out = graph.adjacency.get("page-a")!;
    expect(out.has("page-b")).toBe(true);
    expect(out.has("page-ghost")).toBe(false);
    expect([...out.keys()]).toEqual(["page-b"]);
  });

  test("a page with no links: falls back to wikilinks and numeric edges", async () => {
    const articles = [
      entry(1, "page-a", [2]), // numeric edge → page-b
      entry(2, "page-b"),
      entry(3, "topic-x"),
    ];
    const graph = await buildEdgeGraph(
      articles,
      rawReader({
        // No links: frontmatter; body has an inline wikilink to topic-x.
        "page-a": "plain body referencing [[topic-x]] inline",
      }),
    );
    const out = graph.adjacency.get("page-a")!;
    expect(out.has("page-b")).toBe(true); // from numeric edge
    expect(out.has("topic-x")).toBe(true); // from wikilink
    // No curated descriptions on wikilink/numeric edges.
    expect(out.get("page-b")).toBeUndefined();
    expect(out.get("topic-x")).toBeUndefined();
  });
});

describe("buildEdgeGraph — three-source union", () => {
  test("links ∪ wikilinks ∪ numeric edges merge into one adjacency map", async () => {
    const articles = [
      entry(1, "page-a", [4]), // numeric edge → topic-y
      entry(2, "page-b"),
      entry(3, "topic-x"),
      entry(4, "topic-y"),
    ];
    const graph = await buildEdgeGraph(
      articles,
      rawReader({
        "page-a": withLinks(
          ["page-b — authored neighbour"],
          "and a [[topic-x]] wikilink in the body",
        ),
      }),
    );
    const out = graph.adjacency.get("page-a")!;
    expect(new Set(out.keys())).toEqual(
      new Set(["page-b", "topic-x", "topic-y"]),
    );
    expect(out.get("page-b")).toBe("authored neighbour"); // from links
    expect(out.get("topic-x")).toBeUndefined(); // from wikilink
    expect(out.get("topic-y")).toBeUndefined(); // from numeric edge
  });

  test("read failure still keeps numeric-edge fallback", async () => {
    const articles = [entry(1, "page-a", [2]), entry(2, "page-b")];
    const graph = await buildEdgeGraph(articles, async () => {
      throw new Error("read failed");
    });
    const out = graph.adjacency.get("page-a")!;
    expect(out.has("page-b")).toBe(true);
  });
});

describe("buildEdgeGraph — hubs", () => {
  test("marks articles with in-degree > hubDegree as hubs", async () => {
    // hub receives 3 inbound edges; with hubDegree=2 it is a hub.
    const articles = [
      entry(1, "page-a"),
      entry(2, "page-b"),
      entry(3, "page-c"),
      entry(4, "hub"),
    ];
    const graph = await buildEdgeGraph(
      articles,
      rawReader({
        "page-a": withLinks(["hub — to hub"]),
        "page-b": withLinks(["hub — to hub"]),
        "page-c": withLinks(["hub — to hub"]),
      }),
      { hubDegree: 2 },
    );
    expect(graph.hubs.has("hub")).toBe(true);
    expect(graph.hubs.has("page-a")).toBe(false);
  });
});

describe("edgeExpand", () => {
  /** Build a star/chain graph: page-a → b,c,d,e,f,g ; topic-x → b. */
  async function fixtureGraph(hubDegree = 30) {
    const articles = [
      entry(1, "page-a"),
      entry(2, "page-b"),
      entry(3, "page-c"),
      entry(4, "page-d"),
      entry(5, "page-e"),
      entry(6, "page-f"),
      entry(7, "page-g"),
      entry(8, "topic-x"),
    ];
    return buildEdgeGraph(
      articles,
      rawReader({
        "page-a": withLinks([
          "page-b — neighbour b",
          "page-c — neighbour c",
          "page-d — neighbour d",
          "page-e — neighbour e",
          "page-f — neighbour f",
          "page-g — neighbour g",
        ]),
        "topic-x": withLinks(["page-b — also to b"]),
      }),
      { hubDegree },
    );
  }

  test("carries the curated links description through expansion", async () => {
    const graph = await fixtureGraph();
    const out = edgeExpand(graph, ["page-a"]);
    const b = out.find((n) => n.article === "page-b");
    expect(b?.description).toBe("neighbour b");
  });

  test("respects perSeed", async () => {
    const graph = await fixtureGraph();
    const out = edgeExpand(graph, ["page-a"], { perSeed: 2 });
    expect(out).toHaveLength(2);
    expect(out.map((n) => n.article)).toEqual(["page-b", "page-c"]);
  });

  test("respects cap across seeds", async () => {
    const graph = await fixtureGraph();
    // Two seeds each could add many; cap=3 truncates the total.
    const out = edgeExpand(graph, ["page-a", "topic-x"], {
      perSeed: 6,
      cap: 3,
    });
    expect(out).toHaveLength(3);
  });

  test("respects seedCount (only top-N seeds expanded)", async () => {
    // seedCount=1: only the first seed expands; the second seed's unique
    // neighbour is never reached.
    const articles = [
      entry(1, "seed-1"),
      entry(2, "seed-2"),
      entry(3, "only-via-2"),
      entry(4, "via-1"),
    ];
    const g = await buildEdgeGraph(
      articles,
      rawReader({
        "seed-1": withLinks(["via-1 — x"]),
        "seed-2": withLinks(["only-via-2 — y"]),
      }),
    );
    const out = edgeExpand(g, ["seed-1", "seed-2"], { seedCount: 1 });
    expect(out.map((n) => n.article)).toEqual(["via-1"]);
    expect(out.find((n) => n.article === "only-via-2")).toBeUndefined();
  });

  test("excludes hub neighbours from expansion", async () => {
    // page-b has in-degree 2 (page-a + topic-x). At the default threshold it
    // is not a hub; lowering hubDegree below 2 makes it one.
    const nonHubGraph = await fixtureGraph();
    expect(nonHubGraph.hubs.has("page-b")).toBe(false);

    const hubGraph = await fixtureGraph(1); // page-b in-degree 2 > 1 → hub
    expect(hubGraph.hubs.has("page-b")).toBe(true);
    const out = edgeExpand(hubGraph, ["page-a"]);
    expect(out.find((n) => n.article === "page-b")).toBeUndefined();
    // non-hub neighbours still surface
    expect(out.find((n) => n.article === "page-c")).toBeDefined();
  });

  test("respects the alive predicate", async () => {
    const graph = await fixtureGraph();
    const out = edgeExpand(graph, ["page-a"], {
      alive: (slug) => slug !== "page-c",
    });
    expect(out.find((n) => n.article === "page-c")).toBeUndefined();
    expect(out.find((n) => n.article === "page-b")).toBeDefined();
  });

  test("does not surface the seeds themselves", async () => {
    const articles = [entry(1, "page-a"), entry(2, "page-b")];
    const graph = await buildEdgeGraph(
      articles,
      rawReader({
        "page-a": withLinks(["page-b — to b"]),
        "page-b": withLinks(["page-a — back to a"]),
      }),
    );
    const out = edgeExpand(graph, ["page-a", "page-b"]);
    // page-a and page-b are both seeds; neither should be surfaced.
    expect(out).toHaveLength(0);
  });
});
