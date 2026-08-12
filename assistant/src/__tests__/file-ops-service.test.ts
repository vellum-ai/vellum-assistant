import {
  existsSync,
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
  DEFAULT_READ_LINE_LIMIT,
  FileSystemOps,
  type PathPolicy,
} from "../tools/shared/filesystem/file-ops-service.js";
import { sandboxPolicy } from "../tools/shared/filesystem/path-policy.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const testDirs: string[] = [];

function makeTempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "file-ops-test-")));
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
// readFileSafe
// ---------------------------------------------------------------------------

describe("FileSystemOps.readFileSafe", () => {
  test("reads a file successfully", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "hello.txt"), "line one\nline two\nline three\n");
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = await ops.readFileSafe({ path: "hello.txt" });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.content).toContain("line one");
    expect(result.value.content).toContain("line two");
    expect(result.value.content).toContain("line three");
  });

  test("returns NOT_FOUND for missing file", async () => {
    const dir = makeTempDir();
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = await ops.readFileSafe({ path: "nonexistent.txt" });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("NOT_FOUND");
  });

  test("returns NOT_A_FILE for a directory", async () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, "subdir"));
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = await ops.readFileSafe({ path: "subdir" });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("NOT_A_FILE");
  });

  test("returns SIZE_LIMIT_EXCEEDED for oversized file", async () => {
    const dir = makeTempDir();
    const filePath = join(dir, "big.txt");
    writeFileSync(filePath, "x".repeat(200));

    const ops = new FileSystemOps(sandboxPolicyFor(dir), { sizeLimit: 100 });
    const result = await ops.readFileSafe({ path: "big.txt" });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("SIZE_LIMIT_EXCEEDED");
  });

  test("returns PATH_OUT_OF_BOUNDS for path outside sandbox", async () => {
    const dir = makeTempDir();
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = await ops.readFileSafe({ path: "../../../etc/passwd" });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("PATH_OUT_OF_BOUNDS");
  });

  test("respects offset and limit", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "lines.txt"), "a\nb\nc\nd\ne\n");
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = await ops.readFileSafe({
      path: "lines.txt",
      offset: 2,
      limit: 2,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // Assert on the numbered lines rather than bare letters: the truncation
    // notice is prose, so a bare `toContain("d")` matches its wording.
    const [body] = result.value.content.split("\n\n[Truncated:");
    expect(body).toContain("     2  b");
    expect(body).toContain("     3  c");
    expect(body).not.toContain("     1  a");
    expect(body).not.toContain("     4  d");
  });

  test("caps an unbounded read at the default line limit and says so", async () => {
    const dir = makeTempDir();
    const total = DEFAULT_READ_LINE_LIMIT + 500;
    const lines = Array.from({ length: total }, (_, i) => `line${i + 1}`);
    writeFileSync(join(dir, "big.txt"), lines.join("\n"));
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = await ops.readFileSafe({ path: "big.txt" });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const content = result.value.content;
    expect(content).toContain(`  ${DEFAULT_READ_LINE_LIMIT}  line2000`);
    expect(content).not.toContain("line2001");
    expect(content).toContain(
      `[Truncated: showing through line ${DEFAULT_READ_LINE_LIMIT} of ${total}. Read on with offset=${DEFAULT_READ_LINE_LIMIT + 1}`,
    );
  });

  test("an explicit limit is honored rather than replaced by the default", async () => {
    const dir = makeTempDir();
    const lines = Array.from(
      { length: DEFAULT_READ_LINE_LIMIT + 500 },
      (_, i) => `line${i + 1}`,
    );
    writeFileSync(join(dir, "big.txt"), lines.join("\n"));
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = await ops.readFileSafe({
      path: "big.txt",
      limit: DEFAULT_READ_LINE_LIMIT + 500,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.content).toContain("line2500");
    expect(result.value.content).not.toContain("[Truncated:");
  });

  test("a read that reaches the last line carries no truncation notice", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "small.txt"), "a\nb\nc");
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = await ops.readFileSafe({ path: "small.txt" });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.content).not.toContain("[Truncated:");
  });

  test("paging past the end is not reported as truncation", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "small.txt"), "a\nb\nc");
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = await ops.readFileSafe({ path: "small.txt", offset: 100 });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.content).not.toContain("[Truncated:");
  });
});

// ---------------------------------------------------------------------------
// writeFileSafe
// ---------------------------------------------------------------------------

describe("FileSystemOps.writeFileSafe", () => {
  test("writes a new file", async () => {
    const dir = makeTempDir();
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = await ops.writeFileSafe({
      path: "new.txt",
      content: "hello world",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.isNewFile).toBe(true);
    expect(result.value.newContent).toBe("hello world");
    expect(result.value.oldContent).toBe("");
    expect(existsSync(join(dir, "new.txt"))).toBe(true);
  });

  test("overwrites an existing file and returns old content", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "existing.txt"), "old stuff");
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = await ops.writeFileSafe({
      path: "existing.txt",
      content: "new stuff",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.isNewFile).toBe(false);
    expect(result.value.oldContent).toBe("old stuff");
    expect(result.value.newContent).toBe("new stuff");
  });

  test("creates parent directories when needed", async () => {
    const dir = makeTempDir();
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = await ops.writeFileSafe({
      path: "a/b/c/deep.txt",
      content: "deep",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.isNewFile).toBe(true);
    expect(existsSync(join(dir, "a/b/c/deep.txt"))).toBe(true);
  });

  test("returns PATH_OUT_OF_BOUNDS for path outside sandbox", async () => {
    const dir = makeTempDir();
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = await ops.writeFileSafe({
      path: "../../../tmp/evil.txt",
      content: "bad",
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("PATH_OUT_OF_BOUNDS");
  });

  test("returns SIZE_LIMIT_EXCEEDED for oversized content", async () => {
    const dir = makeTempDir();
    const ops = new FileSystemOps(sandboxPolicyFor(dir), { sizeLimit: 10 });

    const result = await ops.writeFileSafe({
      path: "big.txt",
      content: "x".repeat(50),
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("SIZE_LIMIT_EXCEEDED");
  });
});

// ---------------------------------------------------------------------------
// editFileSafe
// ---------------------------------------------------------------------------

describe("FileSystemOps.editFileSafe", () => {
  test("concurrent edits of the same file both land", async () => {
    const dir = makeTempDir();
    const ops = new FileSystemOps(sandboxPolicyFor(dir));
    writeFileSync(join(dir, "shared.txt"), "alpha\nbeta\n");

    // Without per-path serialization, both edits read the same original
    // content and the later write drops the earlier edit.
    const [first, second] = await Promise.all([
      ops.editFileSafe({
        path: "shared.txt",
        oldString: "alpha",
        newString: "ALPHA",
        replaceAll: false,
      }),
      ops.editFileSafe({
        path: "shared.txt",
        oldString: "beta",
        newString: "BETA",
        replaceAll: false,
      }),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const read = await ops.readFileSafe({ path: "shared.txt" });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value.content).toContain("ALPHA");
      expect(read.value.content).toContain("BETA");
    }
  });

  test("returns NOT_FOUND for nonexistent file", async () => {
    const dir = makeTempDir();
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = await ops.editFileSafe({
      path: "nope.txt",
      oldString: "a",
      newString: "b",
      replaceAll: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("NOT_FOUND");
  });

  test("returns NOT_A_FILE when target is a directory", async () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, "subdir"));
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = await ops.editFileSafe({
      path: "subdir",
      oldString: "a",
      newString: "b",
      replaceAll: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("NOT_A_FILE");
  });

  test("returns MATCH_NOT_FOUND when old_string is absent", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "file.txt"), "hello world");
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = await ops.editFileSafe({
      path: "file.txt",
      oldString: "xyz",
      newString: "abc",
      replaceAll: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("MATCH_NOT_FOUND");
  });

  test("returns MATCH_AMBIGUOUS when old_string matches multiple times", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "file.txt"), "foo bar foo baz foo");
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = await ops.editFileSafe({
      path: "file.txt",
      oldString: "foo",
      newString: "qux",
      replaceAll: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("MATCH_AMBIGUOUS");
  });

  test("replaces all occurrences when replaceAll is true", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "file.txt"), "foo bar foo baz foo");
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = await ops.editFileSafe({
      path: "file.txt",
      oldString: "foo",
      newString: "qux",
      replaceAll: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.matchCount).toBe(3);
    expect(result.value.newContent).toBe("qux bar qux baz qux");
    expect(result.value.oldContent).toBe("foo bar foo baz foo");
    expect(result.value.matchMethod).toBe("exact");
  });

  test("performs a unique edit successfully", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "file.txt"), "one two three");
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = await ops.editFileSafe({
      path: "file.txt",
      oldString: "two",
      newString: "TWO",
      replaceAll: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.matchCount).toBe(1);
    expect(result.value.newContent).toBe("one TWO three");
    expect(result.value.matchMethod).toBe("exact");
    expect(result.value.filePath).toContain("file.txt");
  });

  test("returns MATCH_NOT_FOUND for empty oldString", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "file.txt"), "hello world");
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = await ops.editFileSafe({
      path: "file.txt",
      oldString: "",
      newString: "injected",
      replaceAll: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("MATCH_NOT_FOUND");
  });

  test("returns SIZE_LIMIT_EXCEEDED for oversized file on edit", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "big.txt"), "x".repeat(200));
    const ops = new FileSystemOps(sandboxPolicyFor(dir), { sizeLimit: 100 });

    const result = await ops.editFileSafe({
      path: "big.txt",
      oldString: "x",
      newString: "y",
      replaceAll: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("SIZE_LIMIT_EXCEEDED");
  });

  test("returns PATH_OUT_OF_BOUNDS for path outside sandbox", async () => {
    const dir = makeTempDir();
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = await ops.editFileSafe({
      path: "../../../etc/passwd",
      oldString: "root",
      newString: "toor",
      replaceAll: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("PATH_OUT_OF_BOUNDS");
  });
});
