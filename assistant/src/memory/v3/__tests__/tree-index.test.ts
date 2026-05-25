/**
 * Tests for `assistant/src/memory/v3/tree-index.ts`.
 *
 * Coverage matrix:
 *   - getTreeIndex builds correct DAG adjacency on a fixture tree
 *     (root → 2 sub-nodes → page leaves; one node referenced by two parents).
 *   - childrenByNode preserves children order and parses page:/node: refs.
 *   - parentsByNode / pageParents reverse adjacency, incl. a 2-parent node.
 *   - root detection: reserved `_root` wins; single-parentless fallback;
 *     ambiguous fallback warns + picks deterministically.
 *   - dangling refs retained (structural-only build).
 *   - malformed child refs dropped.
 *   - cache hit returns the same object; invalidateTreeIndex forces a rebuild.
 *   - writeNode / deleteNode invalidate the cache.
 *
 * Tests use temp workspaces under `os.tmpdir()`; they never touch `~/.vellum/`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { getTreeIndex, invalidateTreeIndex } from "../tree-index.js";
import {
  deleteNode,
  getTreeDir,
  ROOT_NODE_ID,
  writeNode,
} from "../tree-store.js";
import type { TreeNode } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-tree-index-test-"));
});

afterEach(() => {
  invalidateTreeIndex();
  rmSync(workspaceDir, { recursive: true, force: true });
});

function node(id: string, children: string[], body = `body ${id}`): TreeNode {
  return { id, frontmatter: { children }, body };
}

/**
 * Seed a fixture DAG:
 *   _root → node:people, node:projects
 *   people → page:alice, node:shared
 *   projects → page:apollo, node:shared   ← shared has two parents (DAG)
 *   shared → page:shared-page
 *
 * writeNode invalidates the cache as a side effect, so we invalidate once more
 * at the end to leave a clean slate for the test body's first getTreeIndex.
 */
async function seedFixture(): Promise<void> {
  await writeNode(
    workspaceDir,
    node(ROOT_NODE_ID, ["node:people", "node:projects"]),
  );
  await writeNode(workspaceDir, node("people", ["page:alice", "node:shared"]));
  await writeNode(
    workspaceDir,
    node("projects", ["page:apollo", "node:shared"]),
  );
  await writeNode(workspaceDir, node("shared", ["page:shared-page"]));
  invalidateTreeIndex();
}

// ---------------------------------------------------------------------------
// DAG adjacency
// ---------------------------------------------------------------------------

describe("getTreeIndex — DAG adjacency", () => {
  test("builds forward adjacency preserving children order and ref kinds", async () => {
    await seedFixture();
    const index = await getTreeIndex(workspaceDir);

    expect(index.childrenByNode.get(ROOT_NODE_ID)).toEqual([
      { kind: "node", ref: "people" },
      { kind: "node", ref: "projects" },
    ]);
    expect(index.childrenByNode.get("people")).toEqual([
      { kind: "page", ref: "alice" },
      { kind: "node", ref: "shared" },
    ]);
    expect(index.childrenByNode.get("shared")).toEqual([
      { kind: "page", ref: "shared-page" },
    ]);
  });

  test("builds node reverse adjacency incl. a node with two parents", async () => {
    await seedFixture();
    const index = await getTreeIndex(workspaceDir);

    expect(index.parentsByNode.get("people")).toEqual(new Set([ROOT_NODE_ID]));
    expect(index.parentsByNode.get("projects")).toEqual(
      new Set([ROOT_NODE_ID]),
    );
    // `shared` is referenced by both `people` and `projects` → DAG.
    expect(index.parentsByNode.get("shared")).toEqual(
      new Set(["people", "projects"]),
    );
  });

  test("builds page reverse adjacency keyed by page slug", async () => {
    await seedFixture();
    const index = await getTreeIndex(workspaceDir);

    expect(index.pageParents.get("alice")).toEqual(new Set(["people"]));
    expect(index.pageParents.get("apollo")).toEqual(new Set(["projects"]));
    expect(index.pageParents.get("shared-page")).toEqual(new Set(["shared"]));
  });

  test("populates nodes map with every readable node", async () => {
    await seedFixture();
    const index = await getTreeIndex(workspaceDir);

    expect([...index.nodes.keys()].sort()).toEqual([
      ROOT_NODE_ID,
      "people",
      "projects",
      "shared",
    ]);
    expect(index.nodes.get("shared")?.body).toBe("body shared");
  });

  test("retains dangling refs (structural-only build, no existence check)", async () => {
    await writeNode(
      workspaceDir,
      node(ROOT_NODE_ID, ["node:missing-node", "page:missing-page"]),
    );
    invalidateTreeIndex();
    const index = await getTreeIndex(workspaceDir);

    // Forward edge retained even though no such node/page file exists.
    expect(index.childrenByNode.get(ROOT_NODE_ID)).toEqual([
      { kind: "node", ref: "missing-node" },
      { kind: "page", ref: "missing-page" },
    ]);
    // Reverse adjacency retained too — validation (a later PR) reports these.
    expect(index.parentsByNode.get("missing-node")).toEqual(
      new Set([ROOT_NODE_ID]),
    );
    expect(index.pageParents.get("missing-page")).toEqual(
      new Set([ROOT_NODE_ID]),
    );
  });

  test("drops malformed child refs (no page:/node: prefix)", async () => {
    await writeNode(
      workspaceDir,
      node(ROOT_NODE_ID, ["page:ok", "bogus-no-prefix", "node:", "page:"]),
    );
    invalidateTreeIndex();
    const index = await getTreeIndex(workspaceDir);

    expect(index.childrenByNode.get(ROOT_NODE_ID)).toEqual([
      { kind: "page", ref: "ok" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Root detection
// ---------------------------------------------------------------------------

describe("getTreeIndex — root detection", () => {
  test("prefers the reserved _root node when present", async () => {
    await seedFixture();
    const index = await getTreeIndex(workspaceDir);
    expect(index.root).toBe(ROOT_NODE_ID);
  });

  test("falls back to the single parentless node when no _root", async () => {
    await writeNode(workspaceDir, node("top", ["node:child"]));
    await writeNode(workspaceDir, node("child", []));
    invalidateTreeIndex();
    const index = await getTreeIndex(workspaceDir);
    expect(index.root).toBe("top");
  });

  test("ambiguous root warns and picks ASCII-smallest deterministically", async () => {
    // Two parentless nodes, no _root → ambiguous.
    await writeNode(workspaceDir, node("zeta", []));
    await writeNode(workspaceDir, node("alpha", []));
    invalidateTreeIndex();
    const index = await getTreeIndex(workspaceDir);
    expect(index.root).toBe("alpha");
  });

  test("empty workspace yields _root", async () => {
    const index = await getTreeIndex(workspaceDir);
    expect(index.root).toBe(ROOT_NODE_ID);
    expect(index.nodes.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cache behavior
// ---------------------------------------------------------------------------

describe("getTreeIndex — cache", () => {
  test("cache hit returns the same object reference", async () => {
    await seedFixture();
    const first = await getTreeIndex(workspaceDir);
    const second = await getTreeIndex(workspaceDir);
    expect(second).toBe(first);
  });

  test("invalidateTreeIndex forces a rebuild", async () => {
    await seedFixture();
    const first = await getTreeIndex(workspaceDir);
    invalidateTreeIndex(workspaceDir);
    const second = await getTreeIndex(workspaceDir);
    expect(second).not.toBe(first);
    // Same structural content though.
    expect([...second.nodes.keys()].sort()).toEqual(
      [...first.nodes.keys()].sort(),
    );
  });

  test("scoped invalidation only clears the matching workspace", async () => {
    await seedFixture();
    const first = await getTreeIndex(workspaceDir);
    invalidateTreeIndex("/some/other/workspace");
    const second = await getTreeIndex(workspaceDir);
    expect(second).toBe(first);
  });

  test("writeNode invalidates the cache", async () => {
    await seedFixture();
    const first = await getTreeIndex(workspaceDir);
    await writeNode(workspaceDir, node("newcomer", []));
    const second = await getTreeIndex(workspaceDir);
    expect(second).not.toBe(first);
    expect(second.nodes.has("newcomer")).toBe(true);
  });

  test("deleteNode invalidates the cache", async () => {
    await seedFixture();
    const first = await getTreeIndex(workspaceDir);
    expect(first.nodes.has("shared")).toBe(true);
    await deleteNode(workspaceDir, "shared");
    const second = await getTreeIndex(workspaceDir);
    expect(second).not.toBe(first);
    expect(second.nodes.has("shared")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Read failures
// ---------------------------------------------------------------------------

describe("getTreeIndex — robustness", () => {
  test("ignores a missing tree dir (fresh workspace) → empty index", async () => {
    // No nodes written; getTreeDir not even created.
    const index = await getTreeIndex(workspaceDir);
    expect(index.nodes.size).toBe(0);
    expect(index.childrenByNode.size).toBe(0);
    expect(index.parentsByNode.size).toBe(0);
    expect(index.pageParents.size).toBe(0);
  });

  test("tree dir present but empty → empty index", async () => {
    // Materialize the dir without any node files.
    rmSync(getTreeDir(workspaceDir), { recursive: true, force: true });
    await writeNode(workspaceDir, node("only", []));
    await deleteNode(workspaceDir, "only");
    invalidateTreeIndex();
    const index = await getTreeIndex(workspaceDir);
    expect(index.nodes.size).toBe(0);
  });
});
