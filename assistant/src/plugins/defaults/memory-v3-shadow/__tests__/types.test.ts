import { expect, test } from "bun:test";

import type {
  LeafFrontmatter,
  LeafNode,
  LeafPath,
  LeafTree,
  MemoryRoutingTurn,
  SelectionSource,
  Slug,
  WorkingSetEntry,
} from "../types.js";

test("v3 core types instantiate", () => {
  const path: LeafPath = "domain/topic/leaf";
  const slug: Slug = "page-123";

  const frontmatter: LeafFrontmatter = { path, in_core: true };

  const node: LeafNode = {
    path,
    frontmatter,
    description: "an example leaf node",
    members: [slug],
    domain: "example",
  };

  const tree: LeafTree = {
    leaves: new Map<LeafPath, LeafNode>([[path, node]]),
    byPage: new Map<Slug, LeafPath[]>([[slug, [path]]]),
  };

  const entry: WorkingSetEntry = {
    slug,
    selectedAtTurn: 1,
    pinned: false,
    lastSeenTurn: 2,
  };

  const turnContext: MemoryRoutingTurn = {
    conversationId: "conv-xyz",
    turnNumber: 3,
    currentMessage: "hello",
    recentContext: "prior turns",
  };

  const source: SelectionSource = "carry-forward";

  expect(tree.leaves.get(path)).toBe(node);
  expect(tree.byPage.get(slug)).toEqual([path]);
  expect(entry.slug).toBe(slug);
  expect(turnContext.turnNumber).toBe(3);
  expect(source).toBe("carry-forward");
});
