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

  test("non-existent root path returns a path error, not a false 'No matches'", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "a.ts"), "needle\n");

    // A typo'd subdirectory (e.g. "srcc") must surface an actionable path error
    // rather than being swallowed and reported as a successful empty search.
    const result = await codeSearchTool.execute(
      { pattern: "needle", path: "srcc", activity: "search" },
      makeToolContext(dir),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("path not found");
    expect(result.content).not.toContain("No matches found");
  });

  test("searches a single file when the root resolves to a regular file", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "a.ts"), "const foo = 1;\nconst needle = 2;\n");

    const result = await codeSearchTool.execute(
      { pattern: "needle", path: "a.ts", activity: "search" },
      makeToolContext(dir),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toBe("a.ts:2: const needle = 2;");
  });

  test("an oversized explicit-file root returns an error, not a false 'No matches'", async () => {
    const dir = makeTempDir();
    // A single-file root larger than MAX_FILE_BYTES (8 MiB) was never searched,
    // so reporting "No matches found" would be a silent false negative. Surface
    // a hard error instead.
    const oversize = 8 * 1024 * 1024 + 1;
    writeFileSync(join(dir, "huge.txt"), "x".repeat(oversize));

    const result = await codeSearchTool.execute(
      { pattern: "x", path: "huge.txt", activity: "search" },
      makeToolContext(dir),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("file too large to search");
    expect(result.content).not.toContain("No matches found");
  });

  test("a single >4 MiB matching line yields a truncated result that acknowledges the match", async () => {
    const dir = makeTempDir();
    // One matching line whose output alone exceeds MAX_OUTPUT_BYTES (4 MiB) but
    // whose file stays under MAX_FILE_BYTES (8 MiB) so it isn't skipped. The
    // match must be counted and the truncation attributed to the output budget,
    // not reported as "no matches / scan cap".
    const lineLen = 5 * 1024 * 1024;
    writeFileSync(join(dir, "wide.txt"), "needle" + "z".repeat(lineLen) + "\n");

    const result = await codeSearchTool.execute(
      { pattern: "needle", path: "wide.txt", activity: "search" },
      makeToolContext(dir),
    );

    expect(result.isError).toBe(false);
    expect(result.status).toBe("truncated");
    // The match was found: the output budget message, not the scan-cap or
    // no-match message.
    expect(result.content).toContain("Output capped");
    expect(result.content).not.toContain("No matches found");
    expect(result.content).not.toContain("scan cap");
    expect(result.content).toContain("wide.txt:1:");
  });

  test("single-file search still honors the denied-basename guard", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "backup.key"), "supersecret token\n");

    const result = await codeSearchTool.execute(
      { pattern: "supersecret", path: "backup.key", activity: "search" },
      makeToolContext(dir),
    );

    // The denied basename is rejected by the sandbox policy before any read,
    // so the secret never surfaces in the result.
    expect(result.isError).toBe(true);
    expect(result.content).not.toContain("supersecret");
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

  test("bounds the regex to the leading slice of very long lines", async () => {
    const dir = makeTempDir();
    // A line far longer than MAX_MATCH_LINE_LENGTH (2000). The matchable token
    // sits well beyond the cap, so the bounded regex slice must not see it,
    // while a token inside the cap on the same file is still found. This also
    // exercises that a huge line is handled without throwing/hanging.
    const prefix = "x".repeat(5000);
    writeFileSync(
      join(dir, "huge.txt"),
      `${prefix}BEYOND_CAP_TOKEN\ninside INSIDE_CAP_TOKEN here\n`,
    );

    const beyond = await codeSearchTool.execute(
      { pattern: "BEYOND_CAP_TOKEN", activity: "search" },
      makeToolContext(dir),
    );
    expect(beyond.isError).toBe(false);
    // The token only appears past the bounded slice, so it must not match.
    expect(beyond.content).toContain("No matches found");

    const inside = await codeSearchTool.execute(
      { pattern: "INSIDE_CAP_TOKEN", activity: "search" },
      makeToolContext(dir),
    );
    expect(inside.isError).toBe(false);
    expect(inside.content).toContain("huge.txt:2:");
  });

  test("caps output via the byte budget when many matches have context", async () => {
    const dir = makeTempDir();
    // Many matches with context lines. Even though context_lines is requested
    // far above the clamp (MAX_CONTEXT_LINES = 20), the clamp plus the
    // output-byte budget must produce a truncated result rather than an
    // unbounded one. The source file stays under MAX_FILE_BYTES (8 MiB) so it
    // isn't skipped, but because every line both matches and is re-emitted as
    // context for ~41 nearby matches, the accumulated output crosses the 4 MiB
    // budget.
    const filler = "y".repeat(200);
    const lineCount = 20_000;
    const body = Array.from(
      { length: lineCount },
      () => `match ${filler}`,
    ).join("\n");
    writeFileSync(join(dir, "big.txt"), body + "\n");

    const result = await codeSearchTool.execute(
      {
        pattern: "match",
        context_lines: 1000,
        max_results: 1_000_000,
        activity: "search",
      },
      makeToolContext(dir),
    );

    expect(result.isError).toBe(false);
    expect(result.status).toBe("truncated");
    expect(result.content).toContain("Output capped");
    // The accumulated output must stay near the budget, not balloon to the full
    // file size (~20 MiB of body * surrounding context).
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThan(
      8 * 1024 * 1024,
    );
  });

  test("an already-aborted signal stops the scan and reports a timed-out result", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "a.txt"), "needle here\nneedle there\n");

    // The wall-clock deadline (MAX_SEARCH_MS) and the abort signal are checked
    // at the same per-line checkpoint. MAX_SEARCH_MS is a 10s const that isn't
    // injectable, so we exercise the shared stop path deterministically via an
    // already-aborted signal: the scan must stop at the first line check and
    // return a truncated/timed-out result instead of running the regex.
    const controller = new AbortController();
    controller.abort();
    const context = { ...makeToolContext(dir), signal: controller.signal };

    const result = await codeSearchTool.execute(
      { pattern: "needle", activity: "search" },
      context,
    );

    // Aborted before any match was emitted, so this is the zero-match
    // timed-out branch (incomplete), not a definitive "No matches found".
    expect(result.isError).toBe(false);
    expect(result.status).toBe("truncated");
    expect(result.content).toContain("timed out");
    expect(result.content).not.toContain("No matches found");
  });

  test(
    "a catastrophic-backtracking pattern over many lines terminates",
    async () => {
      const dir = makeTempDir();
      // A classic catastrophic-backtracking pattern against crafted lines that
      // never match. Each individual line is small enough to backtrack quickly,
      // but the file has many of them — the wall-clock deadline is checked once
      // per line, so the scan must terminate (it does not block indefinitely).
      // Kept deterministically fast: the whole file scans well under the
      // deadline, so we assert it returns a clean result rather than hanging.
      const evilLine = "a".repeat(20) + "!"; // forces backtracking, no match
      const body = Array.from({ length: 50 }, () => evilLine).join("\n");
      writeFileSync(join(dir, "evil.txt"), body + "\n");

      const result = await codeSearchTool.execute(
        { pattern: "(a+)+$", activity: "search" },
        makeToolContext(dir),
      );

      // It must terminate gracefully. Depending on host speed it either
      // finishes under the deadline (clean "No matches found") or trips the
      // deadline (truncated/timed-out) — both are acceptable; hanging is not.
      expect(result.isError).toBe(false);
      if (result.status === "truncated") {
        expect(result.content).toContain("timed out");
      } else {
        expect(result.content).toContain("No matches found");
      }
    },
    30_000,
  );

  test("does not return contents of denied-basename files", async () => {
    const dir = makeTempDir();
    // A denied file (forbidden to file_read/file_write) that contains the
    // search pattern must never surface in code_search results.
    writeFileSync(join(dir, ".backup.key"), "supersecret token\n");
    writeFileSync(join(dir, "backup.key"), "another supersecret\n");
    writeFileSync(join(dir, "ok.txt"), "supersecret in a normal file\n");

    const result = await codeSearchTool.execute(
      { pattern: "supersecret", activity: "search" },
      makeToolContext(dir),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("ok.txt:1:");
    expect(result.content).not.toContain(".backup.key");
    expect(result.content).not.toContain("backup.key");
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
