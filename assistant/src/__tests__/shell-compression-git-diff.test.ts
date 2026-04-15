import { describe, expect, test } from "bun:test";

import { compressGitDiff } from "../tools/shared/shell-compression/compressors/git-diff.js";

describe("compressGitDiff", () => {
  // ── Context line reduction ────────────────────────────────────

  test("reduces context lines from 3 to 1 around changes", () => {
    const diff = [
      "diff --git a/src/app.ts b/src/app.ts",
      "index abc1234..def5678 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -10,11 +10,11 @@",
      " context line 1",
      " context line 2",
      " context line 3",
      "-old line",
      "+new line",
      " context line 4",
      " context line 5",
      " context line 6",
    ].join("\n");

    const result = compressGitDiff(diff, "", 0);
    const lines = result.split("\n");

    // Header lines preserved
    expect(lines[0]).toBe("diff --git a/src/app.ts b/src/app.ts");
    expect(lines[1]).toBe("index abc1234..def5678 100644");
    expect(lines[2]).toBe("--- a/src/app.ts");
    expect(lines[3]).toBe("+++ b/src/app.ts");
    expect(lines[4]).toBe("@@ -10,11 +10,11 @@");

    // Only 1 context line before and 1 after the change
    expect(result).toContain(" context line 3");
    expect(result).toContain("-old line");
    expect(result).toContain("+new line");
    expect(result).toContain(" context line 4");

    // Context lines 1, 2, 5, 6 should be removed
    expect(result).not.toContain(" context line 1");
    expect(result).not.toContain(" context line 2");
    expect(result).not.toContain(" context line 5");
    expect(result).not.toContain(" context line 6");
  });

  test("preserves all +/- lines exactly in multi-file diff", () => {
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,7 +1,7 @@",
      " ctx before",
      " ctx before 2",
      " ctx before 3",
      "-removed from foo",
      "+added to foo",
      " ctx after",
      " ctx after 2",
      " ctx after 3",
      "diff --git a/src/bar.ts b/src/bar.ts",
      "--- a/src/bar.ts",
      "+++ b/src/bar.ts",
      "@@ -5,6 +5,8 @@",
      " ctx",
      " ctx",
      " ctx",
      "+new line 1 in bar",
      "+new line 2 in bar",
      " ctx",
      " ctx",
      " ctx",
    ].join("\n");

    const result = compressGitDiff(diff, "", 0);

    // All changed lines must be present
    expect(result).toContain("-removed from foo");
    expect(result).toContain("+added to foo");
    expect(result).toContain("+new line 1 in bar");
    expect(result).toContain("+new line 2 in bar");

    // Both file headers present
    expect(result).toContain("diff --git a/src/foo.ts b/src/foo.ts");
    expect(result).toContain("diff --git a/src/bar.ts b/src/bar.ts");
  });

  // ── Lock file detection ───────────────────────────────────────

  test("collapses lock file diff to summary line", () => {
    const diff = [
      "diff --git a/package-lock.json b/package-lock.json",
      "--- a/package-lock.json",
      "+++ b/package-lock.json",
      "@@ -100,5 +100,10 @@",
      '-    "version": "1.0.0"',
      '+    "version": "1.1.0"',
      "+    some new dep line 1",
      "+    some new dep line 2",
      "+    some new dep line 3",
      "+    some new dep line 4",
      "+    some new dep line 5",
    ].join("\n");

    const result = compressGitDiff(diff, "", 0);
    expect(result).toBe(
      "package-lock.json: +6 -1 lines (lock file, details omitted)",
    );
  });

  test("collapses yarn.lock diff to summary line", () => {
    const diff = [
      "diff --git a/yarn.lock b/yarn.lock",
      "--- a/yarn.lock",
      "+++ b/yarn.lock",
      "@@ -1,3 +1,5 @@",
      "+added 1",
      "+added 2",
      "-removed 1",
    ].join("\n");

    const result = compressGitDiff(diff, "", 0);
    expect(result).toBe("yarn.lock: +2 -1 lines (lock file, details omitted)");
  });

  test("collapses Cargo.lock diff to summary line", () => {
    const diff = [
      "diff --git a/Cargo.lock b/Cargo.lock",
      "--- a/Cargo.lock",
      "+++ b/Cargo.lock",
      "@@ -1,2 +1,3 @@",
      "+new dep",
    ].join("\n");

    const result = compressGitDiff(diff, "", 0);
    expect(result).toBe("Cargo.lock: +1 -0 lines (lock file, details omitted)");
  });

  test("collapses pnpm-lock.yaml diff to summary line", () => {
    const diff = [
      "diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml",
      "--- a/pnpm-lock.yaml",
      "+++ b/pnpm-lock.yaml",
      "@@ -1,2 +1,3 @@",
      "+new line",
      "-old line",
    ].join("\n");

    const result = compressGitDiff(diff, "", 0);
    expect(result).toBe(
      "pnpm-lock.yaml: +1 -1 lines (lock file, details omitted)",
    );
  });

  test("collapses Gemfile.lock diff to summary line", () => {
    const diff = [
      "diff --git a/Gemfile.lock b/Gemfile.lock",
      "--- a/Gemfile.lock",
      "+++ b/Gemfile.lock",
      "@@ -1,2 +1,3 @@",
      "+new gem",
    ].join("\n");

    const result = compressGitDiff(diff, "", 0);
    expect(result).toBe(
      "Gemfile.lock: +1 -0 lines (lock file, details omitted)",
    );
  });

  // ── Binary files ──────────────────────────────────────────────

  test("preserves binary file diff as-is", () => {
    const diff = [
      "diff --git a/icon.png b/icon.png",
      "Binary files a/icon.png and b/icon.png differ",
    ].join("\n");

    const result = compressGitDiff(diff, "", 0);
    expect(result).toContain("Binary files a/icon.png and b/icon.png differ");
  });

  test("preserves new binary file diff", () => {
    const diff = [
      "diff --git a/logo.png b/logo.png",
      "new file mode 100644",
      "Binary files /dev/null and b/logo.png differ",
    ].join("\n");

    const result = compressGitDiff(diff, "", 0);
    expect(result).toContain("Binary files /dev/null and b/logo.png differ");
  });

  // ── Error output ──────────────────────────────────────────────

  test("passes through error output with non-zero exit code", () => {
    const stderr = "fatal: bad revision 'nonexistent'";
    const result = compressGitDiff("", stderr, 128);
    expect(result).toBe(stderr);
  });

  test("passes through stderr even with exit code 0", () => {
    // git diff can write warnings to stderr with exit code 0
    const stderr = "warning: some git warning";
    const stdout = "diff --git a/f.ts b/f.ts\n--- a/f.ts\n+++ b/f.ts\n";
    const result = compressGitDiff(stdout, stderr, 0);
    expect(result).toContain(stderr);
    expect(result).toContain(stdout);
  });

  test("passes through stderr with null exit code", () => {
    const stderr = "error: something went wrong";
    const result = compressGitDiff("some output", stderr, null);
    expect(result).toContain(stderr);
    expect(result).toContain("some output");
  });

  test("passes through stdout with non-zero exit code and no stderr", () => {
    const stdout = "some partial output before failure";
    const result = compressGitDiff(stdout, "", 1);
    expect(result).toBe(stdout);
  });

  // ── Large hunk truncation ─────────────────────────────────────

  test("truncates file diff exceeding 5000 chars", () => {
    const longLine = "+".padEnd(100, "x");
    const lines = [
      "diff --git a/big.ts b/big.ts",
      "--- a/big.ts",
      "+++ b/big.ts",
      "@@ -1,2 +1,100 @@",
    ];
    // Add enough lines to exceed 5000 chars
    for (let i = 0; i < 60; i++) {
      lines.push(longLine);
    }
    const diff = lines.join("\n");

    const result = compressGitDiff(diff, "", 0);
    expect(result).toContain("... (");
    expect(result).toContain("more lines)");
    expect(result.length).toBeLessThan(diff.length);
  });

  // ── Edge cases ────────────────────────────────────────────────

  test("returns empty string for empty input", () => {
    expect(compressGitDiff("", "", 0)).toBe("");
  });

  test("returns whitespace input as-is", () => {
    expect(compressGitDiff("  \n  ", "", 0)).toBe("  \n  ");
  });

  test("handles git show preamble before diff", () => {
    const output = [
      "commit abc1234567890",
      "Author: Test User <test@example.com>",
      "Date:   Mon Jan 1 00:00:00 2024 +0000",
      "",
      "    Fix the thing",
      "",
      "diff --git a/src/thing.ts b/src/thing.ts",
      "--- a/src/thing.ts",
      "+++ b/src/thing.ts",
      "@@ -1,5 +1,5 @@",
      " context",
      "-old",
      "+new",
      " context",
    ].join("\n");

    const result = compressGitDiff(output, "", 0);
    expect(result).toContain("commit abc1234567890");
    expect(result).toContain("Fix the thing");
    expect(result).toContain("-old");
    expect(result).toContain("+new");
  });

  test("handles multiple changed blocks in a single hunk", () => {
    const diff = [
      "diff --git a/multi.ts b/multi.ts",
      "--- a/multi.ts",
      "+++ b/multi.ts",
      "@@ -1,15 +1,15 @@",
      " ctx 1",
      " ctx 2",
      " ctx 3",
      "-change A old",
      "+change A new",
      " between 1",
      " between 2",
      " between 3",
      " between 4",
      " between 5",
      "-change B old",
      "+change B new",
      " ctx 4",
      " ctx 5",
      " ctx 6",
    ].join("\n");

    const result = compressGitDiff(diff, "", 0);

    // All changes preserved
    expect(result).toContain("-change A old");
    expect(result).toContain("+change A new");
    expect(result).toContain("-change B old");
    expect(result).toContain("+change B new");

    // Only 1 context line before/after each change block
    expect(result).toContain(" ctx 3");
    expect(result).toContain(" between 1");
    expect(result).toContain(" between 5");
    expect(result).toContain(" ctx 4");

    // Extra context removed
    expect(result).not.toContain(" ctx 1");
    expect(result).not.toContain(" ctx 2");
    expect(result).not.toContain(" between 2");
    expect(result).not.toContain(" between 3");
    expect(result).not.toContain(" between 4");
    expect(result).not.toContain(" ctx 5");
    expect(result).not.toContain(" ctx 6");
  });
});
