import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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

  test("an unreadable explicit file root surfaces a read error, not a false 'No matches'", async () => {
    const dir = makeTempDir();
    const f = join(dir, "secret.txt");
    writeFileSync(f, "needle here\n");
    chmodSync(f, 0o000);
    // When the suite runs as root (e.g. CI in Docker), chmod 000 does not block
    // reads, so EACCES can't be simulated — skip the assertion in that case.
    let readable = true;
    try {
      readFileSync(f);
    } catch {
      readable = false;
    }
    if (!readable) {
      const result = await codeSearchTool.execute(
        { pattern: "needle", path: "secret.txt", activity: "search" },
        makeToolContext(dir),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("failed to read file");
      expect(result.content).not.toContain("No matches found");
    }
    chmodSync(f, 0o644);
  });

  test("an unreadable explicit directory root surfaces a read error, not a false 'No matches'", async () => {
    const dir = makeTempDir();
    const subdir = join(dir, "locked");
    mkdirSync(subdir);
    writeFileSync(join(subdir, "a.ts"), "needle here\n");
    chmodSync(subdir, 0o000);
    // When the suite runs as root (e.g. CI in Docker), chmod 000 does not block
    // reads, so EACCES can't be simulated — probe readdir and skip the assertion
    // in that case.
    let readable = true;
    try {
      readdirSync(subdir);
    } catch {
      readable = false;
    }
    if (!readable) {
      const result = await codeSearchTool.execute(
        { pattern: "needle", path: "locked", activity: "search" },
        makeToolContext(dir),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("failed to read directory");
      expect(result.content).not.toContain("No matches found");
    }
    chmodSync(subdir, 0o755);
  });

  test("an oversized file skipped mid-walk keeps scanning others but flags the result incomplete", async () => {
    const dir = makeTempDir();
    // A directory search must keep scanning sibling files when it hits an
    // oversized one (so a smaller file still matches), yet flag the overall
    // result incomplete since the skipped file could have contained the pattern.
    const oversize = 8 * 1024 * 1024 + 1;
    writeFileSync(join(dir, "huge.txt"), "needle " + "x".repeat(oversize));
    writeFileSync(join(dir, "small.txt"), "needle here\n");

    const result = await codeSearchTool.execute(
      { pattern: "needle", activity: "search" },
      makeToolContext(dir),
    );

    expect(result.isError).toBe(false);
    // The walk wasn't aborted by the skip — the small file still matched...
    expect(result.content).toContain("small.txt");
    // ...and the result is flagged incomplete with a size-limit note.
    expect(result.status).toBe("truncated");
    expect(result.content).toContain("size limit");
  });

  test("a directory whose only candidate is oversized reports incompleteness, not a clean miss", async () => {
    const dir = makeTempDir();
    const oversize = 8 * 1024 * 1024 + 1;
    writeFileSync(join(dir, "huge.txt"), "needle " + "x".repeat(oversize));

    const result = await codeSearchTool.execute(
      { pattern: "needle", activity: "search" },
      makeToolContext(dir),
    );

    expect(result.isError).toBe(false);
    // Zero matches because the only file was skipped — but the result must say
    // it's incomplete (status truncated + size-limit note), not a definitive miss.
    expect(result.status).toBe("truncated");
    expect(result.content).toContain("size limit");
  });

  test("a single multi-MiB matching line is found but its printed output is display-bounded", async () => {
    const dir = makeTempDir();
    // One matching line many megabytes wide whose file stays under MAX_FILE_BYTES
    // (8 MiB) so it isn't skipped. The match is on the full line (so it's found),
    // but the EMITTED line is truncated to the display cap — so a single wide
    // line cannot, by itself, blow the output-byte budget anymore. The result is
    // a clean single match, not truncated, with the printed line bounded.
    const lineLen = 5 * 1024 * 1024;
    writeFileSync(join(dir, "wide.txt"), "needle" + "z".repeat(lineLen) + "\n");

    const result = await codeSearchTool.execute(
      { pattern: "needle", path: "wide.txt", activity: "search" },
      makeToolContext(dir),
    );

    expect(result.isError).toBe(false);
    // Found on the full line — never a false "No matches" or scan-cap message.
    expect(result.content).not.toContain("No matches found");
    expect(result.content).not.toContain("scan cap");
    expect(result.content).toContain("wide.txt:1:");
    // The printed line is display-truncated, so the output stays tiny and the
    // output budget is never hit — single match => not truncated.
    expect(result.content).toContain("…[line truncated]");
    expect(result.status).toBeUndefined();
    expect(result.content).not.toContain("Output capped");
    // The multi-MiB body never reaches the emitted output.
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThan(64 * 1024);
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

  test("matches a token past the display cap on a long line, truncating only the printed output", async () => {
    const dir = makeTempDir();
    // A line far longer than MAX_DISPLAY_LINE_LENGTH (2000) whose matchable token
    // sits well beyond column 2000. With RE2's linear-time matching the pattern
    // is run against the FULL line, so the token MUST be found — but the emitted
    // line is truncated for display with a clear marker. This also exercises that
    // a huge line is handled without throwing/hanging.
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
    // The token appears past column 2000, but matching runs against the full
    // line, so it IS found (correct grep behavior — no false "No matches").
    expect(beyond.content).not.toContain("No matches found");
    expect(beyond.content).toContain("huge.txt:1:");
    // The displayed line is truncated with a marker, so the multi-kilobyte line
    // never balloons the output...
    expect(beyond.content).toContain("…[line truncated]");
    // ...and the matched token (which sits beyond the display cap) is NOT echoed
    // back in the bounded output even though the match was found.
    expect(beyond.content).not.toContain("BEYOND_CAP_TOKEN\n");
    expect(beyond.content.length).toBeLessThan(prefix.length);

    const inside = await codeSearchTool.execute(
      { pattern: "INSIDE_CAP_TOKEN", activity: "search" },
      makeToolContext(dir),
    );
    expect(inside.isError).toBe(false);
    expect(inside.content).toContain("huge.txt:2:");
    // A short line is emitted verbatim — no truncation marker.
    expect(inside.content).toContain("inside INSIDE_CAP_TOKEN here");
    expect(inside.content).not.toContain("…[line truncated]");
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

  test("an already-aborted signal stops the directory traversal, not just per-line scanning", async () => {
    const dir = makeTempDir();
    // Build a small tree of subdirectories and files. The traversal deadline /
    // abort check now lives at the top of walk() and inside its per-entry loop
    // (shared with the per-line checkpoint), so an already-aborted signal must
    // stop the walk before it descends/scans the whole tree, returning a
    // truncated/timed-out result rather than scanning everything.
    for (let d = 0; d < 5; d++) {
      const sub = join(dir, `sub${d}`);
      mkdirSync(sub);
      for (let f = 0; f < 5; f++) {
        writeFileSync(join(sub, `f${f}.txt`), "needle here\n");
      }
    }

    const controller = new AbortController();
    controller.abort();
    const context = { ...makeToolContext(dir), signal: controller.signal };

    const result = await codeSearchTool.execute(
      { pattern: "needle", activity: "search" },
      context,
    );

    // The traversal honored the abort: stopped promptly with a timed-out /
    // incomplete result instead of a definitive miss or full scan.
    expect(result.isError).toBe(false);
    expect(result.status).toBe("truncated");
    expect(result.content).toContain("timed out");
    expect(result.content).not.toContain("No matches found");
  });

  test("a catastrophic-backtracking pattern returns near-instantly (linear-time RE2)", async () => {
    const dir = makeTempDir();
    // The classic ReDoS proof: `(a+)+$` against many non-matching lines of the
    // form `'a'.repeat(50) + '!'`. Under V8's backtracking RegExp a single
    // `regex.test()` on one such line blocks the event loop for seconds, and
    // the synchronous scan never yields so neither the wall-clock deadline nor
    // the promise timeout can interrupt it — the call would hang. With the
    // linear-time RE2 engine the whole file scans in milliseconds and returns
    // a clean, non-truncated "No matches found". The small per-call timeout
    // below would trip if matching ever fell back to backtracking.
    const evilLine = "a".repeat(50) + "!"; // forces backtracking, no match
    const body = Array.from({ length: 200 }, () => evilLine).join("\n");
    writeFileSync(join(dir, "evil.txt"), body + "\n");

    const result = await codeSearchTool.execute(
      { pattern: "(a+)+$", activity: "search" },
      makeToolContext(dir),
    );

    expect(result.isError).toBe(false);
    // Linear-time matching completes well within the deadline, so this is a
    // definitive miss, not a timed-out/truncated result.
    expect(result.status).toBeUndefined();
    expect(result.content).toContain("No matches found");
  }, 5_000);

  test("an unsupported pattern (backreference) returns a clean error, not a throw", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "a.txt"), "aa\n");

    // RE2 does not support backreferences (or lookarounds). The pattern must be
    // rejected at compile time and surfaced as an isError result rather than
    // throwing out of execute().
    const result = await codeSearchTool.execute(
      { pattern: "(a)\\1", activity: "search" },
      makeToolContext(dir),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("invalid or unsupported pattern");
  });

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
