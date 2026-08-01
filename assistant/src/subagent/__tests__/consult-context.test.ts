import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { buildAdvisorContext, buildWorkspaceTree } from "../consult-context.js";

// `buildToolsSection` reaches the registry through a dynamic import, and that
// module graph costs a few hundred milliseconds to evaluate cold. Paying it
// here, outside the section's timeout, keeps a loaded runner's import speed
// from deciding whether the section beats its budget.
import "../../tools/registry.js";

describe("buildWorkspaceTree", () => {
  test("lists files and directories, skipping dotfiles and dependency dirs", async () => {
    const root = mkdtempSync(join(tmpdir(), "consult-tree-"));
    writeFileSync(join(root, "readme.md"), "hi");
    writeFileSync(join(root, ".hidden"), "no");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "index.ts"), "");
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "node_modules", "dep.js"), "");

    const tree = (await buildWorkspaceTree(root)) ?? "";
    expect(tree).toContain("src/");
    expect(tree).toContain("  index.ts");
    expect(tree).toContain("readme.md");
    expect(tree).not.toContain(".hidden");
    expect(tree).not.toContain("node_modules");
  });

  test("respects the depth limit", async () => {
    const root = mkdtempSync(join(tmpdir(), "consult-tree-deep-"));
    let dir = root;
    for (let i = 0; i < 6; i++) {
      dir = join(dir, `level${i}`);
      mkdirSync(dir);
    }
    writeFileSync(join(dir, "leaf.txt"), "");

    const tree = (await buildWorkspaceTree(root, 2)) ?? "";
    expect(tree).toContain("level0/");
    expect(tree).toContain("level2/");
    expect(tree).not.toContain("level3");
    expect(tree).not.toContain("leaf.txt");
  });

  test("returns null for a missing or empty directory", async () => {
    expect(
      await buildWorkspaceTree("/tmp/does-not-exist-consult-tree"),
    ).toBeNull();
    const empty = mkdtempSync(join(tmpdir(), "consult-tree-empty-"));
    expect(await buildWorkspaceTree(empty)).toBeNull();
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
