import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, mock, test } from "bun:test";

const testDir = realpathSync(mkdtempSync(join(tmpdir(), "view-image-test-")));

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  getRootDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getSocketPath: () => join(testDir, "test.sock"),
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    memory: {},
  }),
}));

await import("../tools/filesystem/view-image.js");

import { getTool } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";

afterAll(() => {
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

const tool = getTool("view_image")!;

function makeContext(workingDir: string = testDir): ToolContext {
  return {
    workingDir,
    sessionId: "test-session",
    conversationId: "test-conversation",
    trustClass: "guardian",
  };
}

// Minimal valid JPEG: FF D8 FF E0 header + enough bytes
const JPEG_HEADER = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01,
  0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
]);

// Minimal valid PNG header
const PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52,
]);

// Minimal valid GIF header
const GIF_HEADER = Buffer.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00,
]);

// Minimal valid WebP header (RIFF....WEBP)
const WEBP_HEADER = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56,
  0x50, 0x38, 0x20,
]);

// ── Success cases ───────────────────────────────────────────────────

describe("view_image tool", () => {
  test("loads a JPEG file", async () => {
    const imgPath = join(testDir, "test.jpg");
    writeFileSync(imgPath, JPEG_HEADER);

    const result = await tool.execute({ path: "test.jpg" }, makeContext());

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Image loaded");
    expect(result.content).toContain("image/jpeg");
    expect((result as any).contentBlocks).toBeDefined();
    expect((result as any).contentBlocks[0].type).toBe("image");
    expect((result as any).contentBlocks[0].source.media_type).toBe(
      "image/jpeg",
    );
  });

  test("loads a PNG file", async () => {
    const imgPath = join(testDir, "test.png");
    writeFileSync(imgPath, PNG_HEADER);

    const result = await tool.execute({ path: "test.png" }, makeContext());

    expect(result.isError).toBe(false);
    expect(result.content).toContain("image/png");
  });

  test("loads a GIF file", async () => {
    const imgPath = join(testDir, "test.gif");
    writeFileSync(imgPath, GIF_HEADER);

    const result = await tool.execute({ path: "test.gif" }, makeContext());

    expect(result.isError).toBe(false);
    expect(result.content).toContain("image/gif");
  });

  test("loads a WebP file", async () => {
    const imgPath = join(testDir, "test.webp");
    writeFileSync(imgPath, WEBP_HEADER);

    const result = await tool.execute({ path: "test.webp" }, makeContext());

    expect(result.isError).toBe(false);
    expect(result.content).toContain("image/webp");
  });

  test("loads image with absolute path", async () => {
    const imgPath = join(testDir, "absolute.jpg");
    writeFileSync(imgPath, JPEG_HEADER);

    const result = await tool.execute({ path: imgPath }, makeContext());

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Image loaded");
  });

  test("returns base64-encoded data in content blocks", async () => {
    const imgPath = join(testDir, "base64.jpg");
    writeFileSync(imgPath, JPEG_HEADER);

    const result = await tool.execute({ path: "base64.jpg" }, makeContext());

    expect(result.isError).toBe(false);
    const blocks = (result as any).contentBlocks;
    expect(blocks[0].source.type).toBe("base64");
    expect(blocks[0].source.data.length).toBeGreaterThan(0);
  });
});

// ── Error cases ─────────────────────────────────────────────────────

describe("view_image error handling", () => {
  test("rejects missing path", async () => {
    const result = await tool.execute({}, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("path is required");
  });

  test("rejects unsupported file extension", async () => {
    const txtPath = join(testDir, "readme.txt");
    writeFileSync(txtPath, "not an image");

    const result = await tool.execute({ path: "readme.txt" }, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("unsupported image format");
    expect(result.content).toContain(".txt");
  });

  test("rejects nonexistent file", async () => {
    const result = await tool.execute(
      { path: "nonexistent.jpg" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("file not found");
  });

  test("rejects directory path", async () => {
    const dirPath = join(testDir, "subdir");
    mkdirSync(dirPath, { recursive: true });
    // Create a .jpg-named directory
    const fakePath = join(testDir, "fakedir.jpg");
    mkdirSync(fakePath, { recursive: true });

    const result = await tool.execute({ path: "fakedir.jpg" }, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("is not a file");
  });

  test("blocks path traversal outside working directory", async () => {
    const result = await tool.execute(
      { path: "../../etc/passwd.jpg" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside the working directory");
  });

  test("rejects file with unrecognizable magic bytes", async () => {
    const imgPath = join(testDir, "corrupt.jpg");
    writeFileSync(
      imgPath,
      Buffer.from([
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ]),
    );

    const result = await tool.execute({ path: "corrupt.jpg" }, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("could not detect image format");
  });

  test("detects JPEG format from magic bytes regardless of extension", async () => {
    // Write JPEG magic bytes to a .png file
    const imgPath = join(testDir, "misnamed.png");
    writeFileSync(imgPath, JPEG_HEADER);

    const result = await tool.execute({ path: "misnamed.png" }, makeContext());

    expect(result.isError).toBe(false);
    // Should detect as JPEG from magic bytes, not PNG from extension
    expect(result.content).toContain("image/jpeg");
  });
});
