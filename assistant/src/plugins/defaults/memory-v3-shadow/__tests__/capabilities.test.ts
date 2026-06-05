import { describe, expect, test } from "bun:test";

import {
  CAPABILITIES_LEAF_PATH,
  type CapabilityResolvers,
  injectCapabilitiesLeaf,
  isCapabilitySlug,
  renderCapabilityContent,
} from "../capabilities.js";
import { buildNeedleIndex } from "../needle.js";
import type { LeafPath, LeafTree, Slug } from "../types.js";

function emptyTree(): LeafTree {
  return { leaves: new Map(), byPage: new Map<Slug, LeafPath[]>() };
}

describe("isCapabilitySlug", () => {
  test("true for skill and CLI-command slugs, false otherwise", () => {
    expect(isCapabilitySlug("skills/meet-join")).toBe(true);
    expect(isCapabilitySlug("cli-commands/schedules")).toBe(true);
    expect(isCapabilitySlug("relationship/vows")).toBe(false);
    expect(isCapabilitySlug("some-page")).toBe(false);
  });
});

describe("injectCapabilitiesLeaf", () => {
  test("registers an always-on leaf with the synthetic slugs as members", () => {
    const tree = emptyTree();
    const core = new Set<LeafPath>();
    injectCapabilitiesLeaf(tree, core, ["skills/foo", "cli-commands/bar"]);

    const leaf = tree.leaves.get(CAPABILITIES_LEAF_PATH);
    expect(leaf?.frontmatter.in_core).toBe(true);
    expect(leaf?.members).toEqual(["skills/foo", "cli-commands/bar"]);
    expect(core.has(CAPABILITIES_LEAF_PATH)).toBe(true);
  });

  test("unions the leaf into each member's byPage entry without dropping existing leaves", () => {
    const tree = emptyTree();
    tree.byPage.set("skills/foo", ["other/leaf"]);
    injectCapabilitiesLeaf(tree, new Set<LeafPath>(), [
      "skills/foo",
      "cli-commands/bar",
    ]);

    expect(tree.byPage.get("skills/foo")).toEqual([
      "other/leaf",
      CAPABILITIES_LEAF_PATH,
    ]);
    expect(tree.byPage.get("cli-commands/bar")).toEqual([
      CAPABILITIES_LEAF_PATH,
    ]);
  });

  test("is idempotent — re-injecting does not duplicate the byPage entry", () => {
    const tree = emptyTree();
    const core = new Set<LeafPath>();
    injectCapabilitiesLeaf(tree, core, ["skills/foo"]);
    injectCapabilitiesLeaf(tree, core, ["skills/foo"]);
    expect(tree.byPage.get("skills/foo")).toEqual([CAPABILITIES_LEAF_PATH]);
  });

  test("stays always-on even with no installed skills/commands", () => {
    const tree = emptyTree();
    const core = new Set<LeafPath>();
    injectCapabilitiesLeaf(tree, core, []);
    expect(tree.leaves.get(CAPABILITIES_LEAF_PATH)?.members).toEqual([]);
    expect(core.has(CAPABILITIES_LEAF_PATH)).toBe(true);
  });
});

describe("renderCapabilityContent", () => {
  const resolvers: CapabilityResolvers = {
    skill: (slug) =>
      slug === "skills/foo" ? { id: "foo", content: "foo capability" } : null,
    cli: (slug) =>
      slug === "cli-commands/bar"
        ? { id: "bar", content: "bar capability" }
        : null,
  };

  test("renders a skill slug with a Skill header", () => {
    expect(renderCapabilityContent("skills/foo", resolvers)).toBe(
      "# Skill: foo\nfoo capability",
    );
  });

  test("renders a CLI-command slug with a CLI header", () => {
    expect(renderCapabilityContent("cli-commands/bar", resolvers)).toBe(
      "# CLI command: bar\nbar capability",
    );
  });

  test("degrades to '' for a capability slug the cache cannot resolve", () => {
    expect(renderCapabilityContent("skills/missing", resolvers)).toBe("");
  });

  test("returns null for a non-capability slug so the caller reads the on-disk page", () => {
    expect(renderCapabilityContent("relationship/vows", resolvers)).toBeNull();
  });
});

describe("needle indexes injected capability members", () => {
  test("a skill slug is lexically retrievable by its title and summary", async () => {
    const tree = emptyTree();
    injectCapabilitiesLeaf(tree, new Set<LeafPath>(), ["skills/meet-join"]);

    const needle = await buildNeedleIndex(
      tree,
      async () => "Join and transcribe a video meeting",
    );

    // By slug-derived title token.
    expect(needle.query("meet", 5)).toContain("skills/meet-join");
    // By summary token.
    expect(needle.query("transcribe", 5)).toContain("skills/meet-join");
  });
});
