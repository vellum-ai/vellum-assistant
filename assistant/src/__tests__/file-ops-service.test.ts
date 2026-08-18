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

import { THRESHOLD_CHARS } from "../context/post-turn-tool-result-truncation.js";
import {
  FileSystemOps,
  type PathPolicy,
  READ_CHAR_BUDGET,
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

  test("respects startIndex and maxChars", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "lines.txt"), "a\nb\nc\nd\ne\n");
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = await ops.readFileSafe({
      path: "lines.txt",
      startIndex: 2,
      maxChars: 3,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const [body] = result.value.content.split("\n\n[Truncated:");
    expect(body).toBe("b\nc");
  });

  test("caps an unbounded read at the character budget and says so", async () => {
    const dir = makeTempDir();
    const total = READ_CHAR_BUDGET + 500;
    writeFileSync(join(dir, "big.txt"), "x".repeat(total));
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = await ops.readFileSafe({ path: "big.txt" });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const [body] = result.value.content.split("\n\n[Truncated:");
    expect(body).toHaveLength(READ_CHAR_BUDGET);
    expect(result.value.content).toContain(
      `[Truncated: characters 0-${READ_CHAR_BUDGET} of ${total}. Read on with start_index=${READ_CHAR_BUDGET}.]`,
    );
  });

  test("a maxChars above the budget is clamped to it", async () => {
    const dir = makeTempDir();
    const total = READ_CHAR_BUDGET + 500;
    writeFileSync(join(dir, "big.txt"), "x".repeat(total));
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = await ops.readFileSafe({
      path: "big.txt",
      maxChars: total,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const [body] = result.value.content.split("\n\n[Truncated:");
    expect(body).toHaveLength(READ_CHAR_BUDGET);
  });

  test("a maxChars below the budget is honored as given", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "big.txt"), "x".repeat(500));
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = await ops.readFileSafe({ path: "big.txt", maxChars: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const [body] = result.value.content.split("\n\n[Truncated:");
    expect(body).toHaveLength(10);
    expect(result.value.content).toContain(
      "[Truncated: characters 0-10 of 500. Read on with start_index=10.]",
    );
  });

  test("paging with the offset from a notice returns the next window", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "big.txt"), "abcdefghij");
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const first = await ops.readFileSafe({ path: "big.txt", maxChars: 4 });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    expect(first.value.content).toContain("start_index=4");

    const second = await ops.readFileSafe({
      path: "big.txt",
      startIndex: 4,
      maxChars: 4,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }
    const [body] = second.value.content.split("\n\n[Truncated:");
    expect(body).toBe("efgh");
  });

  test("a read that reaches the end carries no truncation notice", async () => {
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

    const result = await ops.readFileSafe({
      path: "small.txt",
      startIndex: 100,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.content).not.toContain("[Truncated:");
  });

  test("a window boundary inside a surrogate pair does not corrupt it", async () => {
    const dir = makeTempDir();
    // "ab" + a 2-unit emoji + "cd": a maxChars of 3 would split the pair.
    writeFileSync(join(dir, "emoji.txt"), `ab\u{1F600}cd`);
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = await ops.readFileSafe({ path: "emoji.txt", maxChars: 3 });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const [body] = result.value.content.split("\n\n[Truncated:");
    expect(body).toBe("ab");
    expect(body).not.toContain("\uFFFD");
  });

  test("paging across a surrogate pair reassembles the whole file", async () => {
    const dir = makeTempDir();
    const original = `ab\u{1F600}cd`;
    writeFileSync(join(dir, "emoji.txt"), original);
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    let assembled = "";
    let startIndex = 0;
    for (let i = 0; i < 10; i++) {
      const result = await ops.readFileSafe({
        path: "emoji.txt",
        startIndex,
        maxChars: 3,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      const [body] = result.value.content.split("\n\n[Truncated:");
      assembled += body;
      const match = /start_index=(\d+)/.exec(result.value.content);
      if (match?.[1] === undefined) {
        break;
      }
      startIndex = Number(match[1]);
    }
    expect(assembled).toBe(original);
  });

  test("a lone-low-surrogate startIndex backs up onto the whole pair", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "emoji.txt"), `ab\u{1F600}cd`);
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    // Index 3 (0-indexed) is the low half of the emoji.
    const result = await ops.readFileSafe({
      path: "emoji.txt",
      startIndex: 3,
      maxChars: 2,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const [body] = result.value.content.split("\n\n[Truncated:");
    expect(body).toBe(`\u{1F600}`);
    expect(body).not.toContain("\uFFFD");
  });

  test("legacy offset/limit are rejected rather than silently ignored", async () => {
    const { fileReadTool } = await import("../tools/filesystem/read.js");
    const dir = makeTempDir();
    writeFileSync(join(dir, "big.txt"), "x".repeat(500));

    const result = await fileReadTool.execute(
      { path: join(dir, "big.txt"), offset: 2001, limit: 2000 },
      { workingDir: dir } as never,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("no longer takes");
    expect(result.content).toContain("start_index");
  });

  test("legacy fields alongside current ones do not trigger the guard", async () => {
    const { fileReadTool } = await import("../tools/filesystem/read.js");
    const dir = makeTempDir();
    writeFileSync(join(dir, "big.txt"), "abcdefghij");

    const result = await fileReadTool.execute(
      { path: join(dir, "big.txt"), offset: 1, max_chars: 4 },
      { workingDir: dir } as never,
    );
    expect(result.isError).toBe(false);
    const [body] = result.content.split("\n\n[Truncated:");
    expect(body).toBe("abcd");
  });

  test("the read budget stays under the tool-result spool threshold", () => {
    expect(READ_CHAR_BUDGET).toBeLessThan(THRESHOLD_CHARS);
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
