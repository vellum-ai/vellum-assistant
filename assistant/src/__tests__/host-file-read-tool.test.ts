import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { HostFileInput } from "../daemon/host-file-proxy.js";
import type { ToolExecutionResult } from "../tools/types.js";

// Mock HostFileProxy singleton so proxy delegation tests can control it.
let mockFileProxyAvailable = false;
let mockFileProxyRequestFn: (
  input: HostFileInput,
  conversationId: string,
  signal?: AbortSignal,
) => Promise<ToolExecutionResult> = () =>
  Promise.resolve({ content: "", isError: false });

mock.module("../daemon/host-file-proxy.js", () => ({
  HostFileProxy: {
    get instance() {
      return {
        isAvailable: () => mockFileProxyAvailable,
        request: mockFileProxyRequestFn,
      };
    },
  },
}));

import { hostFileReadTool } from "../tools/host-filesystem/read.js";
import { READ_CHAR_BUDGET } from "../tools/shared/filesystem/file-ops-service.js";
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
  mockFileProxyAvailable = false;
  mockFileProxyRequestFn = () =>
    Promise.resolve({ content: "", isError: false });
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

  test("reads a character window", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-file-read-test-"));
    testDirs.push(dir);
    const filePath = join(dir, "sample.txt");
    writeFileSync(filePath, "first\nsecond\nthird\n");

    const result = await hostFileReadTool.execute(
      { path: filePath, start_index: 6, max_chars: 6 },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("second");
    expect(result.content).not.toContain("first");
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
    expect(result.content).toContain('Invalid input for tool "host_file_read"');
  });

  test("rejects non-string path", async () => {
    const result = await hostFileReadTool.execute({ path: 42 }, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid input for tool "host_file_read"');
  });

  test("reads the whole file when no window is specified", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-file-read-test-"));
    testDirs.push(dir);
    const filePath = join(dir, "full.txt");
    writeFileSync(filePath, "line1\nline2\nline3\n");

    const result = await hostFileReadTool.execute(
      { path: filePath },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe("line1\nline2\nline3\n");
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

  test("start_index is 0-indexed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-file-read-test-"));
    testDirs.push(dir);
    const filePath = join(dir, "lines.txt");
    writeFileSync(filePath, "a\nb\nc\nd\ne\n");

    const result = await hostFileReadTool.execute(
      { path: filePath, start_index: 4, max_chars: 1 },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    const [body] = result.content.split("\n\n[Truncated:");
    expect(body).toBe("c");
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
  test("uses host proxy for image reads when available", async () => {
    const requests: Array<{
      input: HostFileInput;
      conversationId: string;
      signal?: AbortSignal;
    }> = [];
    mockFileProxyAvailable = true;
    mockFileProxyRequestFn = async (input, conversationId, signal) => {
      requests.push({ input, conversationId, signal });
      return {
        content: "Image loaded: /host/screenshot.png",
        isError: false,
        contentBlocks: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: PNG_HEADER.toString("base64"),
            },
          },
        ],
      };
    };
    const proxyContext: ToolContext = {
      ...makeContext(),
    };

    const result = await hostFileReadTool.execute(
      { path: "/host/screenshot.png" },
      proxyContext,
    );

    expect(result.isError).toBe(false);
    expect(result.contentBlocks).toHaveLength(1);
    // The proxied request carries the resolved default window, so a host read
    // is bounded by the same budget as a local one rather than streaming a
    // whole file across the bridge.
    expect(requests).toEqual([
      {
        input: {
          operation: "read",
          path: "/host/screenshot.png",
          startIndex: undefined,
          maxChars: READ_CHAR_BUDGET,
        },
        conversationId: "test-conversation",
        signal: undefined,
      },
    ]);
  });

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
    expect(result.content).toContain("hello world");
    expect(result.content).toContain("second line");
    expect((result as any).contentBlocks).toBeUndefined();
  });

  test("passes target_client_id to HostFileProxy.instance.request", async () => {
    const capturedInputs: HostFileInput[] = [];
    mockFileProxyAvailable = true;
    mockFileProxyRequestFn = async (input) => {
      capturedInputs.push(input);
      return { content: "proxied", isError: false };
    };

    await hostFileReadTool.execute(
      { path: "/host/notes.txt", target_client_id: "client-x" },
      makeContext(),
    );

    expect(capturedInputs).toHaveLength(1);
    expect(capturedInputs[0].targetClientId).toBe("client-x");
  });
});
