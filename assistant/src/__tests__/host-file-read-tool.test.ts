import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { hostFileReadTool } from "../tools/host-filesystem/read.js";
import type { ToolContext } from "../tools/types.js";

const testDirs: string[] = [];

function makeContext(): ToolContext {
  return {
    workingDir: "/tmp",
    conversationId: "test-conversation",
    trustClass: "guardian",
  };
}

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("host_file_read tool", () => {
  test("rejects relative paths", async () => {
    const result = await hostFileReadTool.execute(
      { path: "relative.txt" },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("must be absolute");
  });

  test("reads file with line numbers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-file-read-test-"));
    testDirs.push(dir);
    const filePath = join(dir, "sample.txt");
    writeFileSync(filePath, "first\nsecond\nthird\n");

    const result = await hostFileReadTool.execute(
      { path: filePath, offset: 2, limit: 2 },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("2  second");
    expect(result.content).toContain("3  third");
  });

  test("returns error when file does not exist", async () => {
    const filePath = join(tmpdir(), `host-file-read-missing-${Date.now()}.txt`);
    const result = await hostFileReadTool.execute(
      { path: filePath },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("File not found");
  });

  test("returns error when path is a directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-file-read-test-"));
    testDirs.push(dir);
    const nestedDir = join(dir, "nested");
    mkdirSync(nestedDir, { recursive: true });

    const result = await hostFileReadTool.execute(
      { path: nestedDir },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("is not a regular file");
  });

  test("rejects missing path parameter", async () => {
    const result = await hostFileReadTool.execute({}, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("path is required");
  });

  test("rejects non-string path", async () => {
    const result = await hostFileReadTool.execute({ path: 42 }, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("path is required and must be a string");
  });

  test("reads entire file when no offset or limit specified", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-file-read-test-"));
    testDirs.push(dir);
    const filePath = join(dir, "full.txt");
    writeFileSync(filePath, "line1\nline2\nline3\n");

    const result = await hostFileReadTool.execute(
      { path: filePath },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("1  line1");
    expect(result.content).toContain("2  line2");
    expect(result.content).toContain("3  line3");
  });

  test("handles empty file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-file-read-test-"));
    testDirs.push(dir);
    const filePath = join(dir, "empty.txt");
    writeFileSync(filePath, "");

    const result = await hostFileReadTool.execute(
      { path: filePath },
      makeContext(),
    );
    expect(result.isError).toBe(false);
  });

  test("offset starts from the correct line (1-indexed)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-file-read-test-"));
    testDirs.push(dir);
    const filePath = join(dir, "lines.txt");
    writeFileSync(filePath, "a\nb\nc\nd\ne\n");

    const result = await hostFileReadTool.execute(
      { path: filePath, offset: 3, limit: 1 },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("3  c");
    expect(result.content).not.toContain("2  b");
    expect(result.content).not.toContain("4  d");
  });

  test("reads a file with symlinks resolved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-file-read-test-"));
    testDirs.push(dir);
    const realFile = join(dir, "real.txt");
    const linkFile = join(dir, "link.txt");
    writeFileSync(realFile, "symlink-content\n");
    const { symlinkSync } = await import("node:fs");
    symlinkSync(realFile, linkFile);

    const result = await hostFileReadTool.execute(
      { path: linkFile },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("symlink-content");
  });
});
