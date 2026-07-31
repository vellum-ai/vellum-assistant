import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { buildAdvisorContext, buildWorkspaceTree } from "../consult-context.js";

describe("buildWorkspaceTree", () => {
  test("lists files and directories, skipping dotfiles and dependency dirs", () => {
    const root = mkdtempSync(join(tmpdir(), "consult-tree-"));
    writeFileSync(join(root, "readme.md"), "hi");
    writeFileSync(join(root, ".hidden"), "no");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "index.ts"), "");
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "node_modules", "dep.js"), "");

    const tree = buildWorkspaceTree(root) ?? "";
    expect(tree).toContain("src/");
    expect(tree).toContain("  index.ts");
    expect(tree).toContain("readme.md");
    expect(tree).not.toContain(".hidden");
    expect(tree).not.toContain("node_modules");
  });

  test("respects the depth limit", () => {
    const root = mkdtempSync(join(tmpdir(), "consult-tree-deep-"));
    let dir = root;
    for (let i = 0; i < 6; i++) {
      dir = join(dir, `level${i}`);
      mkdirSync(dir);
    }
    writeFileSync(join(dir, "leaf.txt"), "");

    const tree = buildWorkspaceTree(root, 2) ?? "";
    expect(tree).toContain("level0/");
    expect(tree).toContain("level2/");
    expect(tree).not.toContain("level3");
    expect(tree).not.toContain("leaf.txt");
  });

  test("returns null for a missing or empty directory", () => {
    expect(buildWorkspaceTree("/tmp/does-not-exist-consult-tree")).toBeNull();
    const empty = mkdtempSync(join(tmpdir(), "consult-tree-empty-"));
    expect(buildWorkspaceTree(empty)).toBeNull();
  });
});

describe("buildAdvisorContext", () => {
  test("lists the agent's available tools", async () => {
    const context = await buildAdvisorContext({
      conversationId: "ctx-1",
      workingDir: "/tmp/does-not-exist",
      allowedToolNames: new Set(["bash", "file_read"]),
      trustClass: "unknown",
    });

    expect(context).toContain("## Available tools");
    expect(context).toContain("- bash");
    expect(context).toContain("- file_read");
  });

  test("omits the tools section when no tools are available", async () => {
    const context = await buildAdvisorContext({
      conversationId: "ctx-2",
      workingDir: "/tmp/does-not-exist",
      allowedToolNames: new Set(),
      trustClass: "unknown",
    });
    // Other sources (e.g. the skills catalog) may still contribute, but with no
    // allowed tools the tools section must not appear.
    if (context !== null) {
      expect(context).not.toContain("## Available tools");
    }
  });
});
