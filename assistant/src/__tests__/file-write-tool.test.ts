import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";

import { getTool } from "../tools/registry.js";
import type { Tool, ToolContext } from "../tools/types.js";

let fileWriteTool: Tool;
const testDirs: string[] = [];

beforeAll(async () => {
  await import("../tools/filesystem/write.js");
  fileWriteTool = getTool("file_write")!;
});

function makeContext(workingDir: string): ToolContext {
  return {
    workingDir,
    conversationId: "test-conversation",
    trustClass: "guardian",
  };
}

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "file-write-test-")));
  testDirs.push(dir);
  return dir;
}

describe("file_write tool (sandbox)", () => {
  test("creates a new file", async () => {
    const dir = makeTempDir();

    const result = await fileWriteTool.execute(
      { path: "new.txt", content: "hello world" },
      makeContext(dir),
    );

    expect(result.isError).toBe(false);
    const filePath = join(dir, "new.txt");
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf-8")).toBe("hello world");
    expect(result.diff?.isNewFile).toBe(true);
  });

  test("overwrites existing file and returns diff", async () => {
    const dir = makeTempDir();
    const filePath = join(dir, "existing.txt");
    writeFileSync(filePath, "old content");

    const result = await fileWriteTool.execute(
      { path: "existing.txt", content: "new content" },
      makeContext(dir),
    );

    expect(result.isError).toBe(false);
    expect(readFileSync(filePath, "utf-8")).toBe("new content");
    expect(result.diff).toEqual({
      filePath,
      oldContent: "old content",
      newContent: "new content",
      isNewFile: false,
    });
  });

  test("creates nested directories", async () => {
    const dir = makeTempDir();

    const result = await fileWriteTool.execute(
      { path: "a/b/c/deep.txt", content: "deep content" },
      makeContext(dir),
    );

    expect(result.isError).toBe(false);
    const filePath = join(dir, "a", "b", "c", "deep.txt");
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf-8")).toBe("deep content");
  });

  test("blocks path traversal escape", async () => {
    const dir = makeTempDir();

    const result = await fileWriteTool.execute(
      { path: "../../escape.txt", content: "escaped" },
      makeContext(dir),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside the working directory");
  });

  test("blocks oversize content", async () => {
    const dir = makeTempDir();

    // Create content that exceeds the 100 MB limit
    const oversizeContent = "x".repeat(101 * 1024 * 1024);

    const result = await fileWriteTool.execute(
      { path: "big.txt", content: oversizeContent },
      makeContext(dir),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("exceeds");
  });
});
