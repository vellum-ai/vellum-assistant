import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";

import { getTool } from "../tools/registry.js";
import type { Tool, ToolContext } from "../tools/types.js";

let fileReadTool: Tool;
const testDirs: string[] = [];

beforeAll(async () => {
  await import("../tools/filesystem/read.js");
  fileReadTool = getTool("file_read")!;
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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "file-read-test-")));
  testDirs.push(dir);
  return dir;
}

describe("file_read tool (sandbox)", () => {
  test("reads file with valid relative path in working dir", async () => {
    const dir = makeTempDir();
    const filePath = join(dir, "hello.txt");
    writeFileSync(filePath, "line one\nline two\nline three\n");

    const result = await fileReadTool.execute(
      { path: "hello.txt" },
      makeContext(dir),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("line one");
    expect(result.content).toContain("line two");
    expect(result.content).toContain("line three");
  });

  test("returns error for missing file", async () => {
    const dir = makeTempDir();

    const result = await fileReadTool.execute(
      { path: "nonexistent.txt" },
      makeContext(dir),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("File not found");
  });

  test("rejects directory path", async () => {
    const dir = makeTempDir();
    const nestedDir = join(dir, "subdir");
    mkdirSync(nestedDir);

    const result = await fileReadTool.execute(
      { path: "subdir" },
      makeContext(dir),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("is a directory");
  });

  test("rejects path traversal outside working dir", async () => {
    const dir = makeTempDir();

    const result = await fileReadTool.execute(
      { path: "../../../etc/passwd" },
      makeContext(dir),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside the working directory");
  });
});

// ── Image file support ────────────────────────────────────────────────

// Minimal valid JPEG: FF D8 FF E0 header
const JPEG_HEADER = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01,
  0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
]);

// Minimal valid PNG header
const PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52,
]);

describe("file_read image support", () => {
  test("returns image content block for .jpg file", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "photo.jpg"), JPEG_HEADER);

    const result = await fileReadTool.execute(
      { path: "photo.jpg" },
      makeContext(dir),
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

  test("returns image content block for .png file", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "screenshot.png"), PNG_HEADER);

    const result = await fileReadTool.execute(
      { path: "screenshot.png" },
      makeContext(dir),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("image/png");
    expect((result as any).contentBlocks).toBeDefined();
  });

  test("ignores offset/limit for image files", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "img.jpg"), JPEG_HEADER);

    const result = await fileReadTool.execute(
      { path: "img.jpg", offset: 5, limit: 10 },
      makeContext(dir),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Image loaded");
  });

  test("returns error for missing image file", async () => {
    const dir = makeTempDir();

    const result = await fileReadTool.execute(
      { path: "missing.jpg" },
      makeContext(dir),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("file not found");
  });

  test("blocks image path traversal outside working dir", async () => {
    const dir = makeTempDir();

    const result = await fileReadTool.execute(
      { path: "../../etc/secret.png" },
      makeContext(dir),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside the working directory");
  });
});
