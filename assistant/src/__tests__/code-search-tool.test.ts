import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { SUBAGENT_ONLY_TOOL_NAMES } from "../daemon/conversation-tool-setup.js";
import { codeSearchTool } from "../tools/filesystem/search.js";
import type { ToolContext } from "../tools/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const testDirs: string[] = [];

function makeTempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "code-search-test-")));
  testDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeToolContext(workingDir: string): ToolContext {
  return {
    workingDir,
    conversationId: "test-conv",
    trustClass: "guardian",
  };
}

// ---------------------------------------------------------------------------
// code_search
// ---------------------------------------------------------------------------

describe("codeSearchTool", () => {
  test("finds a known pattern with correct file:line", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "a.ts"), "const foo = 1;\nconst bar = 2;\n");

    const result = await codeSearchTool.execute(
      { pattern: "bar", activity: "search" },
      makeToolContext(dir),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toBe("a.ts:2: const bar = 2;");
  });

  test("respects glob filter", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "match.ts"), "needle here\n");
    writeFileSync(join(dir, "skip.md"), "needle here too\n");

    const result = await codeSearchTool.execute(
      { pattern: "needle", glob: "*.ts", activity: "search" },
      makeToolContext(dir),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("match.ts:1:");
    expect(result.content).not.toContain("skip.md");
  });

  test("rejects a path escaping the workspace root", async () => {
    const dir = makeTempDir();

    const result = await codeSearchTool.execute(
      { pattern: "anything", path: "../../../etc", activity: "search" },
      makeToolContext(dir),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside the working directory");
  });

  test("case_insensitive matching", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "a.txt"), "Hello WORLD\n");

    const sensitive = await codeSearchTool.execute(
      { pattern: "world", activity: "search" },
      makeToolContext(dir),
    );
    expect(sensitive.content).toContain("No matches found");

    const insensitive = await codeSearchTool.execute(
      { pattern: "world", case_insensitive: true, activity: "search" },
      makeToolContext(dir),
    );
    expect(insensitive.isError).toBe(false);
    expect(insensitive.content).toBe("a.txt:1: Hello WORLD");
  });

  test("no match returns a clear empty result", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "a.txt"), "nothing relevant\n");

    const result = await codeSearchTool.execute(
      { pattern: "absent-token", activity: "search" },
      makeToolContext(dir),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("No matches found");
  });

  test("max_results truncates and reports it", async () => {
    const dir = makeTempDir();
    const body = Array.from({ length: 10 }, () => "match").join("\n");
    writeFileSync(join(dir, "a.txt"), body + "\n");

    const result = await codeSearchTool.execute(
      { pattern: "match", max_results: 3, activity: "search" },
      makeToolContext(dir),
    );

    expect(result.isError).toBe(false);
    expect(result.status).toBe("truncated");
    expect(result.content).toContain("truncated at 3 matches");
    const matchLines = result.content
      .split("\n")
      .filter((l) => l.startsWith("a.txt:"));
    expect(matchLines.length).toBe(3);
  });

  test("includes context lines when requested", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "a.txt"), "before\nTARGET\nafter\n");

    const result = await codeSearchTool.execute(
      { pattern: "TARGET", context_lines: 1, activity: "search" },
      makeToolContext(dir),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("a.txt:1- before");
    expect(result.content).toContain("a.txt:2: TARGET");
    expect(result.content).toContain("a.txt:3- after");
  });

  test("ignores node_modules and .git", async () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "dep.js"), "secret\n");
    writeFileSync(join(dir, "src.js"), "secret\n");

    const result = await codeSearchTool.execute(
      { pattern: "secret", activity: "search" },
      makeToolContext(dir),
    );

    expect(result.content).toContain("src.js:1:");
    expect(result.content).not.toContain("node_modules");
  });

  test("requires a non-empty pattern", async () => {
    const dir = makeTempDir();
    const result = await codeSearchTool.execute(
      { pattern: "", activity: "search" },
      makeToolContext(dir),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("pattern is required");
  });

  test("is read-only: directory is unchanged after a search", async () => {
    const dir = makeTempDir();
    const filePath = join(dir, "a.txt");
    writeFileSync(filePath, "hello search\n");
    const before = readFileSync(filePath, "utf8");
    const mtimeBefore = statSync(filePath).mtimeMs;

    await codeSearchTool.execute(
      { pattern: "search", activity: "search" },
      makeToolContext(dir),
    );

    expect(readFileSync(filePath, "utf8")).toBe(before);
    expect(statSync(filePath).mtimeMs).toBe(mtimeBefore);
  });
});

// ---------------------------------------------------------------------------
// Subagent-only visibility
// ---------------------------------------------------------------------------

describe("code_search subagent visibility", () => {
  test("code_search is in SUBAGENT_ONLY_TOOL_NAMES", () => {
    expect(SUBAGENT_ONLY_TOOL_NAMES.has("code_search")).toBe(true);
  });
});
