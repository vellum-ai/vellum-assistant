/**
 * Tests for credential inclusion in vbundle export.
 *
 * Covers:
 * - buildExportVBundle() with credentials includes credentials/* entries
 * - Credentials appear in the manifest with correct SHA-256 checksums
 * - Export with no credentials produces the same archive as before (backward compat)
 * - Streaming path (streamExportVBundle) includes credential entries
 */

import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, test } from "bun:test";

import { buildExportVBundle, streamExportVBundle } from "../vbundle-builder.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BLOCK_SIZE = 512;

function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Parse a tar archive into its entries (name -> data). */
function parseTar(tar: Uint8Array): Map<string, Uint8Array> {
  const entries = new Map<string, Uint8Array>();
  let offset = 0;
  let paxPath: string | undefined;

  while (offset + BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK_SIZE);

    // Check for end-of-archive (all zeros)
    if (header.every((b) => b === 0)) break;

    // Read file name
    let name = "";
    for (let i = 0; i < 100 && header[i] !== 0; i++) {
      name += String.fromCharCode(header[i]);
    }

    // Read size (octal at offset 124, 12 bytes)
    let sizeStr = "";
    for (let i = 124; i < 136 && header[i] !== 0; i++) {
      sizeStr += String.fromCharCode(header[i]);
    }
    const size = parseInt(sizeStr.trim(), 8) || 0;

    // Type flag
    const typeFlag = String.fromCharCode(header[156]);

    offset += BLOCK_SIZE;

    const data = tar.subarray(offset, offset + size);
    const paddedSize = Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
    offset += paddedSize;

    if (typeFlag === "x") {
      // PAX extended header — extract path
      const paxStr = new TextDecoder().decode(data);
      const match = paxStr.match(/\d+ path=(.+)\n/);
      if (match) {
        paxPath = match[1];
      }
      continue;
    }

    const entryName = paxPath ?? name;
    paxPath = undefined;
    entries.set(entryName, new Uint8Array(data));
  }

  return entries;
}

/** Create a minimal workspace directory with a config file for testing. */
function createTestWorkspace(): { dir: string; cleanup: () => void } {
  const dir = join(
    tmpdir(),
    `vbundle-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ test: true }));
  // Create a minimal data/db directory with a fake database file
  const dbDir = join(dir, "data", "db");
  mkdirSync(dbDir, { recursive: true });
  writeFileSync(join(dbDir, "assistant.db"), "fake-db-content");
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildExportVBundle with credentials", () => {
  test("includes credential entries under credentials/ prefix", () => {
    const workspace = createTestWorkspace();
    try {
      const credentials = [
        { account: "openai-key", value: "sk-test-123" },
        { account: "anthropic-key", value: "sk-ant-456" },
      ];

      const result = buildExportVBundle({
        workspaceDir: workspace.dir,
        credentials,
      });

      const tar = gunzipSync(result.archive);
      const entries = parseTar(tar);

      expect(entries.has("credentials/openai-key")).toBe(true);
      expect(entries.has("credentials/anthropic-key")).toBe(true);

      const decoder = new TextDecoder();
      expect(decoder.decode(entries.get("credentials/openai-key")!)).toBe(
        "sk-test-123",
      );
      expect(decoder.decode(entries.get("credentials/anthropic-key")!)).toBe(
        "sk-ant-456",
      );
    } finally {
      workspace.cleanup();
    }
  });

  test("credentials appear in manifest with correct SHA-256 checksums", () => {
    const workspace = createTestWorkspace();
    try {
      const credentials = [
        { account: "my-api-key", value: "secret-value-abc" },
      ];

      const result = buildExportVBundle({
        workspaceDir: workspace.dir,
        credentials,
      });

      const expectedHash = sha256Hex(
        new TextEncoder().encode("secret-value-abc"),
      );

      const credEntry = result.manifest.files.find(
        (f) => f.path === "credentials/my-api-key",
      );
      expect(credEntry).toBeDefined();
      expect(credEntry!.sha256).toBe(expectedHash);
      expect(credEntry!.size).toBe(
        new TextEncoder().encode("secret-value-abc").length,
      );
    } finally {
      workspace.cleanup();
    }
  });

  test("export with no credentials produces archive without credentials/ entries", () => {
    const workspace = createTestWorkspace();
    try {
      const result = buildExportVBundle({
        workspaceDir: workspace.dir,
      });

      const tar = gunzipSync(result.archive);
      const entries = parseTar(tar);

      const credentialEntries = [...entries.keys()].filter((k) =>
        k.startsWith("credentials/"),
      );
      expect(credentialEntries).toHaveLength(0);

      // Manifest should have no credential entries
      const credManifestEntries = result.manifest.files.filter((f) =>
        f.path.startsWith("credentials/"),
      );
      expect(credManifestEntries).toHaveLength(0);
    } finally {
      workspace.cleanup();
    }
  });

  test("export with empty credentials array produces archive without credentials/ entries", () => {
    const workspace = createTestWorkspace();
    try {
      const result = buildExportVBundle({
        workspaceDir: workspace.dir,
        credentials: [],
      });

      const tar = gunzipSync(result.archive);
      const entries = parseTar(tar);

      const credentialEntries = [...entries.keys()].filter((k) =>
        k.startsWith("credentials/"),
      );
      expect(credentialEntries).toHaveLength(0);
    } finally {
      workspace.cleanup();
    }
  });
});

describe("streamExportVBundle with credentials", () => {
  test("includes credential entries in the streaming archive", async () => {
    const workspace = createTestWorkspace();
    let result: Awaited<ReturnType<typeof streamExportVBundle>> | undefined;
    try {
      const credentials = [
        { account: "stream-key", value: "stream-secret-789" },
      ];

      result = await streamExportVBundle({
        workspaceDir: workspace.dir,
        credentials,
      });

      // Read the temp file and decompress
      const archiveData = new Uint8Array(
        await Bun.file(result.tempPath).arrayBuffer(),
      );
      const tar = gunzipSync(archiveData);
      const entries = parseTar(tar);

      expect(entries.has("credentials/stream-key")).toBe(true);

      const decoder = new TextDecoder();
      expect(decoder.decode(entries.get("credentials/stream-key")!)).toBe(
        "stream-secret-789",
      );

      // Verify manifest entry
      const credEntry = result.manifest.files.find(
        (f) => f.path === "credentials/stream-key",
      );
      expect(credEntry).toBeDefined();
      expect(credEntry!.sha256).toBe(
        sha256Hex(new TextEncoder().encode("stream-secret-789")),
      );
    } finally {
      await result?.cleanup();
      workspace.cleanup();
    }
  });

  test("streaming export without credentials has no credentials/ entries", async () => {
    const workspace = createTestWorkspace();
    let result: Awaited<ReturnType<typeof streamExportVBundle>> | undefined;
    try {
      result = await streamExportVBundle({
        workspaceDir: workspace.dir,
      });

      const archiveData = new Uint8Array(
        await Bun.file(result.tempPath).arrayBuffer(),
      );
      const tar = gunzipSync(archiveData);
      const entries = parseTar(tar);

      const credentialEntries = [...entries.keys()].filter((k) =>
        k.startsWith("credentials/"),
      );
      expect(credentialEntries).toHaveLength(0);
    } finally {
      await result?.cleanup();
      workspace.cleanup();
    }
  });
});
