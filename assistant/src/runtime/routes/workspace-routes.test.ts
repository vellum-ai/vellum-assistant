/**
 * Tests for workspace route handlers and utility functions.
 *
 * Covers path resolution (traversal prevention), MIME type detection,
 * directory listing, file metadata, write/mkdir/rename/delete, and raw
 * content serving with range support (HTTP-only).
 */
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "bun:test";

import { SYNC_TAGS } from "../../daemon/message-types/sync.js";
import type { AssistantEvent } from "../assistant-event.js";
import { assistantEventHub } from "../assistant-event-hub.js";

// ---------------------------------------------------------------------------
// Create a temp workspace directory for isolation
// ---------------------------------------------------------------------------

const testWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR!;

import { BadRequestError, ConflictError, NotFoundError } from "./errors.js";
import type { RouteDefinition } from "./types.js";
import { RouteResponse } from "./types.js";
import { ROUTES } from "./workspace-routes.js";
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getRoute(operationId: string): RouteDefinition {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route)
    throw new Error(`No shared route found for operationId: ${operationId}`);
  return route;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for workspace route event");
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

  test("application/octet-stream is not text without filename", () => {
    expect(isTextMimeType("application/octet-stream")).toBe(false);
  });

  test("application/octet-stream with .py filename is text", () => {
    expect(isTextMimeType("application/octet-stream", "script.py")).toBe(true);
  });

  test("application/octet-stream with .go filename is text", () => {
    expect(isTextMimeType("application/octet-stream", "main.go")).toBe(true);
  });

  test("application/octet-stream with .rs filename is text", () => {
    expect(isTextMimeType("application/octet-stream", "lib.rs")).toBe(true);
  });

  test("application/octet-stream with unknown extension is not text", () => {
    expect(isTextMimeType("application/octet-stream", "data.bin")).toBe(false);
  });

  test("extension fallback only applies to application/octet-stream", () => {
    expect(isTextMimeType("application/x-plist", "Info.plist")).toBe(false);
  });

  test("application/octet-stream with .jsonl filename is text", () => {
    expect(isTextMimeType("application/octet-stream", "messages.jsonl")).toBe(
      true,
    );
  });

  test("application/octet-stream with .ndjson filename is text", () => {
    expect(isTextMimeType("application/octet-stream", "events.ndjson")).toBe(
      true,
    );
  });

  test("application/octet-stream with .JSONL uppercase is text", () => {
    expect(isTextMimeType("application/octet-stream", "DATA.JSONL")).toBe(true);
  });

  test("application/octet-stream with .NDJSON uppercase is text", () => {
    expect(isTextMimeType("application/octet-stream", "DATA.NDJSON")).toBe(
      true,
    );
  });
});

// ===========================================================================
// GET /v1/workspace/tree
// ===========================================================================

describe("GET /v1/workspace/tree", () => {
  const { handler } = getRoute("workspace_tree");

  test("root listing returns entries", () => {
    const result = handler({ queryParams: {} }) as {
      path: string;
      entries: Array<{ name: string; type: string }>;
    };
    expect(result.entries.length).toBeGreaterThan(0);
    const names = result.entries.map((e) => e.name);
    expect(names).toContain("hello.txt");
    expect(names).toContain("subdir");
  });

  test("subdirectory listing returns child entries", () => {
    const result = handler({ queryParams: { path: "subdir" } }) as {
      path: string;
      entries: Array<{ name: string; type: string }>;
    };
    expect(result.entries.length).toBe(1);
    expect(result.entries[0].name).toBe("nested.txt");
    expect(result.entries[0].type).toBe("file");
  });

  test("non-existent directory throws NotFoundError", () => {
    expect(() => handler({ queryParams: { path: "nope" } })).toThrow(
      NotFoundError,
    );
  });

  test("path traversal attempt throws BadRequestError", () => {
    expect(() => handler({ queryParams: { path: "../../etc" } })).toThrow(
      BadRequestError,
    );
  });

  test("entries have correct type field", () => {
    const result = handler({ queryParams: {} }) as {
      entries: Array<{ name: string; type: "file" | "directory" }>;
    };
    const subdirEntry = result.entries.find((e) => e.name === "subdir");
    const fileEntry = result.entries.find((e) => e.name === "hello.txt");
    expect(subdirEntry?.type).toBe("directory");
    expect(fileEntry?.type).toBe("file");
  });

  test("dotfiles and dot-directories are excluded", () => {
    const result = handler({ queryParams: {} }) as {
      entries: Array<{ name: string }>;
    };
    const names = result.entries.map((e) => e.name);
    expect(names).not.toContain(".env");
    expect(names).not.toContain(".hidden");
  });

  test("directory entries have null size and mimeType", () => {
    const result = handler({ queryParams: {} }) as {
      entries: Array<{
        name: string;
        type: string;
        size: number | null;
        mimeType: string | null;
      }>;
    };
    const dirEntry = result.entries.find((e) => e.type === "directory");
    expect(dirEntry).toBeDefined();
    expect(dirEntry!.size).toBeNull();
    expect(dirEntry!.mimeType).toBeNull();
  });

  test("directories sorted before files", () => {
    const result = handler({ queryParams: {} }) as {
      entries: Array<{ type: string }>;
    };
    const firstFileIdx = result.entries.findIndex((e) => e.type === "file");
    let lastDirIdx = -1;
    for (let i = result.entries.length - 1; i >= 0; i--) {
      if (result.entries[i].type === "directory") {
        lastDirIdx = i;
        break;
      }
    }
    if (lastDirIdx !== -1 && firstFileIdx !== -1) {
      expect(lastDirIdx).toBeLessThan(firstFileIdx);
    }
  });

  test("includeDirSizes=true returns recursive byte size for directories", () => {
    const result = handler({ queryParams: { includeDirSizes: "true" } }) as {
      entries: Array<{ name: string; type: string; size: number | null }>;
    };
    const subdirEntry = result.entries.find((e) => e.name === "subdir");
    expect(subdirEntry).toBeDefined();
    expect(subdirEntry!.type).toBe("directory");
    // subdir/nested.txt contains "nested content" (14 bytes) — the only file
    // under subdir/, so the recursive size equals exactly that file's size.
    expect(subdirEntry!.size).toBe("nested content".length);
  });

  test("includeDirSizes=true preserves accurate file sizes", () => {
    const result = handler({ queryParams: { includeDirSizes: "true" } }) as {
      entries: Array<{ name: string; type: string; size: number | null }>;
    };
    const fileEntry = result.entries.find((e) => e.name === "hello.txt");
    expect(fileEntry).toBeDefined();
    expect(fileEntry!.size).toBe("Hello, world!".length);
  });

  test("includeDirSizes omitted preserves null size for directories", () => {
    const result = handler({ queryParams: {} }) as {
      entries: Array<{ type: string; size: number | null }>;
    };
    const dirEntry = result.entries.find((e) => e.type === "directory");
    expect(dirEntry).toBeDefined();
    expect(dirEntry!.size).toBeNull();
  });

  test("includeDirSizes=true returns 0 for empty directory", () => {
    const emptyDir = join(testWorkspaceDir, "empty-for-size");
    mkdirSync(emptyDir, { recursive: true });

    const result = handler({ queryParams: { includeDirSizes: "true" } }) as {
      entries: Array<{ name: string; size: number | null }>;
    };
    const emptyEntry = result.entries.find((e) => e.name === "empty-for-size");
    expect(emptyEntry).toBeDefined();
    expect(emptyEntry!.size).toBe(0);
  });
});

// ===========================================================================
// GET /v1/workspace/file
// ===========================================================================

describe("GET /v1/workspace/file", () => {
  const { handler } = getRoute("workspace_file");

  test("text file returns content inline", () => {
    const result = handler({ queryParams: { path: "hello.txt" } }) as {
      path: string;
      name: string;
      content: string | null;
      isBinary: boolean;
      size: number;
    };
    expect(result.path).toBe("hello.txt");
    expect(result.name).toBe("hello.txt");
    expect(result.content).toBe("Hello, world!");
    expect(result.isBinary).toBe(false);
    expect(result.size).toBe(13);
  });

  test("missing path param throws BadRequestError", () => {
    expect(() => handler({ queryParams: {} })).toThrow(BadRequestError);
  });

  test("non-existent file throws NotFoundError", () => {
    expect(() => handler({ queryParams: { path: "nonexistent.txt" } })).toThrow(
      NotFoundError,
    );
  });

  test("binary file returns isBinary true and content null", () => {
    const result = handler({ queryParams: { path: "image.png" } }) as {
      isBinary: boolean;
      content: string | null;
    };
    expect(result.isBinary).toBe(true);
    expect(result.content).toBeNull();
  });

  test("path traversal attempt throws BadRequestError", () => {
    expect(() =>
      handler({ queryParams: { path: "../../etc/passwd" } }),
    ).toThrow(BadRequestError);
  });

  test("json file returns content inline", () => {
    const result = handler({ queryParams: { path: "data.json" } }) as {
      content: string | null;
      isBinary: boolean;
      mimeType: string;
    };
    expect(result.content).toBe('{"key":"value"}');
    expect(result.isBinary).toBe(false);
  });

  test("directory path throws NotFoundError", () => {
    expect(() => handler({ queryParams: { path: "subdir" } })).toThrow(
      NotFoundError,
    );
  });
});

// ===========================================================================
// GET /v1/workspace/file/content (range support)
// ===========================================================================

describe("GET /v1/workspace/file/content", () => {
  const { handler } = getRoute("workspace_file_content");

  test("returns raw bytes with correct Content-Type", async () => {
    const result = handler({
      queryParams: { path: "hello.txt" },
    }) as RouteResponse;
    expect(result).toBeInstanceOf(RouteResponse);
    expect(result.headers["Content-Type"]).toContain("text/plain");
    const text = await new Response(result.body).text();
    expect(text).toBe("Hello, world!");
  });

  test("range header produces partial content response", async () => {
    const result = handler({
      queryParams: { path: "hello.txt" },
      headers: { range: "bytes=0-4" },
    }) as RouteResponse;
    expect(result).toBeInstanceOf(RouteResponse);
    expect(result.headers["Content-Range"]).toBe("bytes 0-4/13");
    const text = await new Response(result.body).text();
    expect(text).toBe("Hello");
  });

  test("non-existent file throws NotFoundError", () => {
    expect(() => handler({ queryParams: { path: "missing.txt" } })).toThrow(
      NotFoundError,
    );
  });

  test("missing path param throws BadRequestError", () => {
    expect(() => handler({ queryParams: {} })).toThrow(BadRequestError);
  });

  test("path traversal attempt throws BadRequestError", () => {
    expect(() =>
      handler({ queryParams: { path: "../../../etc/passwd" } }),
    ).toThrow(BadRequestError);
  });

  test("suffix range (bytes=-N) works", async () => {
    const result = handler({
      queryParams: { path: "hello.txt" },
      headers: { range: "bytes=-5" },
    }) as RouteResponse;
    expect(result).toBeInstanceOf(RouteResponse);
    const text = await new Response(result.body).text();
    expect(text).toBe("orld!");
  });

  test("directory path throws BadRequestError", () => {
    expect(() => handler({ queryParams: { path: "subdir" } })).toThrow(
      BadRequestError,
    );
  });

  test("Accept-Ranges header is present", () => {
    const result = handler({
      queryParams: { path: "hello.txt" },
    }) as RouteResponse;
    expect(result.headers["Accept-Ranges"]).toBe("bytes");
  });
});

// ===========================================================================
// POST /v1/workspace/write
// ===========================================================================

describe("POST /v1/workspace/write", () => {
  const { handler } = getRoute("workspace_write");

  test("creates a new text file with UTF-8 content", () => {
    const result = handler({
      body: { path: "new-file.txt", content: "hello world" },
    }) as { path: string; size: number };
    expect(result.path).toBe("new-file.txt");
    expect(result.size).toBe(11);
    const written = readFileSync(
      join(testWorkspaceDir, "new-file.txt"),
      "utf-8",
    );
    expect(written).toBe("hello world");
  });

  test("overwrites an existing file", () => {
    writeFileSync(join(testWorkspaceDir, "overwrite-me.txt"), "old content");
    const result = handler({
      body: { path: "overwrite-me.txt", content: "new content" },
    }) as { path: string; size: number };
    expect(result.path).toBe("overwrite-me.txt");
    const written = readFileSync(
      join(testWorkspaceDir, "overwrite-me.txt"),
      "utf-8",
    );
    expect(written).toBe("new content");
  });

  test("auto-creates parent directories for nested paths", () => {
    handler({
      body: { path: "write-dir/sub/file.txt", content: "deep content" },
    });
    const fullPath = join(testWorkspaceDir, "write-dir", "sub", "file.txt");
    expect(existsSync(fullPath)).toBe(true);
    const written = readFileSync(fullPath, "utf-8");
    expect(written).toBe("deep content");
  });

  test("handles base64 encoding", () => {
    const original = "binary\x00data";
    const encoded = Buffer.from(original).toString("base64");
    handler({
      body: { path: "img.bin", content: encoded, encoding: "base64" },
    });
    const written = readFileSync(join(testWorkspaceDir, "img.bin"));
    expect(written.toString("binary")).toBe(original);
  });

  test("rejects path traversal", () => {
    expect(() =>
      handler({
        body: { path: "../../etc/passwd", content: "malicious" },
      }),
    ).toThrow(BadRequestError);
  });

  test("rejects missing path", () => {
    expect(() => handler({ body: { content: "no path" } })).toThrow(
      BadRequestError,
    );
  });

  test("rejects dotfile segments", () => {
    expect(() =>
      handler({
        body: { path: ".hidden/file.txt", content: "sneaky" },
      }),
    ).toThrow(BadRequestError);
  });

  test("returns path and size in response", () => {
    const result = handler({
      body: { path: "response-check.txt", content: "abc" },
    }) as { path: string; size: number };
    expect(result.path).toBe("response-check.txt");
    expect(result.size).toBe(3);
  });

  test("throws ConflictError when writing to an existing directory path", () => {
    expect(() =>
      handler({ body: { path: "subdir", content: "should fail" } }),
    ).toThrow(ConflictError);
  });

  test("publishes sounds sync events when writing sounds config", async () => {
    const received: AssistantEvent[] = [];
    const subscription = assistantEventHub.subscribe({
      type: "process",
      callback: (event) => {
        received.push(event);
      },
    });

    try {
      handler({
        body: {
          path: "data/sounds/config.json",
          content: "{}",
        },
      });
      await waitFor(() => received.length === 2);
      expect(received.map((event) => event.message.type)).toEqual([
        "sounds_config_updated",
        "sync_changed",
      ]);
      expect(received[1]!.message).toEqual({
        type: "sync_changed",
        tags: [SYNC_TAGS.assistantSounds],
      });
    } finally {
      subscription.dispose();
    }
  });
});

// ===========================================================================
// POST /v1/workspace/mkdir
// ===========================================================================

describe("POST /v1/workspace/mkdir", () => {
  const { handler } = getRoute("workspace_mkdir");

  test("creates directory", () => {
    const result = handler({ body: { path: "new-dir" } }) as {
      path: string;
    };
    expect(result.path).toBe("new-dir");
    expect(existsSync(join(testWorkspaceDir, "new-dir"))).toBe(true);
  });

  test("nested directory creation works", () => {
    const result = handler({ body: { path: "deep/nested/dir" } }) as {
      path: string;
    };
    expect(result.path).toBe("deep/nested/dir");
    expect(existsSync(join(testWorkspaceDir, "deep/nested/dir"))).toBe(true);
  });

  test("idempotent on existing directory", () => {
    const result = handler({ body: { path: "subdir" } }) as {
      path: string;
    };
    expect(result.path).toBe("subdir");
  });

  test("throws ConflictError if path exists as a file", () => {
    expect(() => handler({ body: { path: "hello.txt" } })).toThrow(
      ConflictError,
    );
  });

  test("rejects path traversal", () => {
    expect(() => handler({ body: { path: "../../etc/evil" } })).toThrow(
      BadRequestError,
    );
  });

  test("rejects missing path", () => {
    expect(() => handler({ body: {} })).toThrow(BadRequestError);
  });
});

// ===========================================================================
// POST /v1/workspace/rename
// ===========================================================================

describe("POST /v1/workspace/rename", () => {
  const { handler } = getRoute("workspace_rename");

  test("renames file", () => {
    const srcPath = join(testWorkspaceDir, "rename-me.txt");
    writeFileSync(srcPath, "rename test");

    const result = handler({
      body: { oldPath: "rename-me.txt", newPath: "renamed.txt" },
    }) as { oldPath: string; newPath: string };
    expect(result.oldPath).toBe("rename-me.txt");
    expect(result.newPath).toBe("renamed.txt");
    expect(existsSync(srcPath)).toBe(false);
    expect(existsSync(join(testWorkspaceDir, "renamed.txt"))).toBe(true);
  });

  test("renames directory", () => {
    const srcDir = join(testWorkspaceDir, "dir-to-rename");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "child.txt"), "child");

    handler({
      body: { oldPath: "dir-to-rename", newPath: "dir-renamed" },
    });
    expect(existsSync(srcDir)).toBe(false);
    expect(existsSync(join(testWorkspaceDir, "dir-renamed", "child.txt"))).toBe(
      true,
    );
  });

  test("throws NotFoundError for missing source", () => {
    expect(() =>
      handler({
        body: { oldPath: "nonexistent.txt", newPath: "dest.txt" },
      }),
    ).toThrow(NotFoundError);
  });

  test("throws ConflictError for existing destination", () => {
    expect(() =>
      handler({
        body: { oldPath: "hello.txt", newPath: "data.json" },
      }),
    ).toThrow(ConflictError);
  });

  // Hard links share an inode while being distinct entries, and POSIX
  // rename() between two hard links is a silent no-op — must 409 instead
  // of reporting a successful rename that never happened.
  test("throws ConflictError when renaming a hard link over its sibling link", () => {
    writeFileSync(join(testWorkspaceDir, "hard-a.txt"), "hard");
    linkSync(
      join(testWorkspaceDir, "hard-a.txt"),
      join(testWorkspaceDir, "hard-b.txt"),
    );

    expect(() =>
      handler({
        body: { oldPath: "hard-a.txt", newPath: "hard-b.txt" },
      }),
    ).toThrow(ConflictError);
  });

  // statSync would follow both links to the shared target and treat them as
  // the same entry, letting the rename clobber a real, separate symlink.
  test("throws ConflictError when renaming a symlink over a sibling symlink to the same target", () => {
    writeFileSync(join(testWorkspaceDir, "link-target.txt"), "target");
    symlinkSync(
      join(testWorkspaceDir, "link-target.txt"),
      join(testWorkspaceDir, "link-a.txt"),
    );
    symlinkSync(
      join(testWorkspaceDir, "link-target.txt"),
      join(testWorkspaceDir, "link-b.txt"),
    );

    expect(() =>
      handler({
        body: { oldPath: "link-a.txt", newPath: "link-b.txt" },
      }),
    ).toThrow(ConflictError);
  });

  // On case-insensitive filesystems (macOS default) the destination "exists"
  // because it resolves to the source itself — must rename, not conflict.
  test("allows case-only rename of the same file", () => {
    const srcPath = join(testWorkspaceDir, "CaseFile.txt");
    writeFileSync(srcPath, "case test");

    const result = handler({
      body: { oldPath: "CaseFile.txt", newPath: "casefile.txt" },
    }) as { oldPath: string; newPath: string };
    expect(result.newPath).toBe("casefile.txt");
    const names = readdirSync(testWorkspaceDir);
    expect(names).toContain("casefile.txt");
    expect(names).not.toContain("CaseFile.txt");
  });

  test("rejects path traversal on oldPath", () => {
    expect(() =>
      handler({
        body: { oldPath: "../../etc/passwd", newPath: "dest.txt" },
      }),
    ).toThrow(BadRequestError);
  });

  test("rejects path traversal on newPath", () => {
    expect(() =>
      handler({
        body: { oldPath: "hello.txt", newPath: "../../etc/evil" },
      }),
    ).toThrow(BadRequestError);
  });

  test("rejects missing fields", () => {
    expect(() => handler({ body: { oldPath: "hello.txt" } })).toThrow(
      BadRequestError,
    );

    expect(() => handler({ body: { newPath: "dest.txt" } })).toThrow(
      BadRequestError,
    );
  });
});

// ===========================================================================
// POST /v1/workspace/delete
// ===========================================================================

describe("POST /v1/workspace/delete", () => {
  const { handler } = getRoute("workspace_delete");

  test("deletes file", () => {
    const filePath = join(testWorkspaceDir, "delete-me.txt");
    writeFileSync(filePath, "delete me");

    const result = handler({ body: { path: "delete-me.txt" } }) as {
      success: boolean;
    };
    expect(result.success).toBe(true);
    expect(existsSync(filePath)).toBe(false);
  });

  test("deletes directory recursively", () => {
    const dirPath = join(testWorkspaceDir, "delete-dir");
    mkdirSync(dirPath, { recursive: true });
    writeFileSync(join(dirPath, "child.txt"), "child");

    const result = handler({ body: { path: "delete-dir" } }) as {
      success: boolean;
    };
    expect(result.success).toBe(true);
    expect(existsSync(dirPath)).toBe(false);
  });

  test("rejects empty path with BadRequestError", () => {
    expect(() => handler({ body: { path: "" } })).toThrow(BadRequestError);
  });

  test("rejects path traversal", () => {
    expect(() => handler({ body: { path: "../../etc/passwd" } })).toThrow(
      BadRequestError,
    );
  });

  test("throws NotFoundError for missing path", () => {
    expect(() => handler({ body: { path: "nonexistent.txt" } })).toThrow(
      NotFoundError,
    );
  });

  test("rejects missing path field", () => {
    expect(() => handler({ body: {} })).toThrow(BadRequestError);
  });
});
