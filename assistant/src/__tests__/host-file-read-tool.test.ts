import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { hostFileReadTool } from "../tools/host-filesystem/read.js";
import type { ToolContext } from "../tools/types.js";

const testDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "host-file-read-test-"));
  testDirs.push(dir);
  return dir;
}

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

// Minimal valid JPEG: FF D8 FF E0 header
const JPEG_HEADER = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01,
  0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
]);

// Minimal PNG header
const PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52,
]);

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

describe("host_file_read image support", () => {
  test("returns image content block for .png file", async () => {
    const dir = makeTempDir();
    const filePath = join(dir, "screenshot.png");
    writeFileSync(filePath, PNG_HEADER);

    const result = await hostFileReadTool.execute(
      { path: filePath },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Image loaded");
    expect(result.content).toContain("image/png");
    expect((result as any).contentBlocks).toBeDefined();
    expect((result as any).contentBlocks[0].type).toBe("image");
    expect((result as any).contentBlocks[0].source.media_type).toBe(
      "image/png",
    );
  });

  test("returns correct media type for .jpg file", async () => {
    const dir = makeTempDir();
    const filePath = join(dir, "photo.jpg");
    writeFileSync(filePath, JPEG_HEADER);

    const result = await hostFileReadTool.execute(
      { path: filePath },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Image loaded");
    expect(result.content).toContain("image/jpeg");
    expect((result as any).contentBlocks).toBeDefined();
    expect((result as any).contentBlocks[0].type).toBe("image");
    expect((result as any).contentBlocks[0].source.media_type).toBe(
      "image/jpeg",
    );
  });

  test("returns error for non-existent image path", async () => {
    const filePath = join(tmpdir(), `host-file-read-missing-${Date.now()}.png`);
    const result = await hostFileReadTool.execute(
      { path: filePath },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("file not found");
  });

  test("text file still works as before (regression)", async () => {
    const dir = makeTempDir();
    const filePath = join(dir, "notes.txt");
    writeFileSync(filePath, "hello world\nsecond line\n");

    const result = await hostFileReadTool.execute(
      { path: filePath },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("1  hello world");
    expect(result.content).toContain("2  second line");
    expect((result as any).contentBlocks).toBeUndefined();
  });
});
