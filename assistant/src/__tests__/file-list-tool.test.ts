import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  isToolActiveForContext,
  type SkillProjectionContext,
  SUBAGENT_ONLY_TOOL_NAMES,
} from "../daemon/conversation-tool-setup.js";
import { fileListTool } from "../tools/filesystem/list.js";
import {
  FileSystemOps,
  type PathPolicy,
} from "../tools/shared/filesystem/file-ops-service.js";
import { sandboxPolicy } from "../tools/shared/filesystem/path-policy.js";
import type { ToolContext } from "../tools/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const testDirs: string[] = [];

function makeTempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "file-list-test-")));
  testDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Build a sandbox-bound PathPolicy for the given directory. */
function sandboxPolicyFor(boundary: string): PathPolicy {
  return (rawPath, options) => sandboxPolicy(rawPath, boundary, options);
}

// ---------------------------------------------------------------------------
// listDirSafe
// ---------------------------------------------------------------------------

describe("FileSystemOps.listDirSafe", () => {
  test("lists directory contents with type indicators (dirs end with /)", () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, "subdir-a"));
    mkdirSync(join(dir, "subdir-b"));
    writeFileSync(join(dir, "file-a.txt"), "hello");
    writeFileSync(join(dir, "file-b.md"), "world");

    const ops = new FileSystemOps(sandboxPolicyFor(dir));
    const result = ops.listDirSafe({ path: dir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const lines = result.value.listing.split("\n");
    // Directories first with trailing /
    expect(lines[0]).toBe("subdir-a/");
    expect(lines[1]).toBe("subdir-b/");
    // Files after directories, with size info
    expect(lines[2]).toMatch(/^file-a\.txt\s+\d+\s*B$/);
    expect(lines[3]).toMatch(/^file-b\.md\s+\d+\s*B$/);
  });

  test("glob filtering works (e.g. '*.md' only returns .md files)", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "readme.md"), "# Title");
    writeFileSync(join(dir, "notes.md"), "some notes");
    writeFileSync(join(dir, "app.ts"), "console.log('hi')");
    writeFileSync(join(dir, "config.json"), "{}");

    const ops = new FileSystemOps(sandboxPolicyFor(dir));
    const result = ops.listDirSafe({ path: dir, glob: "*.md" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const lines = result.value.listing.split("\n");
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatch(/^notes\.md/);
    expect(lines[1]).toMatch(/^readme\.md/);
  });

  test("returns NOT_A_DIRECTORY error for file paths", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "regular-file.txt"), "content");

    const ops = new FileSystemOps(sandboxPolicyFor(dir));
    const result = ops.listDirSafe({ path: join(dir, "regular-file.txt") });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_A_DIRECTORY");
  });

  test("returns NOT_FOUND error for nonexistent paths", () => {
    const dir = makeTempDir();

    const ops = new FileSystemOps(sandboxPolicyFor(dir));
    const result = ops.listDirSafe({ path: join(dir, "nonexistent") });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });

  test("sandbox policy rejects paths outside boundary", () => {
    const dir = makeTempDir();

    const ops = new FileSystemOps(sandboxPolicyFor(dir));
    const result = ops.listDirSafe({ path: "../../../etc" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PATH_OUT_OF_BOUNDS");
  });
});

// ---------------------------------------------------------------------------
// FileListTool integration tests
// ---------------------------------------------------------------------------

/** Build a minimal ToolContext with the given workingDir. */
function makeToolContext(workingDir: string): ToolContext {
  return {
    workingDir,
    conversationId: "test-conv",
    trustClass: "guardian",
  };
}

describe("FileListTool", () => {
  test("execute() returns formatted listing for a temp directory", async () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "README.md"), "# Hello");
    writeFileSync(join(dir, "index.ts"), "export {}");

    const result = await fileListTool.execute(
      { path: dir, activity: "listing test dir" },
      makeToolContext(dir),
    );

    expect(result.isError).toBe(false);
    const lines = result.content.split("\n");
    // Directory first with trailing /
    expect(lines[0]).toBe("src/");
    // Files after (alphabetical), with size info
    expect(lines[1]).toMatch(/^index\.ts\s+\d+\s*B$/);
    expect(lines[2]).toMatch(/^README\.md\s+\d+\s*B$/);
  });

  test("execute() returns error for invalid path input", async () => {
    const dir = makeTempDir();
    const result = await fileListTool.execute(
      { path: 123, activity: "test" },
      makeToolContext(dir),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("path is required and must be a string");
  });

  test("execute() returns error for nonexistent directory", async () => {
    const dir = makeTempDir();
    const result = await fileListTool.execute(
      { path: join(dir, "nope"), activity: "test" },
      makeToolContext(dir),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
// Subagent-only visibility
// ---------------------------------------------------------------------------

describe("file_list subagent visibility", () => {
  test("file_list is in SUBAGENT_ONLY_TOOL_NAMES", () => {
    expect(SUBAGENT_ONLY_TOOL_NAMES.has("file_list")).toBe(true);
  });

  test("isToolActiveForContext hides file_list when isSubagent is false", () => {
    const ctx: SkillProjectionContext = {
      skillProjectionState: new Map(),
      skillProjectionCache: {},
      coreToolNames: new Set(["file_list"]),
      toolsDisabledDepth: 0,
    };
    expect(isToolActiveForContext("file_list", ctx)).toBe(false);
  });

  test("isToolActiveForContext hides file_list when isSubagent is undefined", () => {
    const ctx: SkillProjectionContext = {
      skillProjectionState: new Map(),
      skillProjectionCache: {},
      coreToolNames: new Set(["file_list"]),
      toolsDisabledDepth: 0,
      isSubagent: undefined,
    };
    expect(isToolActiveForContext("file_list", ctx)).toBe(false);
  });

  test("isToolActiveForContext shows file_list when isSubagent is true", () => {
    const ctx: SkillProjectionContext = {
      skillProjectionState: new Map(),
      skillProjectionCache: {},
      coreToolNames: new Set(["file_list"]),
      toolsDisabledDepth: 0,
      isSubagent: true,
    };
    expect(isToolActiveForContext("file_list", ctx)).toBe(true);
  });
});
