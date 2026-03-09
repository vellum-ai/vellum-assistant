/**
 * Tests for workspace HTTP endpoints and utility functions.
 *
 * Covers path resolution (traversal prevention), MIME type detection,
 * directory listing, file metadata, and raw content serving with range support.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Create a temp workspace directory for isolation
// ---------------------------------------------------------------------------

const testWorkspaceDir = realpathSync(
  mkdtempSync(join(tmpdir(), "workspace-routes-test-")),
);

// Mock platform module so getWorkspaceDir returns our temp dir
mock.module("../../util/platform.js", () => ({
  getWorkspaceDir: () => testWorkspaceDir,
  getRootDir: () => testWorkspaceDir,
  getDataDir: () => testWorkspaceDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
}));

import { workspaceRouteDefinitions } from "./workspace-routes.js";
import { isTextMimeType, resolveWorkspacePath } from "./workspace-utils.js";

// ---------------------------------------------------------------------------
// Set up test filesystem structure
// ---------------------------------------------------------------------------

const subDir = join(testWorkspaceDir, "subdir");
const textFile = join(testWorkspaceDir, "hello.txt");
const jsonFile = join(testWorkspaceDir, "data.json");
const nestedFile = join(subDir, "nested.txt");
const binaryFile = join(testWorkspaceDir, "image.png");
const dotenvFile = join(testWorkspaceDir, ".env");
const dotDir = join(testWorkspaceDir, ".hidden");

beforeAll(() => {
  mkdirSync(subDir, { recursive: true });
  mkdirSync(dotDir, { recursive: true });
  writeFileSync(textFile, "Hello, world!");
  writeFileSync(jsonFile, '{"key":"value"}');
  writeFileSync(nestedFile, "nested content");
  writeFileSync(dotenvFile, "SECRET=hunter2");
  writeFileSync(join(dotDir, "secret.txt"), "hidden content");
  // Write a minimal PNG (8-byte signature + IHDR + IEND)
  const pngSignature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  writeFileSync(binaryFile, pngSignature);
});

afterAll(() => {
  rmSync(testWorkspaceDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a RouteContext-like object for handler testing. */
function makeCtx(
  searchParams: Record<string, string>,
  headers?: Record<string, string>,
) {
  const url = new URL("http://localhost/v1/workspace/tree");
  for (const [k, v] of Object.entries(searchParams)) {
    url.searchParams.set(k, v);
  }
  return {
    url,
    req: new Request(url, { headers: headers ?? {} }),
    server: {} as ReturnType<typeof Bun.serve>,
    authContext: {} as never,
    params: {},
  };
}

function getHandler(endpoint: string) {
  const routes = workspaceRouteDefinitions();
  const route = routes.find((r) => r.endpoint === endpoint);
  if (!route) throw new Error(`No route found for endpoint: ${endpoint}`);
  return route.handler;
}

/** Build a RouteContext-like object for POST handler testing with a JSON body. */
function makePostCtx(body: unknown) {
  const url = new URL("http://localhost/v1/workspace/write");
  return {
    url,
    req: new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    server: {} as ReturnType<typeof Bun.serve>,
    authContext: {} as never,
    params: {},
  };
}

// ===========================================================================
// resolveWorkspacePath
// ===========================================================================

describe("resolveWorkspacePath", () => {
  test("valid relative path resolves correctly", () => {
    const result = resolveWorkspacePath("hello.txt");
    expect(result).toBe(join(testWorkspaceDir, "hello.txt"));
  });

  test("../ path returns undefined", () => {
    const result = resolveWorkspacePath("../");
    expect(result).toBeUndefined();
  });

  test("absolute path outside workspace returns undefined", () => {
    const result = resolveWorkspacePath("/etc/passwd");
    expect(result).toBeUndefined();
  });

  test("path with .. in middle escaping workspace returns undefined", () => {
    const result = resolveWorkspacePath("skills/../../../etc/passwd");
    expect(result).toBeUndefined();
  });

  test("empty string resolves to workspace root", () => {
    const result = resolveWorkspacePath("");
    expect(result).toBe(testWorkspaceDir);
  });

  test("valid nested relative path resolves correctly", () => {
    const result = resolveWorkspacePath("subdir/nested.txt");
    expect(result).toBe(join(testWorkspaceDir, "subdir", "nested.txt"));
  });

  test(".. that stays within workspace resolves correctly", () => {
    const result = resolveWorkspacePath("subdir/../hello.txt");
    expect(result).toBe(join(testWorkspaceDir, "hello.txt"));
  });
});

// ===========================================================================
// isTextMimeType
// ===========================================================================

describe("isTextMimeType", () => {
  test("text/plain is text", () => {
    expect(isTextMimeType("text/plain")).toBe(true);
  });

  test("text/markdown is text", () => {
    expect(isTextMimeType("text/markdown")).toBe(true);
  });

  test("application/json is text", () => {
    expect(isTextMimeType("application/json")).toBe(true);
  });

  test("application/javascript is text", () => {
    expect(isTextMimeType("application/javascript")).toBe(true);
  });

  test("application/xml is text", () => {
    expect(isTextMimeType("application/xml")).toBe(true);
  });

  test("image/png is not text", () => {
    expect(isTextMimeType("image/png")).toBe(false);
  });

  test("video/mp4 is not text", () => {
    expect(isTextMimeType("video/mp4")).toBe(false);
  });

  test("application/octet-stream is not text", () => {
    expect(isTextMimeType("application/octet-stream")).toBe(false);
  });
});

// ===========================================================================
// GET /v1/workspace/tree
// ===========================================================================

describe("GET /v1/workspace/tree", () => {
  const handler = getHandler("workspace/tree");

  test("root listing returns entries", async () => {
    const ctx = makeCtx({});
    const res = await handler(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      path: string;
      entries: Array<{ name: string; type: string }>;
    };
    expect(body.entries.length).toBeGreaterThan(0);
    const names = body.entries.map((e) => e.name);
    expect(names).toContain("hello.txt");
    expect(names).toContain("subdir");
  });

  test("subdirectory listing returns child entries", async () => {
    const ctx = makeCtx({ path: "subdir" });
    const res = await handler(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      path: string;
      entries: Array<{ name: string; type: string }>;
    };
    expect(body.entries.length).toBe(1);
    expect(body.entries[0].name).toBe("nested.txt");
    expect(body.entries[0].type).toBe("file");
  });

  test("non-existent directory returns 404", async () => {
    const ctx = makeCtx({ path: "nope" });
    const res = await handler(ctx);
    expect(res.status).toBe(404);
  });

  test("path traversal attempt returns 400", async () => {
    const ctx = makeCtx({ path: "../../etc" });
    const res = await handler(ctx);
    expect(res.status).toBe(400);
  });

  test("entries have correct type field", async () => {
    const ctx = makeCtx({});
    const res = await handler(ctx);
    const body = (await res.json()) as {
      entries: Array<{ name: string; type: "file" | "directory" }>;
    };
    const subdirEntry = body.entries.find((e) => e.name === "subdir");
    const fileEntry = body.entries.find((e) => e.name === "hello.txt");
    expect(subdirEntry?.type).toBe("directory");
    expect(fileEntry?.type).toBe("file");
  });

  test("dotfiles and dot-directories are excluded", async () => {
    const ctx = makeCtx({});
    const res = await handler(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: Array<{ name: string }>;
    };
    const names = body.entries.map((e) => e.name);
    expect(names).not.toContain(".env");
    expect(names).not.toContain(".hidden");
  });

  test("directory entries have null size and mimeType", async () => {
    const ctx = makeCtx({});
    const res = await handler(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: Array<{
        name: string;
        type: string;
        size: number | null;
        mimeType: string | null;
      }>;
    };
    const dirEntry = body.entries.find((e) => e.type === "directory");
    expect(dirEntry).toBeDefined();
    expect(dirEntry!.size).toBeNull();
    expect(dirEntry!.mimeType).toBeNull();
  });

  test("directories sorted before files", async () => {
    const ctx = makeCtx({});
    const res = await handler(ctx);
    const body = (await res.json()) as {
      entries: Array<{ type: string }>;
    };
    const firstFileIdx = body.entries.findIndex((e) => e.type === "file");
    // Find the last directory index by iterating
    let lastDirIdx = -1;
    for (let i = body.entries.length - 1; i >= 0; i--) {
      if (body.entries[i].type === "directory") {
        lastDirIdx = i;
        break;
      }
    }
    // All directories should come before any files
    if (lastDirIdx !== -1 && firstFileIdx !== -1) {
      expect(lastDirIdx).toBeLessThan(firstFileIdx);
    }
  });
});

// ===========================================================================
// GET /v1/workspace/file
// ===========================================================================

describe("GET /v1/workspace/file", () => {
  const handler = getHandler("workspace/file");

  test("text file returns content inline", async () => {
    const ctx = makeCtx({ path: "hello.txt" });
    const res = await handler(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      path: string;
      name: string;
      content: string | null;
      isBinary: boolean;
      size: number;
    };
    expect(body.path).toBe("hello.txt");
    expect(body.name).toBe("hello.txt");
    expect(body.content).toBe("Hello, world!");
    expect(body.isBinary).toBe(false);
    expect(body.size).toBe(13);
  });

  test("missing path param returns 400", async () => {
    const ctx = makeCtx({});
    const res = await handler(ctx);
    expect(res.status).toBe(400);
  });

  test("non-existent file returns 404", async () => {
    const ctx = makeCtx({ path: "nonexistent.txt" });
    const res = await handler(ctx);
    expect(res.status).toBe(404);
  });

  test("binary file returns isBinary true and content null", async () => {
    const ctx = makeCtx({ path: "image.png" });
    const res = await handler(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      isBinary: boolean;
      content: string | null;
    };
    expect(body.isBinary).toBe(true);
    expect(body.content).toBeNull();
  });

  test("path traversal attempt returns 400", async () => {
    const ctx = makeCtx({ path: "../../etc/passwd" });
    const res = await handler(ctx);
    expect(res.status).toBe(400);
  });

  test("json file returns content inline", async () => {
    const ctx = makeCtx({ path: "data.json" });
    const res = await handler(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      content: string | null;
      isBinary: boolean;
      mimeType: string;
    };
    expect(body.content).toBe('{"key":"value"}');
    expect(body.isBinary).toBe(false);
  });

  test("directory path returns 404", async () => {
    const ctx = makeCtx({ path: "subdir" });
    const res = await handler(ctx);
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// GET /v1/workspace/file/content
// ===========================================================================

describe("GET /v1/workspace/file/content", () => {
  const handler = getHandler("workspace/file/content");

  test("returns raw bytes with correct Content-Type", async () => {
    const ctx = makeCtx({ path: "hello.txt" });
    const res = await handler(ctx);
    expect(res.status).toBe(200);
    const contentType = res.headers.get("Content-Type");
    expect(contentType).toContain("text/plain");
    const text = await res.text();
    expect(text).toBe("Hello, world!");
  });

  test("range header produces 206 response", async () => {
    const ctx = makeCtx({ path: "hello.txt" }, { Range: "bytes=0-4" });
    const res = await handler(ctx);
    expect(res.status).toBe(206);
    const contentRange = res.headers.get("Content-Range");
    expect(contentRange).toBe("bytes 0-4/13");
    const text = await res.text();
    expect(text).toBe("Hello");
  });

  test("non-existent file returns 404", async () => {
    const ctx = makeCtx({ path: "missing.txt" });
    const res = await handler(ctx);
    expect(res.status).toBe(404);
  });

  test("missing path param returns 400", async () => {
    const ctx = makeCtx({});
    const res = await handler(ctx);
    expect(res.status).toBe(400);
  });

  test("path traversal attempt returns 400", async () => {
    const ctx = makeCtx({ path: "../../../etc/passwd" });
    const res = await handler(ctx);
    expect(res.status).toBe(400);
  });

  test("suffix range (bytes=-N) works", async () => {
    // "Hello, world!" -> indices 0-12, length 13
    // bytes=-5: start = max(0, 13-5) = 8, end = 12
    // chars at 8..12: "o", "r", "l", "d", "!"
    const ctx = makeCtx({ path: "hello.txt" }, { Range: "bytes=-5" });
    const res = await handler(ctx);
    expect(res.status).toBe(206);
    const text = await res.text();
    expect(text).toBe("orld!");
  });

  test("directory path returns 400", async () => {
    const ctx = makeCtx({ path: "subdir" });
    const res = await handler(ctx);
    expect(res.status).toBe(400);
  });

  test("Accept-Ranges header is present", async () => {
    const ctx = makeCtx({ path: "hello.txt" });
    const res = await handler(ctx);
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
  });
});

// ===========================================================================
// POST /v1/workspace/write
// ===========================================================================

describe("POST /v1/workspace/write", () => {
  const handler = getHandler("workspace/write");

  test("creates a new text file with UTF-8 content", async () => {
    const ctx = makePostCtx({ path: "new-file.txt", content: "hello world" });
    const res = await handler(ctx);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { path: string; size: number };
    expect(body.path).toBe("new-file.txt");
    expect(body.size).toBe(11);
    const written = readFileSync(join(testWorkspaceDir, "new-file.txt"), "utf-8");
    expect(written).toBe("hello world");
  });

  test("overwrites an existing file", async () => {
    writeFileSync(join(testWorkspaceDir, "overwrite-me.txt"), "old content");
    const ctx = makePostCtx({
      path: "overwrite-me.txt",
      content: "new content",
    });
    const res = await handler(ctx);
    expect(res.status).toBe(201);
    const written = readFileSync(
      join(testWorkspaceDir, "overwrite-me.txt"),
      "utf-8",
    );
    expect(written).toBe("new content");
  });

  test("auto-creates parent directories for nested paths", async () => {
    const ctx = makePostCtx({
      path: "new-dir/sub/file.txt",
      content: "deep content",
    });
    const res = await handler(ctx);
    expect(res.status).toBe(201);
    const fullPath = join(testWorkspaceDir, "new-dir", "sub", "file.txt");
    expect(existsSync(fullPath)).toBe(true);
    const written = readFileSync(fullPath, "utf-8");
    expect(written).toBe("deep content");
  });

  test("handles base64 encoding", async () => {
    const original = "binary\x00data";
    const encoded = Buffer.from(original).toString("base64");
    const ctx = makePostCtx({
      path: "img.bin",
      content: encoded,
      encoding: "base64",
    });
    const res = await handler(ctx);
    expect(res.status).toBe(201);
    const written = readFileSync(join(testWorkspaceDir, "img.bin"));
    expect(written.toString("binary")).toBe(original);
  });

  test("rejects path traversal", async () => {
    const ctx = makePostCtx({
      path: "../../etc/passwd",
      content: "malicious",
    });
    const res = await handler(ctx);
    expect(res.status).toBe(400);
  });

  test("rejects missing path", async () => {
    const ctx = makePostCtx({ content: "no path" });
    const res = await handler(ctx);
    expect(res.status).toBe(400);
  });

  test("rejects dotfile segments", async () => {
    const ctx = makePostCtx({
      path: ".hidden/file.txt",
      content: "sneaky",
    });
    const res = await handler(ctx);
    expect(res.status).toBe(400);
  });

  test("returns 201 with path and size in response", async () => {
    const ctx = makePostCtx({ path: "response-check.txt", content: "abc" });
    const res = await handler(ctx);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { path: string; size: number };
    expect(body.path).toBe("response-check.txt");
    expect(body.size).toBe(3);
  });
});
