import { describe, expect, test } from "bun:test";

import { computeV3Health, renderV3Health } from "../health.js";
import type { LeafNode, LeafPath, LeafTree, Slug } from "../types.js";

/** Build an in-memory leaf node with the given members. */
function leaf(path: LeafPath, members: Slug[]): LeafNode {
  return {
    path,
    frontmatter: { path, in_core: false },
    description: "",
    members: [...members],
    domain: path.split("/")[0],
  };
}

/**
 * Build a {@link LeafTree} from `{ leafPath: members[] }`. `byPage` is the
 * inverted membership map, matching what `loadLeafTree` produces.
 */
function tree(spec: Record<LeafPath, Slug[]>): LeafTree {
  const leaves = new Map<LeafPath, LeafNode>();
  const byPage = new Map<Slug, LeafPath[]>();
  for (const [path, members] of Object.entries(spec)) {
    leaves.set(path, leaf(path, members));
    for (const slug of members) {
      const existing = byPage.get(slug);
      if (existing) existing.push(path);
      else byPage.set(slug, [path]);
    }
  }
  return { leaves, byPage };
}

describe("computeV3Health", () => {
  test("flags unassigned slugs (in neither byPage nor a leaf)", () => {
    const t = tree({ "domain-a/topic-x": ["page-a"] });
    const report = computeV3Health({
      tree: t,
      allSlugs: ["page-a", "page-b", "page-c"],
    });
    expect(report.unassigned).toEqual(["page-b", "page-c"]);
  });

  test("excludes synthetic capability slugs from unassigned / novel clusters", () => {
    const t = tree({ "domain-a/topic-x": ["page-a"] });
    const report = computeV3Health({
      tree: t,
      allSlugs: ["page-a", "page-b", "cli-commands/example", "skills/example"],
    });
    // Capability slugs are handled by the always-on capabilities leaf (injected
    // into the live lane tree, absent here), not the persisted tree — so they must
    // not be reported as unassigned or grouped into novel clusters. page-b is the
    // one real unassigned concept page.
    expect(report.unassigned).toEqual(["page-b"]);
    expect(report.novelClusters).toEqual([
      { prefix: "page-b", slugs: ["page-b"], count: 1 },
    ]);
  });

  test("flags dangling page refs pointing at missing leaves", () => {
    const t = tree({ "domain-a/topic-x": ["page-a"] });
    const report = computeV3Health({
      tree: t,
      allSlugs: ["page-a", "page-b"],
      pageRefs: new Map([
        ["page-a", ["domain-a/topic-x"]],
        ["page-b", ["domain-a/topic-missing"]],
      ]),
    });
    expect(report.danglingRefs).toEqual([
      { source: "page-b", leaf: "domain-a/topic-missing" },
    ]);
  });

  test("flags dangling core refs", () => {
    const t = tree({ "domain-a/topic-x": ["page-a"] });
    const report = computeV3Health({
      tree: t,
      allSlugs: ["page-a"],
      core: new Set(["domain-a/topic-x", "domain-z/gone"]),
    });
    expect(report.danglingRefs).toEqual([
      { source: "core", leaf: "domain-z/gone" },
    ]);
  });

  test("groups unassigned slugs into novel clusters by 2-level prefix", () => {
    const t = tree({ "domain-a/topic-x": ["assigned"] });
    const report = computeV3Health({
      tree: t,
      allSlugs: [
        "assigned",
        "area-a/topic-x/one",
        "area-a/topic-x/two",
        "area-b/topic-y",
      ],
    });
    expect(report.novelClusters).toEqual([
      {
        prefix: "area-a/topic-x",
        slugs: ["area-a/topic-x/one", "area-a/topic-x/two"],
        count: 2,
      },
      { prefix: "area-b/topic-y", slugs: ["area-b/topic-y"], count: 1 },
    ]);
  });

  test("flags oversized leaves above 3x the median member count", () => {
    // Medians: counts [1,1,1,12] -> sorted median = (1+1)/2 = 1; threshold 3.
    const t = tree({
      "domain-a/small-1": ["s1"],
      "domain-a/small-2": ["s2"],
      "domain-a/small-3": ["s3"],
      "domain-a/big": Array.from({ length: 12 }, (_, i) => `b${i}`),
    });
    const report = computeV3Health({ tree: t, allSlugs: [] });
    expect(report.oversizedLeaves).toEqual([
      { leaf: "domain-a/big", members: 12 },
    ]);
  });

  test("flags tiny leaves with 0-1 members", () => {
    const t = tree({
      "domain-a/empty": [],
      "domain-a/single": ["s1"],
      "domain-a/full": ["a", "b", "c"],
    });
    const report = computeV3Health({ tree: t, allSlugs: [] });
    expect(report.tinyLeaves).toEqual([
      { leaf: "domain-a/empty", members: 0 },
      { leaf: "domain-a/single", members: 1 },
    ]);
  });

  test("staleLabels is deferred (always empty)", () => {
    const t = tree({ "domain-a/topic-x": ["page-a"] });
    const report = computeV3Health({ tree: t, allSlugs: ["page-a"] });
    expect(report.staleLabels).toEqual([]);
  });

  test("passes lastMaintain through", () => {
    const t = tree({ "domain-a/topic-x": ["page-a"] });
    const report = computeV3Health({
      tree: t,
      allSlugs: ["page-a"],
      lastMaintain: { at: 12345, ok: true },
    });
    expect(report.lastMaintain).toEqual({ at: 12345, ok: true });
  });

  test("does not mutate inputs", () => {
    const t = tree({ "domain-a/topic-x": ["page-a", "page-b"] });
    const allSlugs = ["page-a", "page-c"];
    computeV3Health({ tree: t, allSlugs });
    expect(allSlugs).toEqual(["page-a", "page-c"]);
    expect(t.leaves.get("domain-a/topic-x")?.members).toEqual([
      "page-a",
      "page-b",
    ]);
  });
});

describe("renderV3Health", () => {
  test("returns empty string when all-green", () => {
    // A perfectly balanced tree: every leaf has the median count, no
    // unassigned, no dangling, no clusters, lastMaintain ok.
    const t = tree({
      "domain-a/topic-x": ["page-a", "page-b"],
      "domain-a/topic-y": ["page-c", "page-d"],
    });
    const report = computeV3Health({
      tree: t,
      allSlugs: ["page-a", "page-b", "page-c", "page-d"],
      lastMaintain: { at: 1, ok: true },
    });
    expect(report.unassigned).toEqual([]);
    expect(report.danglingRefs).toEqual([]);
    expect(report.novelClusters).toEqual([]);
    expect(report.oversizedLeaves).toEqual([]);
    expect(report.tinyLeaves).toEqual([]);
    expect(renderV3Health(report)).toBe("");
  });

  test("returns empty string when report is entirely empty and no maintain", () => {
    const report = computeV3Health({
      tree: { leaves: new Map(), byPage: new Map() },
      allSlugs: [],
    });
    expect(renderV3Health(report)).toBe("");
  });

  test("renders a non-empty block when any signal fires", () => {
    const t = tree({ "domain-a/topic-x": ["page-a"] });
    const report = computeV3Health({
      tree: t,
      allSlugs: ["page-a", "page-b"],
    });
    const rendered = renderV3Health(report);
    expect(rendered).not.toBe("");
    expect(rendered).toContain("memory-v3 health:");
    expect(rendered).toContain("unassigned");
    expect(rendered).toContain("page-b");
  });

  test("renders a failed last-maintenance even with no other signals", () => {
    const t = tree({
      "domain-a/topic-x": ["page-a", "page-b"],
      "domain-a/topic-y": ["page-c", "page-d"],
    });
    const report = computeV3Health({
      tree: t,
      allSlugs: ["page-a", "page-b", "page-c", "page-d"],
      lastMaintain: { at: 99, ok: false },
    });
    const rendered = renderV3Health(report);
    expect(rendered).toContain("last maintenance FAILED");
  });
});
