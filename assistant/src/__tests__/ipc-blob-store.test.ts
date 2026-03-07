import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "ipc-blob-store-test-"));
const blobDir = join(testDir, "ipc-blobs");

// Mock platform module so blob store writes to temp dir
mock.module("../util/platform.js", () => ({
  getRootDir: () => testDir,
  getDataDir: () => testDir,
  getIpcBlobDir: () => blobDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getSocketPath: () => join(testDir, "test.sock"),
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

// Mock logger to suppress output during tests
mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
  }),
}));

import {
  deleteBlob,
  ensureBlobDir,
  isValidBlobId,
  readBlob,
  resolveBlobPath,
  sweepStaleBlobs,
} from "../daemon/ipc-blob-store.js";
import type { IpcBlobRef } from "../daemon/ipc-protocol.js";

/** Write a blob file to the test blob directory and return its path. */
function writeBlobFile(id: string, content: Buffer): string {
  const filePath = join(blobDir, `${id}.blob`);
  writeFileSync(filePath, content);
  return filePath;
}

describe("ipc-blob-store", () => {
  beforeEach(() => {
    // Reset blob dir before each test
    if (existsSync(blobDir)) {
      rmSync(blobDir, { recursive: true });
    }
    mkdirSync(blobDir, { recursive: true });
  });

  // -- ensureBlobDir --

  describe("ensureBlobDir", () => {
    test("creates blob directory if missing", () => {
      rmSync(blobDir, { recursive: true });
      expect(existsSync(blobDir)).toBe(false);
      ensureBlobDir();
      expect(existsSync(blobDir)).toBe(true);
    });

    test("succeeds if blob directory already exists", () => {
      ensureBlobDir();
      expect(existsSync(blobDir)).toBe(true);
    });
  });

  // -- isValidBlobId --

  describe("isValidBlobId", () => {
    test("accepts valid UUID v4", () => {
      expect(isValidBlobId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
      expect(isValidBlobId(randomUUID())).toBe(true);
    });

    test("accepts uppercase hex", () => {
      expect(isValidBlobId("550E8400-E29B-41D4-A716-446655440000")).toBe(true);
    });

    test("rejects empty string", () => {
      expect(isValidBlobId("")).toBe(false);
    });

    test("rejects too-short string", () => {
      expect(isValidBlobId("550e8400")).toBe(false);
    });

    test("rejects path traversal characters", () => {
      expect(isValidBlobId("../../etc/passwd/aaaaaaaaaaaaaaaa")).toBe(false);
    });

    test("rejects strings with non-hex characters", () => {
      expect(isValidBlobId("zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz")).toBe(false);
    });
  });

  // -- resolveBlobPath --

  describe("resolveBlobPath", () => {
    test("returns correct path for valid ID", () => {
      const id = "550e8400-e29b-41d4-a716-446655440000";
      const result = resolveBlobPath(id);
      expect(result).toBe(join(blobDir, `${id}.blob`));
    });

    test("throws for invalid ID", () => {
      expect(() => resolveBlobPath("not-a-valid-uuid")).toThrow(
        "Invalid blob ID",
      );
    });

    test("throws for path traversal attempt", () => {
      // This should fail at the regex check before even reaching the path check
      expect(() =>
        resolveBlobPath("../../etc/passwd/aaaaaaaaaaaaaaaa"),
      ).toThrow("Invalid blob ID");
    });
  });

  // -- readBlob --

  describe("readBlob", () => {
    test("reads a valid blob successfully", async () => {
      const id = randomUUID();
      const content = Buffer.from("hello world");
      const sha256 = createHash("sha256").update(content).digest("hex");

      writeBlobFile(id, content);

      const ref: IpcBlobRef = {
        id,
        kind: "ax_tree",
        encoding: "utf8",
        byteLength: content.byteLength,
        sha256,
      };

      const result = await readBlob(ref);
      expect(result.toString()).toBe("hello world");
    });

    test("reads blob without sha256 check", async () => {
      const id = randomUUID();
      const content = Buffer.from("some data");

      writeBlobFile(id, content);

      const ref: IpcBlobRef = {
        id,
        kind: "ax_tree",
        encoding: "utf8",
        byteLength: content.byteLength,
      };

      const result = await readBlob(ref);
      expect(result.byteLength).toBe(content.byteLength);
    });

    test("rejects when byteLength does not match", async () => {
      const id = randomUUID();
      const content = Buffer.from("hello");

      writeBlobFile(id, content);

      const ref: IpcBlobRef = {
        id,
        kind: "ax_tree",
        encoding: "utf8",
        byteLength: 999,
      };

      await expect(readBlob(ref)).rejects.toThrow("Blob size mismatch");
    });

    test("rejects when sha256 does not match", async () => {
      const id = randomUUID();
      const content = Buffer.from("hello");

      writeBlobFile(id, content);

      // Compute a definitely-wrong hash by hashing different content
      const wrongHash = createHash("sha256").update("not-hello").digest("hex");

      const ref: IpcBlobRef = {
        id,
        kind: "ax_tree",
        encoding: "utf8",
        byteLength: content.byteLength,
        sha256: wrongHash,
      };

      await expect(readBlob(ref)).rejects.toThrow("Blob SHA-256 mismatch");
    });

    test("rejects oversized ax_tree blob before reading file", async () => {
      const id = randomUUID();
      // Declare a size over 2 MB limit — file doesn't even need to exist
      const ref: IpcBlobRef = {
        id,
        kind: "ax_tree",
        encoding: "utf8",
        byteLength: 2 * 1024 * 1024 + 1,
      };

      await expect(readBlob(ref)).rejects.toThrow(
        "declared size exceeds limit",
      );
    });

    test("rejects oversized screenshot_jpeg blob before reading file", async () => {
      const id = randomUUID();
      // Declare a size over 10 MB limit — file doesn't even need to exist
      const ref: IpcBlobRef = {
        id,
        kind: "screenshot_jpeg",
        encoding: "binary",
        byteLength: 10 * 1024 * 1024 + 1,
      };

      await expect(readBlob(ref)).rejects.toThrow(
        "declared size exceeds limit",
      );
    });

    test("accepts screenshot_jpeg blob at exactly 10 MB", async () => {
      const id = randomUUID();
      const content = Buffer.alloc(10 * 1024 * 1024);

      writeBlobFile(id, content);

      const ref: IpcBlobRef = {
        id,
        kind: "screenshot_jpeg",
        encoding: "binary",
        byteLength: content.byteLength,
      };

      const result = await readBlob(ref);
      expect(result.byteLength).toBe(10 * 1024 * 1024);
    });
  });

  // -- deleteBlob --

  describe("deleteBlob", () => {
    test("removes existing file", () => {
      const id = randomUUID();
      const filePath = writeBlobFile(id, Buffer.from("data"));
      expect(existsSync(filePath)).toBe(true);

      deleteBlob(id);
      expect(existsSync(filePath)).toBe(false);
    });

    test("does not throw for missing file", () => {
      const id = randomUUID();
      expect(() => deleteBlob(id)).not.toThrow();
    });
  });

  // -- sweepStaleBlobs --

  describe("sweepStaleBlobs", () => {
    test("removes old files and keeps recent ones", async () => {
      const oldId = randomUUID();
      const recentId = randomUUID();

      const oldPath = writeBlobFile(oldId, Buffer.from("old"));
      const recentPath = writeBlobFile(recentId, Buffer.from("recent"));

      // Set old file's mtime to 1 hour ago
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      utimesSync(oldPath, oneHourAgo, oneHourAgo);

      // Sweep files older than 30 minutes
      const deleted = await sweepStaleBlobs(30 * 60 * 1000);

      expect(deleted).toBe(1);
      expect(existsSync(oldPath)).toBe(false);
      expect(existsSync(recentPath)).toBe(true);
    });

    test("returns 0 when no files to sweep", async () => {
      const deleted = await sweepStaleBlobs(30 * 60 * 1000);
      expect(deleted).toBe(0);
    });

    test("returns 0 when blob directory does not exist", async () => {
      rmSync(blobDir, { recursive: true });
      const deleted = await sweepStaleBlobs(30 * 60 * 1000);
      expect(deleted).toBe(0);
    });

    test("ignores non-blob files", async () => {
      const nonBlobPath = join(blobDir, "readme.txt");
      writeFileSync(nonBlobPath, "not a blob");
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      utimesSync(nonBlobPath, oneHourAgo, oneHourAgo);

      const deleted = await sweepStaleBlobs(30 * 60 * 1000);
      expect(deleted).toBe(0);
      expect(existsSync(nonBlobPath)).toBe(true);
    });
  });
});
