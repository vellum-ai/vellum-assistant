import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  FileSystemOps,
  type PathPolicy,
} from "../tools/shared/filesystem/file-ops-service.js";
import {
  formatEditDiff,
  formatWriteSummary,
} from "../tools/shared/filesystem/format-diff.js";
import { sandboxPolicy } from "../tools/shared/filesystem/path-policy.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const testDirs: string[] = [];

function makeTempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fs-tools-test-")));
  testDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function sandboxPolicyFor(boundary: string): PathPolicy {
  return (rawPath, options) => sandboxPolicy(rawPath, boundary, options);
}

// ===========================================================================
// FileSystemOps: symlink handling through read/write/edit
// ===========================================================================

describe("FileSystemOps symlink handling", () => {
  test("read blocks symlink pointing outside boundary", () => {
    const boundary = makeTempDir();
    const outside = makeTempDir();
    const outsideFile = join(outside, "secret.txt");
    writeFileSync(outsideFile, "secret data");

    symlinkSync(outsideFile, join(boundary, "link.txt"));
    const ops = new FileSystemOps(sandboxPolicyFor(boundary));

    const result = ops.readFileSafe({ path: "link.txt" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PATH_OUT_OF_BOUNDS");
  });

  test("read allows symlink within boundary", () => {
    const boundary = makeTempDir();
    const realFile = join(boundary, "real.txt");
    writeFileSync(realFile, "hello");
    symlinkSync(realFile, join(boundary, "link.txt"));

    const ops = new FileSystemOps(sandboxPolicyFor(boundary));
    const result = ops.readFileSafe({ path: "link.txt" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content).toContain("hello");
  });

  test("write blocks creating file under symlinked dir pointing outside", () => {
    const boundary = makeTempDir();
    const outside = makeTempDir();
    symlinkSync(outside, join(boundary, "link-dir"));

    const ops = new FileSystemOps(sandboxPolicyFor(boundary));
    const result = ops.writeFileSafe({
      path: "link-dir/evil.txt",
      content: "bad",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PATH_OUT_OF_BOUNDS");
    // The file must NOT have been written to the outside directory
    expect(existsSync(join(outside, "evil.txt"))).toBe(false);
  });

  test("edit blocks symlink pointing outside boundary", () => {
    const boundary = makeTempDir();
    const outside = makeTempDir();
    const outsideFile = join(outside, "target.txt");
    writeFileSync(outsideFile, "original");
    symlinkSync(outsideFile, join(boundary, "link.txt"));

    const ops = new FileSystemOps(sandboxPolicyFor(boundary));
    const result = ops.editFileSafe({
      path: "link.txt",
      oldString: "original",
      newString: "modified",
      replaceAll: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PATH_OUT_OF_BOUNDS");
    // The outside file must NOT have been modified
    expect(readFileSync(outsideFile, "utf-8")).toBe("original");
  });
});

// ===========================================================================
// FileSystemOps: read offset/limit edge cases
// ===========================================================================

describe("FileSystemOps read offset/limit edge cases", () => {
  test("offset beyond file length returns empty content", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "short.txt"), "a\nb\nc");
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = ops.readFileSafe({ path: "short.txt", offset: 100 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content).toBe("");
  });

  test("limit of zero returns empty content", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "file.txt"), "a\nb\nc");
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = ops.readFileSafe({ path: "file.txt", limit: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content).toBe("");
  });

  test("offset=1 reads from first line (1-indexed)", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "file.txt"), "first\nsecond\nthird");
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = ops.readFileSafe({ path: "file.txt", offset: 1, limit: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content).toContain("first");
    expect(result.value.content).not.toContain("second");
  });

  test("limit exceeding file length returns all remaining lines", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "file.txt"), "a\nb");
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = ops.readFileSafe({
      path: "file.txt",
      offset: 1,
      limit: 1000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content).toContain("a");
    expect(result.value.content).toContain("b");
  });

  test("read adds line numbers starting from offset", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "file.txt"), "a\nb\nc\nd\ne");
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = ops.readFileSafe({ path: "file.txt", offset: 3, limit: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Lines should be numbered 3 and 4
    expect(result.value.content).toContain("3");
    expect(result.value.content).toContain("4");
    expect(result.value.content).toContain("c");
    expect(result.value.content).toContain("d");
  });
});

// ===========================================================================
// FileSystemOps: edit with whitespace-normalized and fuzzy matches
// ===========================================================================

describe("FileSystemOps edit match methods", () => {
  test("whitespace-normalized match succeeds", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "file.txt"),
      "  function foo() {\n    return 1;\n  }\n",
    );
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = ops.editFileSafe({
      path: "file.txt",
      oldString: "function foo() {\n  return 1;\n}",
      newString: "function bar() {\n  return 2;\n}",
      replaceAll: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.matchMethod).toBe("whitespace");
    expect(result.value.similarity).toBe(1);
    expect(result.value.newContent).toContain("bar");
  });

  test("fuzzy match succeeds with near-match", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "file.txt"), "function fooo() {\n  return 1;\n}\n");
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = ops.editFileSafe({
      path: "file.txt",
      oldString: "function foo() {\n  return 1;\n}",
      newString: "function bar() {\n  return 2;\n}",
      replaceAll: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.matchMethod).toBe("fuzzy");
    expect(result.value.similarity).toBeGreaterThan(0.8);
    expect(result.value.similarity).toBeLessThan(1);
  });

  test("edit returns actualOld and actualNew for fuzzy match", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "file.txt"), "function fooo() {\n  return 1;\n}\n");
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = ops.editFileSafe({
      path: "file.txt",
      oldString: "function foo() {\n  return 1;\n}",
      newString: "function bar() {\n  return 2;\n}",
      replaceAll: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // actualOld should be the text as it appeared in the file
    expect(result.value.actualOld).toContain("fooo");
  });
});

// ===========================================================================
// FileSystemOps: write overwrites and oldContent tracking
// ===========================================================================

describe("FileSystemOps write content tracking", () => {
  test("new file has empty oldContent", () => {
    const dir = makeTempDir();
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = ops.writeFileSafe({ path: "brand-new.txt", content: "new" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.oldContent).toBe("");
    expect(result.value.isNewFile).toBe(true);
  });

  test("overwrite tracks oldContent and newContent", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "existing.txt"), "version 1");
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = ops.writeFileSafe({
      path: "existing.txt",
      content: "version 2",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.oldContent).toBe("version 1");
    expect(result.value.newContent).toBe("version 2");
    expect(result.value.isNewFile).toBe(false);
  });

  test("write returns resolved absolute path", () => {
    const dir = makeTempDir();
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = ops.writeFileSafe({ path: "output.txt", content: "data" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.filePath).toBe(join(dir, "output.txt"));
  });
});

// ===========================================================================
// formatEditDiff
// ===========================================================================

describe("formatEditDiff", () => {
  test("shows removed and added lines", () => {
    const result = formatEditDiff("old line", "new line");
    expect(result).toContain("- old line");
    expect(result).toContain("+ new line");
  });

  test("handles multi-line changes", () => {
    const result = formatEditDiff("a\nb\nc", "x\ny\nz");
    expect(result).toContain("- a");
    expect(result).toContain("- b");
    expect(result).toContain("- c");
    expect(result).toContain("+ x");
    expect(result).toContain("+ y");
    expect(result).toContain("+ z");
  });

  test("handles empty old string (pure addition)", () => {
    const result = formatEditDiff("", "added");
    expect(result).not.toContain("- ");
    expect(result).toContain("+ added");
  });

  test("handles empty new string (pure deletion)", () => {
    const result = formatEditDiff("removed", "");
    expect(result).toContain("- removed");
    expect(result).not.toContain("+ ");
  });

  test("includes all lines without truncation for long diffs", () => {
    const longOld = Array.from({ length: 12 }, (_, i) => `old-line-${i}`).join(
      "\n",
    );
    const result = formatEditDiff(longOld, "short");
    expect(result).not.toContain("more lines");
    for (let i = 0; i < 12; i++) {
      expect(result).toContain(`- old-line-${i}`);
    }
    expect(result).toContain("+ short");
  });
});

// ===========================================================================
// formatWriteSummary
// ===========================================================================

describe("formatWriteSummary", () => {
  test("new file summary includes line count", () => {
    const result = formatWriteSummary("", "line1\nline2\nline3", true);
    expect(result).toContain("new file");
    expect(result).toContain("3 lines");
  });

  test("new file with single line uses singular", () => {
    const result = formatWriteSummary("", "single", true);
    expect(result).toContain("1 line");
    expect(result).not.toContain("1 lines");
  });

  test("overwrite summary shows line count change", () => {
    const result = formatWriteSummary("a\nb", "x\ny\nz", false);
    expect(result).toContain("2");
    expect(result).toContain("3");
  });
});

// ===========================================================================
// FileSystemOps: path traversal patterns
// ===========================================================================

describe("FileSystemOps path traversal prevention", () => {
  test("rejects absolute path outside boundary on read", () => {
    const dir = makeTempDir();
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = ops.readFileSafe({ path: "/etc/passwd" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PATH_OUT_OF_BOUNDS");
  });

  test("rejects absolute path outside boundary on write", () => {
    const dir = makeTempDir();
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = ops.writeFileSafe({
      path: "/tmp/evil-write.txt",
      content: "bad",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PATH_OUT_OF_BOUNDS");
  });

  test("rejects absolute path outside boundary on edit", () => {
    const dir = makeTempDir();
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = ops.editFileSafe({
      path: "/etc/hosts",
      oldString: "a",
      newString: "b",
      replaceAll: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PATH_OUT_OF_BOUNDS");
  });

  test("rejects dot-dot traversal embedded in path on read", () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, "sub"));
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = ops.readFileSafe({ path: "sub/../../etc/passwd" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PATH_OUT_OF_BOUNDS");
  });

  test("accepts absolute path inside boundary", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "inside.txt"), "safe content");
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = ops.readFileSafe({ path: join(dir, "inside.txt") });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content).toContain("safe content");
  });
});

// ===========================================================================
// FileSystemOps: binary file handling on read
// ===========================================================================

describe("FileSystemOps binary file read", () => {
  test("reads binary content as utf-8 without crashing", () => {
    const dir = makeTempDir();
    const binaryContent = Buffer.from([0x00, 0xff, 0x89, 0x50, 0x4e, 0x47]);
    writeFileSync(join(dir, "binary.bin"), binaryContent);
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = ops.readFileSafe({ path: "binary.bin" });
    // Should succeed — the file is readable, even if content has replacement chars
    expect(result.ok).toBe(true);
  });
});

// ===========================================================================
// FileSystemOps: empty file handling
// ===========================================================================

describe("FileSystemOps empty file operations", () => {
  test("reads empty file successfully", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "empty.txt"), "");
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = ops.readFileSafe({ path: "empty.txt" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Empty file still has one "line" (the empty string before any newline)
    expect(result.value.content).toBeDefined();
  });

  test("write empty content creates empty file", () => {
    const dir = makeTempDir();
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = ops.writeFileSafe({ path: "empty.txt", content: "" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.isNewFile).toBe(true);
    expect(readFileSync(join(dir, "empty.txt"), "utf-8")).toBe("");
  });

  test("edit on empty file returns MATCH_NOT_FOUND", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "empty.txt"), "");
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = ops.editFileSafe({
      path: "empty.txt",
      oldString: "something",
      newString: "else",
      replaceAll: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("MATCH_NOT_FOUND");
  });
});

// ===========================================================================
// FileSystemOps: container /workspace path remapping
// ===========================================================================

describe("FileSystemOps /workspace path remapping", () => {
  test("read remaps /workspace/ path to boundary", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "file.txt"), "workspace content");
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = ops.readFileSafe({ path: "/workspace/file.txt" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content).toContain("workspace content");
  });

  test("write remaps /workspace/ path to boundary", () => {
    const dir = makeTempDir();
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = ops.writeFileSafe({
      path: "/workspace/new.txt",
      content: "remapped",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(existsSync(join(dir, "new.txt"))).toBe(true);
    expect(readFileSync(join(dir, "new.txt"), "utf-8")).toBe("remapped");
  });

  test("edit remaps /workspace/ path to boundary", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "file.txt"), "old content");
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = ops.editFileSafe({
      path: "/workspace/file.txt",
      oldString: "old content",
      newString: "new content",
      replaceAll: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.newContent).toBe("new content");
    expect(readFileSync(join(dir, "file.txt"), "utf-8")).toBe("new content");
  });

  test("/workspace traversal escape is blocked", () => {
    const dir = makeTempDir();
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = ops.readFileSafe({ path: "/workspace/../../../etc/passwd" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PATH_OUT_OF_BOUNDS");
  });
});

// ===========================================================================
// FileSystemOps: custom size limit enforcement
// ===========================================================================

describe("FileSystemOps custom size limit", () => {
  test("read rejects file exceeding custom limit", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "big.txt"), "x".repeat(500));
    const ops = new FileSystemOps(sandboxPolicyFor(dir), { sizeLimit: 100 });

    const result = ops.readFileSafe({ path: "big.txt" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("SIZE_LIMIT_EXCEEDED");
  });

  test("read accepts file within custom limit", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "small.txt"), "x".repeat(50));
    const ops = new FileSystemOps(sandboxPolicyFor(dir), { sizeLimit: 100 });

    const result = ops.readFileSafe({ path: "small.txt" });
    expect(result.ok).toBe(true);
  });

  test("write rejects content exceeding custom limit", () => {
    const dir = makeTempDir();
    const ops = new FileSystemOps(sandboxPolicyFor(dir), { sizeLimit: 100 });

    const result = ops.writeFileSafe({
      path: "big.txt",
      content: "x".repeat(500),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("SIZE_LIMIT_EXCEEDED");
  });

  test("edit rejects file exceeding custom limit", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "big.txt"), "x".repeat(500));
    const ops = new FileSystemOps(sandboxPolicyFor(dir), { sizeLimit: 100 });

    const result = ops.editFileSafe({
      path: "big.txt",
      oldString: "x",
      newString: "y",
      replaceAll: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("SIZE_LIMIT_EXCEEDED");
  });

  test("no size limit when not specified (defaults to 100MB)", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "file.txt"), "x".repeat(1000));
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = ops.readFileSafe({ path: "file.txt" });
    expect(result.ok).toBe(true);
  });
});
