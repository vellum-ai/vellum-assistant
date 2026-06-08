import { expect, test } from "bun:test";

import { buildNeedleIndex } from "../needle.js";
import type { LeafNode, LeafPath, LeafTree, Slug } from "../types.js";

/**
 * Builds a small synthetic LeafTree + summary stub. No real content — every
 * label, summary, and slug here is invented for the test.
 */
function makeFixture(): {
  tree: LeafTree;
  summaries: Map<Slug, string>;
} {
  const leaves = new Map<LeafPath, LeafNode>();
  const byPage = new Map<Slug, LeafPath[]>();

  const leaf = (path: LeafPath, description: string, members: Slug[]): void => {
    leaves.set(path, {
      path,
      frontmatter: { path, in_core: false },
      description,
      members,
      domain: "synthetic",
    });
    for (const slug of members) {
      const list = byPage.get(slug) ?? [];
      list.push(path);
      byPage.set(slug, list);
    }
  };

  leaf("animals/aquatic", "creatures that swim in water", ["dolphin-notes"]);
  leaf("animals/birds", "winged creatures that fly", ["sparrow-notes"]);
  leaf("vehicles/land", "machines with wheels for roads", ["bicycle-notes"]);

  const summaries = new Map<Slug, string>([
    ["dolphin-notes", "observations about marine mammals and echolocation"],
    ["sparrow-notes", "field journal of garden visitors"],
    ["bicycle-notes", "maintenance log for chains and brakes"],
  ]);

  return { tree: { leaves, byPage }, summaries };
}

test("query matches a literal term in a page summary", async () => {
  const { tree, summaries } = makeFixture();
  const index = await buildNeedleIndex(
    tree,
    async (slug) => summaries.get(slug) ?? "",
  );

  const results = index.query("echolocation", 3);
  expect(results[0]).toBe("dolphin-notes");
});

test("query matches a term that appears only in a leaf label", async () => {
  const { tree, summaries } = makeFixture();
  const index = await buildNeedleIndex(
    tree,
    async (slug) => summaries.get(slug) ?? "",
  );

  // "wheels" appears only in the vehicles/land leaf description, not in any
  // summary or slug — it must still surface bicycle-notes.
  const results = index.query("wheels", 3);
  expect(results).toContain("bicycle-notes");
});

test("query matches a term in the slug title segment", async () => {
  const { tree, summaries } = makeFixture();
  const index = await buildNeedleIndex(
    tree,
    async (slug) => summaries.get(slug) ?? "",
  );

  const results = index.query("sparrow", 3);
  expect(results[0]).toBe("sparrow-notes");
});

test("nonsense query returns no spurious results", async () => {
  const { tree, summaries } = makeFixture();
  const index = await buildNeedleIndex(
    tree,
    async (slug) => summaries.get(slug) ?? "",
  );

  expect(index.query("xyzzyplugh", 3)).toEqual([]);
});

test("results are capped at k and ordered by score", async () => {
  const { tree, summaries } = makeFixture();
  const index = await buildNeedleIndex(
    tree,
    async (slug) => summaries.get(slug) ?? "",
  );

  // "creatures" appears in both animal leaf labels; vehicles should be absent.
  const results = index.query("creatures", 1);
  expect(results.length).toBe(1);
  expect(results[0]).not.toBe("bicycle-notes");
});

test("empty corpus yields empty results", async () => {
  const tree: LeafTree = { leaves: new Map(), byPage: new Map() };
  const index = await buildNeedleIndex(tree, async () => "");
  expect(index.query("anything", 5)).toEqual([]);
});
