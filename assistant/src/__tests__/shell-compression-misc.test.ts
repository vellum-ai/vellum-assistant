import { describe, expect, test } from "bun:test";

import { compressBuildOutput } from "../tools/shared/shell-compression/compressors/build-lint.js";
import { compressDirectoryListing } from "../tools/shared/shell-compression/compressors/directory-listing.js";
import { compressGitStatus } from "../tools/shared/shell-compression/compressors/git-status.js";
import { compressSearchResults } from "../tools/shared/shell-compression/compressors/search-results.js";

// ── git-status ──────────────────────────────────────────────────────

describe("compressGitStatus", () => {
  test("preserves branch tracking info", () => {
    const stdout = `## main...origin/main
 M src/app.ts
?? newfile.ts`;
    const result = compressGitStatus(stdout, "", 0);
    expect(result).toContain("## main...origin/main");
  });

  test("preserves modified/staged/deleted files individually", () => {
    const stdout = ` M src/app.ts
A  src/new.ts
D  src/old.ts
R  src/renamed.ts`;
    const result = compressGitStatus(stdout, "", 0);
    expect(result).toContain(" M src/app.ts");
    expect(result).toContain("A  src/new.ts");
    expect(result).toContain("D  src/old.ts");
    expect(result).toContain("R  src/renamed.ts");
  });

  test("groups >5 untracked files by directory", () => {
    const untrackedLines = Array.from(
      { length: 8 },
      (_, i) => `?? src/components/file${i}.tsx`,
    );
    const stdout = ` M src/app.ts\n${untrackedLines.join("\n")}`;
    const result = compressGitStatus(stdout, "", 0);
    expect(result).toContain("?? src/components/ (8 files)");
    expect(result).not.toContain("file0.tsx");
  });

  test("keeps <=5 untracked files individually", () => {
    const untrackedLines = Array.from(
      { length: 3 },
      (_, i) => `?? src/file${i}.ts`,
    );
    const stdout = untrackedLines.join("\n");
    const result = compressGitStatus(stdout, "", 0);
    expect(result).toContain("?? src/file0.ts");
    expect(result).toContain("?? src/file2.ts");
  });

  test("keeps top-level untracked directories individually", () => {
    const dirs = Array.from({ length: 8 }, (_, i) => `?? dir${i}/`);
    const stdout = dirs.join("\n");
    const result = compressGitStatus(stdout, "", 0);
    // Each directory should be kept individually, not grouped under "?? ./"
    expect(result).toContain("?? dir0/");
    expect(result).toContain("?? dir7/");
    expect(result).not.toContain("?? ./");
  });

  test("passes through error output", () => {
    const result = compressGitStatus("", "fatal: not a git repository", 128);
    expect(result).toContain("fatal: not a git repository");
  });
});

// ── directory-listing ───────────────────────────────────────────────

describe("compressDirectoryListing", () => {
  test("groups >10 files by extension in ls -la output", () => {
    const header = "total 120";
    const dirEntry = "drwxr-xr-x  5 user group  160 Apr 10 10:00 components";
    const tsxFiles = Array.from(
      { length: 12 },
      (_, i) => `-rw-r--r--  1 user group  1024 Apr 10 10:00 component${i}.tsx`,
    );
    const stdout = [header, dirEntry, ...tsxFiles].join("\n");
    const result = compressDirectoryListing(stdout, "", 0);
    expect(result).toContain("12 .tsx files");
    expect(result).toContain(dirEntry);
    expect(result).toContain("entries total");
  });

  test("keeps <=10 files individually", () => {
    const files = Array.from(
      { length: 3 },
      (_, i) => `-rw-r--r--  1 user group  512 Apr 10 10:00 file${i}.ts`,
    );
    const stdout = files.join("\n");
    const result = compressDirectoryListing(stdout, "", 0);
    expect(result).toContain("file0.ts");
    expect(result).toContain("file2.ts");
  });

  test("collapses find output by directory (>5 entries)", () => {
    const paths = Array.from(
      { length: 8 },
      (_, i) => `./src/components/file${i}.tsx`,
    );
    const stdout = paths.join("\n");
    const result = compressDirectoryListing(stdout, "", 0);
    expect(result).toContain("./src/components/ (8 files)");
    expect(result).toContain("entries total");
  });

  test("preserves directory entries", () => {
    const stdout = `total 40
drwxr-xr-x  3 user group  96 Apr 10 10:00 src
-rw-r--r--  1 user group 256 Apr 10 10:00 README.md`;
    const result = compressDirectoryListing(stdout, "", 0);
    expect(result).toContain("drwxr-xr-x");
    expect(result).toContain("src");
  });

  test("handles find with relative paths (src/file.ts style)", () => {
    const paths = Array.from(
      { length: 8 },
      (_, i) => `src/components/file${i}.tsx`,
    );
    const stdout = paths.join("\n");
    const result = compressDirectoryListing(stdout, "", 0);
    expect(result).toContain("src/components/ (8 files)");
    expect(result).toContain("entries total");
  });

  test("passes through error output", () => {
    const result = compressDirectoryListing("", "ls: no such file", 2);
    expect(result).toContain("ls: no such file");
  });
});

// ── search-results ──────────────────────────────────────────────────

describe("compressSearchResults", () => {
  test("groups matches by file", () => {
    const lines = [
      "src/app.ts:10:const foo = 1;",
      "src/app.ts:20:const bar = 2;",
      "src/lib.ts:5:import { x };",
    ];
    const result = compressSearchResults(lines.join("\n"), "", 0);
    expect(result).toContain("src/app.ts:10:");
    expect(result).toContain("src/lib.ts:5:");
    expect(result).toContain("2 files");
  });

  test("collapses >5 matches per file", () => {
    const lines = Array.from(
      { length: 8 },
      (_, i) => `src/big.ts:${i + 1}:match line ${i}`,
    );
    const result = compressSearchResults(lines.join("\n"), "", 0);
    expect(result).toContain("src/big.ts:1:");
    expect(result).toContain("src/big.ts:2:");
    expect(result).toContain("5 more matches");
    expect(result).toContain("src/big.ts:8:");
    expect(result).not.toContain("src/big.ts:4:");
  });

  test("preserves all unique file paths", () => {
    const lines = ["a.ts:1:x", "b.ts:1:y", "c.ts:1:z"];
    const result = compressSearchResults(lines.join("\n"), "", 0);
    expect(result).toContain("a.ts");
    expect(result).toContain("b.ts");
    expect(result).toContain("c.ts");
    expect(result).toContain("3 files");
  });

  test("keeps <=5 matches per file", () => {
    const lines = Array.from(
      { length: 4 },
      (_, i) => `src/small.ts:${i + 1}:line ${i}`,
    );
    const result = compressSearchResults(lines.join("\n"), "", 0);
    expect(result).toContain("src/small.ts:1:");
    expect(result).toContain("src/small.ts:4:");
    expect(result).not.toContain("more matches");
  });

  test("passes through error output", () => {
    const result = compressSearchResults("", "grep: invalid regex", 2);
    expect(result).toContain("grep: invalid regex");
  });
});

// ── build-lint ──────────────────────────────────────────────────────

describe("compressBuildOutput", () => {
  test("compresses successful build to summary", () => {
    const stdout = `info: checking crate...
info: loading modules...
note: using edition 2021
Compiling myapp v0.1.0
Finished dev [unoptimized + debuginfo] target(s) in 2.5s`;
    const result = compressBuildOutput(stdout, "", 0);
    expect(result).toContain("Build succeeded.");
    expect(result).not.toContain("info: checking");
    expect(result).not.toContain("info: loading");
  });

  test("includes warnings in success summary", () => {
    const stdout = `src/app.ts:10:5 - warning TS6133: 'x' is declared but never used.
src/app.ts:20:5 - warning TS6133: 'y' is declared but never used.
Found 0 errors and 2 warnings.`;
    const result = compressBuildOutput(stdout, "", 0);
    expect(result).toContain("Build succeeded.");
    expect(result).toContain("2 warning(s)");
    expect(result).toContain("warning TS6133");
  });

  test("preserves all errors on failure", () => {
    const stdout = `src/app.ts:10:5 - error TS2304: Cannot find name 'foo'.
src/app.ts:20:5 - error TS2304: Cannot find name 'bar'.
info: For more information, see...
note: Running with TypeScript 5.4
Found 2 errors.`;
    const result = compressBuildOutput(stdout, "", 1);
    expect(result).toContain("error TS2304: Cannot find name 'foo'");
    expect(result).toContain("error TS2304: Cannot find name 'bar'");
    expect(result).toContain("Found 2 errors.");
  });

  test("collapses info/note/help lines on failure", () => {
    const stdout = [
      "error[E0308]: mismatched types",
      "note: expected i32, found &str",
      "help: try using a conversion method",
      "info: some extra context",
      "error[E0277]: the trait bound is not satisfied",
    ].join("\n");
    const result = compressBuildOutput(stdout, "", 1);
    expect(result).toContain("error[E0308]");
    expect(result).toContain("error[E0277]");
    expect(result).toContain("info/note/help lines omitted");
  });

  test("preserves eslint errors", () => {
    const stdout = `src/app.ts
  10:5  error  Unexpected var  no-var
  20:5  error  Missing return  consistent-return

2 problems (2 errors, 0 warnings)`;
    const result = compressBuildOutput(stdout, "", 1);
    expect(result).toContain("error");
    expect(result).toContain("2 problems");
  });
});
