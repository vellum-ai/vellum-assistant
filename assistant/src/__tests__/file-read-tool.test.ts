import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { finalizeTool } from "../tools/tool-defaults.js";
import type { Tool, ToolContext } from "../tools/types.js";

let fileReadTool: Tool;
const testDirs: string[] = [];

beforeAll(async () => {
  const { fileReadTool: definition } =
    await import("../tools/filesystem/read.js");
  fileReadTool = finalizeTool(definition, "file_read");
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

  test("reads a file outside the workspace boundary (non-containerized)", async () => {
    const dir = makeTempDir();
    const outside = makeTempDir();
    const target = join(outside, "escape.txt");
    writeFileSync(target, "outside content");

    const result = await fileReadTool.execute(
      { path: target },
      makeContext(dir),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("outside content");
  });

  test("reads a file outside the workspace boundary when containerized", async () => {
    const dir = makeTempDir();
    const outside = makeTempDir();
    const target = join(outside, "reference.md");
    writeFileSync(target, "install tree content");
    process.env.IS_CONTAINERIZED = "true";
    try {
      const result = await fileReadTool.execute(
        { path: target },
        makeContext(dir),
      );

      expect(result.isError).toBe(false);
      expect(result.content).toContain("install tree content");
    } finally {
      delete process.env.IS_CONTAINERIZED;
    }
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

  test("reads an image outside the workspace boundary (non-containerized)", async () => {
    const dir = makeTempDir();
    const outside = makeTempDir();
    writeFileSync(join(outside, "photo.jpg"), JPEG_HEADER);

    const result = await fileReadTool.execute(
      { path: join(outside, "photo.jpg") },
      makeContext(dir),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Image loaded");
  });

  test("reads an image outside the workspace boundary when containerized", async () => {
    const dir = makeTempDir();
    const outside = makeTempDir();
    writeFileSync(join(outside, "diagram.jpg"), JPEG_HEADER);
    process.env.IS_CONTAINERIZED = "true";
    try {
      const result = await fileReadTool.execute(
        { path: join(outside, "diagram.jpg") },
        makeContext(dir),
      );

      expect(result.isError).toBe(false);
      expect(result.content).toContain("Image loaded");
    } finally {
      delete process.env.IS_CONTAINERIZED;
    }
  });
});

// ── Out-of-bounds hint for host_file_read ─────────────────────────────
//
// Reads leave the workspace freely, so the boundary only holds when the
// service security deny set cannot be mirrored: a relative override resolves
// against the owning service's cwd, so the policy fails closed.

describe("file_read out-of-bounds hint", () => {
  beforeEach(() => {
    process.env.IS_CONTAINERIZED = "true";
    process.env.GATEWAY_SECURITY_DIR = "relative/security-dir";
  });

  afterEach(() => {
    delete process.env.IS_CONTAINERIZED;
    delete process.env.GATEWAY_SECURITY_DIR;
  });

  test("suggests host_file_read for out-of-bounds text file path", async () => {
    const dir = makeTempDir();

    const result = await fileReadTool.execute(
      { path: "/etc/passwd" },
      makeContext(dir),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("host_file_read");
  });

  test("suggests host_file_read for out-of-bounds image file path", async () => {
    const dir = makeTempDir();

    const result = await fileReadTool.execute(
      { path: "/Users/someone/Desktop/screenshot.png" },
      makeContext(dir),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("host_file_read");
  });

  test("does not suggest host_file_read for missing file within sandbox", async () => {
    const dir = makeTempDir();

    const result = await fileReadTool.execute(
      { path: "nonexistent.txt" },
      makeContext(dir),
    );

    expect(result.isError).toBe(true);
    expect(result.content).not.toContain("host_file_read");
  });
});
