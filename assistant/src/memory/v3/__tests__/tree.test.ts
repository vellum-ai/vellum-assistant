import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { leavesOf, loadLeafTree, membersOf, resolveDataDir } from "../tree.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLED_DATA_DIR = join(HERE, "..", "data");

describe("loadLeafTree", () => {
  test("loads leaves with frontmatter, description, and domain", async () => {
    const tree = await loadLeafTree(BUNDLED_DATA_DIR);

    expect([...tree.leaves.keys()].sort()).toEqual([
      "domain-a/topic-x",
      "domain-a/topic-y",
      "domain-b/topic-z",
    ]);

    const topicX = tree.leaves.get("domain-a/topic-x");
    expect(topicX).toBeDefined();
    expect(topicX?.path).toBe("domain-a/topic-x");
    expect(topicX?.frontmatter).toEqual({
      path: "domain-a/topic-x",
      in_core: true,
    });
    expect(topicX?.domain).toBe("domain-a");
    expect(topicX?.description.length).toBeGreaterThan(0);
    expect(topicX?.description.startsWith("---")).toBe(false);

    const topicZ = tree.leaves.get("domain-b/topic-z");
    expect(topicZ?.frontmatter.in_core).toBe(false);
    expect(topicZ?.domain).toBe("domain-b");
  });

  test("builds members and byPage from assignments", async () => {
    const tree = await loadLeafTree(BUNDLED_DATA_DIR);

    // byPage is the inverted assignment map.
    expect(tree.byPage.get("page-a")).toEqual(["domain-a/topic-x"]);
    expect(tree.byPage.get("page-b")).toEqual([
      "domain-a/topic-x",
      "domain-a/topic-y",
    ]);
    expect(tree.byPage.get("page-c")).toEqual(["domain-b/topic-z"]);

    // members are the slugs assigned to each leaf.
    expect(membersOf(tree, "domain-a/topic-x").sort()).toEqual([
      "page-a",
      "page-b",
    ]);
    expect(membersOf(tree, "domain-a/topic-y")).toEqual(["page-b"]);
    expect(membersOf(tree, "domain-b/topic-z")).toEqual(["page-c"]);
  });

  test("membersOf and leavesOf return empty arrays for unknown keys", async () => {
    const tree = await loadLeafTree(BUNDLED_DATA_DIR);
    expect(membersOf(tree, "nope/missing")).toEqual([]);
    expect(leavesOf(tree, "missing-slug")).toEqual([]);
  });

  test("leavesOf mirrors byPage", async () => {
    const tree = await loadLeafTree(BUNDLED_DATA_DIR);
    expect(leavesOf(tree, "page-b")).toEqual([
      "domain-a/topic-x",
      "domain-a/topic-y",
    ]);
  });
});

describe("resolveDataDir", () => {
  let tmpRoot: string;
  const prevWorkspace = process.env.VELLUM_WORKSPACE_DIR;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "v3-tree-"));
  });

  afterEach(async () => {
    if (prevWorkspace === undefined) delete process.env.VELLUM_WORKSPACE_DIR;
    else process.env.VELLUM_WORKSPACE_DIR = prevWorkspace;
    await rm(tmpRoot, { recursive: true, force: true });
  });

  test("falls back to bundled stub when no workspace override exists", () => {
    process.env.VELLUM_WORKSPACE_DIR = join(tmpRoot, "workspace");
    expect(resolveDataDir()).toBe(BUNDLED_DATA_DIR);
  });

  test("prefers workspace override when <workspace>/memory/v3/data exists", async () => {
    const workspace = join(tmpRoot, "workspace");
    const workspaceData = join(workspace, "memory", "v3", "data");
    const leafDir = join(workspaceData, "leaves", "domain-w");
    await mkdir(leafDir, { recursive: true });
    await writeFile(
      join(leafDir, "topic-real.md"),
      "---\npath: domain-w/topic-real\nin_core: false\n---\n\nReal workspace leaf.\n",
    );
    await writeFile(
      join(workspaceData, "assignments.json"),
      JSON.stringify({ "real-page": ["domain-w/topic-real"] }),
    );

    process.env.VELLUM_WORKSPACE_DIR = workspace;

    expect(resolveDataDir()).toBe(workspaceData);

    const tree = await loadLeafTree(resolveDataDir());
    expect([...tree.leaves.keys()]).toEqual(["domain-w/topic-real"]);
    expect(membersOf(tree, "domain-w/topic-real")).toEqual(["real-page"]);
    expect(leavesOf(tree, "real-page")).toEqual(["domain-w/topic-real"]);
  });
});
