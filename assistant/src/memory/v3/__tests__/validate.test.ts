/**
 * Tests for `assistant/src/memory/v3/validate.ts`.
 *
 * Coverage matrix — one fixture per defect category plus a clean-tree control:
 *   - clean tree → every list empty, every count 0.
 *   - danglingChildRefs → a `node:` ref and a `page:` ref to absent targets.
 *   - orphanPages → a concept page on disk not wired into the tree; synthetic
 *     page-index entries (none here) and reachable pages excluded.
 *   - cycles → A → B → A back-edge detected during the full descent.
 *   - staleIndex → a parent node whose mtime predates a `node:` child's mtime.
 *   - unknownEdgeTargets → a page `edges:` entry pointing at a missing slug.
 *
 * Tests use temp workspaces under `os.tmpdir()`; they never touch `~/.vellum/`.
 * mtimes are pinned with `utimes` so the freshness check is deterministic and
 * independent of write ordering / filesystem timestamp granularity.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { invalidateEdgeIndex } from "../../v2/edge-index.js";
import { invalidatePageIndex } from "../../v2/page-index.js";
import { writePage } from "../../v2/page-store.js";
import type { ConceptPage } from "../../v2/types.js";
import { invalidateTreeIndex } from "../tree-index.js";
import { getTreeDir, ROOT_NODE_ID, writeNode } from "../tree-store.js";
import type { TreeNode } from "../types.js";
import { validateTree } from "../validate.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-tree-validate-test-"));
});

afterEach(() => {
  invalidateTreeIndex();
  invalidatePageIndex();
  invalidateEdgeIndex();
  rmSync(workspaceDir, { recursive: true, force: true });
});

function node(id: string, children: string[], body = `body ${id}`): TreeNode {
  return { id, frontmatter: { children }, body };
}

function page(slug: string, edges: string[] = []): ConceptPage {
  return {
    slug,
    frontmatter: { edges, ref_files: [], ref_urls: [] },
    body: `body ${slug}`,
  };
}

/** Pin a node file's mtime (and atime) to an explicit epoch-ms value. */
async function setNodeMtime(id: string, mtimeMs: number): Promise<void> {
  const path = join(getTreeDir(workspaceDir), `${id}.md`);
  const t = new Date(mtimeMs);
  await utimes(path, t, t);
}

/**
 * Invalidate every cached index after seeding so the first `validateTree` of a
 * test body sees the on-disk fixture rather than a stale cache.
 */
function resetCaches(): void {
  invalidateTreeIndex();
  invalidatePageIndex();
  invalidateEdgeIndex();
}

describe("validateTree — clean tree", () => {
  test("returns an empty report for a well-formed tree", async () => {
    // _root → node:people → page:alice ; all refs resolve, alice reachable.
    await writeNode(workspaceDir, node(ROOT_NODE_ID, ["node:people"]));
    await writeNode(workspaceDir, node("people", ["page:alice"]));
    await writePage(workspaceDir, page("alice"));
    // Parent newest so the freshness check never fires on a clean tree.
    await setNodeMtime("people", 1_000);
    await setNodeMtime(ROOT_NODE_ID, 2_000);
    resetCaches();

    const report = await validateTree(workspaceDir);

    expect(report.danglingChildRefs).toEqual([]);
    expect(report.danglingChildRefCount).toBe(0);
    expect(report.orphanPages).toEqual([]);
    expect(report.orphanPageCount).toBe(0);
    expect(report.cycles).toEqual([]);
    expect(report.cycleCount).toBe(0);
    expect(report.staleIndex).toEqual([]);
    expect(report.staleIndexCount).toBe(0);
    expect(report.unknownEdgeTargets).toEqual([]);
    expect(report.unknownEdgeTargetCount).toBe(0);
  });
});

describe("validateTree — danglingChildRefs", () => {
  test("flags node: and page: refs whose targets are missing", async () => {
    await writeNode(
      workspaceDir,
      node(ROOT_NODE_ID, ["node:ghost", "page:missing-page"]),
    );
    resetCaches();

    const report = await validateTree(workspaceDir);

    expect(report.danglingChildRefs).toEqual([
      { node: ROOT_NODE_ID, ref: "ghost", kind: "node" },
      { node: ROOT_NODE_ID, ref: "missing-page", kind: "page" },
    ]);
    expect(report.danglingChildRefCount).toBe(2);
  });

  test("does not flag refs whose targets exist", async () => {
    await writeNode(workspaceDir, node(ROOT_NODE_ID, ["node:child"]));
    await writeNode(workspaceDir, node("child", ["page:alice"]));
    await writePage(workspaceDir, page("alice"));
    resetCaches();

    const report = await validateTree(workspaceDir);

    expect(report.danglingChildRefs).toEqual([]);
  });
});

describe("validateTree — orphanPages", () => {
  test("flags concept pages not reachable from the root", async () => {
    await writeNode(workspaceDir, node(ROOT_NODE_ID, ["page:reached"]));
    await writePage(workspaceDir, page("reached"));
    await writePage(workspaceDir, page("orphan"));
    resetCaches();

    const report = await validateTree(workspaceDir);

    expect(report.orphanPages).toEqual(["orphan"]);
    expect(report.orphanPageCount).toBe(1);
  });

  test("a page hanging off an unreachable node is still an orphan", async () => {
    // `floating` is not referenced by _root, so its page child is unreachable.
    await writeNode(workspaceDir, node(ROOT_NODE_ID, []));
    await writeNode(workspaceDir, node("floating", ["page:detached"]));
    await writePage(workspaceDir, page("detached"));
    resetCaches();

    const report = await validateTree(workspaceDir);

    expect(report.orphanPages).toEqual(["detached"]);
  });
});

describe("validateTree — cycles", () => {
  test("detects an A → B → A node cycle as a back-edge", async () => {
    // _root → node:a → node:b → node:a (cycle closes on the b → a edge).
    await writeNode(workspaceDir, node(ROOT_NODE_ID, ["node:a"]));
    await writeNode(workspaceDir, node("a", ["node:b"]));
    await writeNode(workspaceDir, node("b", ["node:a"]));
    resetCaches();

    const report = await validateTree(workspaceDir);

    expect(report.cycles).toEqual([{ from: "b", to: "a" }]);
    expect(report.cycleCount).toBe(1);
  });

  test("a shared DAG sub-node (two parents, no cycle) is not a cycle", async () => {
    await writeNode(workspaceDir, node(ROOT_NODE_ID, ["node:p1", "node:p2"]));
    await writeNode(workspaceDir, node("p1", ["node:shared"]));
    await writeNode(workspaceDir, node("p2", ["node:shared"]));
    await writeNode(workspaceDir, node("shared", []));
    resetCaches();

    const report = await validateTree(workspaceDir);

    expect(report.cycles).toEqual([]);
  });
});

describe("validateTree — staleIndex", () => {
  test("flags a node whose mtime predates a node: child's mtime", async () => {
    await writeNode(workspaceDir, node(ROOT_NODE_ID, ["node:child"]));
    await writeNode(workspaceDir, node("child", []));
    // Parent older than child → stale.
    await setNodeMtime(ROOT_NODE_ID, 1_000);
    await setNodeMtime("child", 5_000);
    resetCaches();

    const report = await validateTree(workspaceDir);

    expect(report.staleIndex).toEqual([
      {
        node: ROOT_NODE_ID,
        child: "child",
        nodeMtimeMs: 1_000,
        childMtimeMs: 5_000,
      },
    ]);
    expect(report.staleIndexCount).toBe(1);
  });

  test("a parent newer than its child is not stale", async () => {
    await writeNode(workspaceDir, node(ROOT_NODE_ID, ["node:child"]));
    await writeNode(workspaceDir, node("child", []));
    await setNodeMtime("child", 1_000);
    await setNodeMtime(ROOT_NODE_ID, 5_000);
    resetCaches();

    const report = await validateTree(workspaceDir);

    expect(report.staleIndex).toEqual([]);
  });
});

describe("validateTree — unknownEdgeTargets", () => {
  test("flags a page edge pointing at a missing slug", async () => {
    await writeNode(workspaceDir, node(ROOT_NODE_ID, ["page:alice"]));
    await writePage(workspaceDir, page("alice", ["nonexistent"]));
    resetCaches();

    const report = await validateTree(workspaceDir);

    expect(report.unknownEdgeTargets).toEqual([
      { from: "alice", to: "nonexistent" },
    ]);
    expect(report.unknownEdgeTargetCount).toBe(1);
  });

  test("an edge to an existing page is not flagged", async () => {
    await writeNode(
      workspaceDir,
      node(ROOT_NODE_ID, ["page:alice", "page:bob"]),
    );
    await writePage(workspaceDir, page("alice", ["bob"]));
    await writePage(workspaceDir, page("bob"));
    resetCaches();

    const report = await validateTree(workspaceDir);

    expect(report.unknownEdgeTargets).toEqual([]);
  });
});
