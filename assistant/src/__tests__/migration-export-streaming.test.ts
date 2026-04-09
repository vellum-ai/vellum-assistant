/**
 * Integration tests for the streaming vbundle export builder.
 *
 * Tests cover:
 * - Format parity: streaming builder produces archives identical to sync builder
 * - SHA-256 integrity: manifest checksums match actual file content
 * - Temp file lifecycle: cleanup removes the temp file
 * - Cleanup idempotency: calling cleanup twice doesn't throw
 * - Round-trip: streamExportVBundle -> validateVBundle succeeds
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { beforeAll, describe, expect, mock, test } from "bun:test";

const testDir = process.env.VELLUM_WORKSPACE_DIR!;
const testDbDir = join(testDir, "data", "db");
const testDbPath = join(testDbDir, "assistant.db");
const testConfigPath = join(testDir, "config.json");

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../permissions/trust-store.js", () => ({
  getAllRules: () => [],
  isStarterBundleAccepted: () => false,
  clearCache: () => {},
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
    secretDetection: { enabled: false },
  }),
}));

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  hasUngatedHttpAuthDisabled: () => false,
  getGatewayInternalBaseUrl: () => "http://127.0.0.1:7830",
  getGatewayPort: () => 7830,
  getRuntimeHttpPort: () => 7821,
  getRuntimeHttpHost: () => "127.0.0.1",
  getRuntimeGatewayOriginSecret: () => undefined,
  getIngressPublicBaseUrl: () => undefined,
  setIngressPublicBaseUrl: () => {},
}));

import {
  buildExportVBundle,
  streamExportVBundle,
} from "../runtime/migrations/vbundle-builder.js";
import { validateVBundle } from "../runtime/migrations/vbundle-validator.js";

// Test fixture data: a minimal SQLite header to simulate a real database file
const SQLITE_HEADER = new Uint8Array([
  0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74,
  0x20, 0x33, 0x00,
]);
const TEST_CONFIG = { provider: "anthropic", model: "test-model" };

// Generate a synthetic large file (~10 MB of repeated data)
const LARGE_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const LARGE_FILE_NAME = "large-test-data.txt";

function generateLargeFileContent(): Buffer {
  const line =
    "This is a line of repeated test data for streaming export verification.\n";
  const lineBuffer = Buffer.from(line);
  const buf = Buffer.alloc(LARGE_FILE_SIZE);
  for (let offset = 0; offset < LARGE_FILE_SIZE; offset += lineBuffer.length) {
    const remaining = LARGE_FILE_SIZE - offset;
    lineBuffer.copy(buf, offset, 0, Math.min(lineBuffer.length, remaining));
  }
  return buf;
}

beforeAll(() => {
  // Write test fixture files so the export reads real data
  mkdirSync(testDbDir, { recursive: true });
  writeFileSync(testDbPath, SQLITE_HEADER);
  writeFileSync(testConfigPath, JSON.stringify(TEST_CONFIG, null, 2));
  writeFileSync(join(testDir, LARGE_FILE_NAME), generateLargeFileContent());
});

// ---------------------------------------------------------------------------
// Tar parsing helper (mirrors vbundle-validator's internal parser)
// ---------------------------------------------------------------------------

interface TarEntry {
  name: string;
  data: Uint8Array;
}

function parseTarEntries(gzippedData: Uint8Array): TarEntry[] {
  const tarData = gunzipSync(gzippedData);
  const entries: TarEntry[] = [];
  let offset = 0;
  const BLOCK_SIZE = 512;

  while (offset + BLOCK_SIZE <= tarData.length) {
    const header = tarData.subarray(offset, offset + BLOCK_SIZE);
    if (header.every((b) => b === 0)) break;

    let end = 0;
    while (end < 100 && header[end] !== 0) end++;
    const name = new TextDecoder().decode(header.subarray(0, end));

    let sizeEnd = 124;
    while (sizeEnd < 136 && header[sizeEnd] !== 0) sizeEnd++;
    const sizeStr = new TextDecoder().decode(header.subarray(124, sizeEnd));
    const size = parseInt(sizeStr, 8) || 0;

    const dataStart = offset + BLOCK_SIZE;
    const data = tarData.subarray(dataStart, dataStart + size);
    const dataBlocks = Math.ceil(size / BLOCK_SIZE);

    if (header[156] === "0".charCodeAt(0) || header[156] === 0) {
      entries.push({ name, data: new Uint8Array(data) });
    }

    offset = dataStart + dataBlocks * BLOCK_SIZE;
  }

  return entries;
}

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

// ---------------------------------------------------------------------------
// Streaming export tests
// ---------------------------------------------------------------------------

describe("streamExportVBundle", () => {
  test("returns a temp file that exists on disk", async () => {
    const result = await streamExportVBundle({
      workspaceDir: testDir,
    });

    try {
      expect(existsSync(result.tempPath)).toBe(true);
      expect(result.size).toBeGreaterThan(0);
    } finally {
      await result.cleanup();
    }
  });

  test("manifest contains correct SHA-256 checksums for all files", async () => {
    const result = await streamExportVBundle({
      workspaceDir: testDir,
    });

    try {
      const archiveData = new Uint8Array(readFileSync(result.tempPath));
      const entries = parseTarEntries(archiveData);

      for (const fileEntry of result.manifest.files) {
        const tarEntry = entries.find((e) => e.name === fileEntry.path);
        expect(tarEntry).toBeDefined();
        expect(sha256Hex(tarEntry!.data)).toBe(fileEntry.sha256);
      }
    } finally {
      await result.cleanup();
    }
  });

  test("decompressed archive produces same files as buildExportVBundle", async () => {
    const streamResult = await streamExportVBundle({
      workspaceDir: testDir,
    });

    try {
      const syncResult = buildExportVBundle({
        workspaceDir: testDir,
      });

      const streamArchiveData = new Uint8Array(
        readFileSync(streamResult.tempPath),
      );
      const streamEntries = parseTarEntries(streamArchiveData);
      const syncEntries = parseTarEntries(syncResult.archive);

      // Filter out manifest.json — compare only data files
      const streamFileEntries = streamEntries
        .filter((e) => e.name !== "manifest.json")
        .sort((a, b) => a.name.localeCompare(b.name));
      const syncFileEntries = syncEntries
        .filter((e) => e.name !== "manifest.json")
        .sort((a, b) => a.name.localeCompare(b.name));

      // Same set of files
      expect(streamFileEntries.map((e) => e.name)).toEqual(
        syncFileEntries.map((e) => e.name),
      );

      // Same content (verified via checksums)
      for (let i = 0; i < streamFileEntries.length; i++) {
        expect(sha256Hex(streamFileEntries[i].data)).toBe(
          sha256Hex(syncFileEntries[i].data),
        );
      }

      // Same manifest file entries (excluding timing fields)
      const streamManifestFiles = streamResult.manifest.files
        .slice()
        .sort((a, b) => a.path.localeCompare(b.path));
      const syncManifestFiles = syncResult.manifest.files
        .slice()
        .sort((a, b) => a.path.localeCompare(b.path));

      expect(streamManifestFiles.map((f) => f.path)).toEqual(
        syncManifestFiles.map((f) => f.path),
      );
      expect(streamManifestFiles.map((f) => f.sha256)).toEqual(
        syncManifestFiles.map((f) => f.sha256),
      );
      expect(streamManifestFiles.map((f) => f.size)).toEqual(
        syncManifestFiles.map((f) => f.size),
      );
    } finally {
      await streamResult.cleanup();
    }
  });

  test("cleanup removes the temp file", async () => {
    const result = await streamExportVBundle({
      workspaceDir: testDir,
    });

    expect(existsSync(result.tempPath)).toBe(true);
    await result.cleanup();
    expect(existsSync(result.tempPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Round-trip test
// ---------------------------------------------------------------------------

describe("streamExportVBundle round-trip", () => {
  test("streaming archive passes validateVBundle with matching manifest", async () => {
    const result = await streamExportVBundle({
      workspaceDir: testDir,
    });

    try {
      const archiveData = new Uint8Array(readFileSync(result.tempPath));
      const validationResult = validateVBundle(archiveData);

      expect(validationResult.is_valid).toBe(true);
      expect(validationResult.errors).toHaveLength(0);
      expect(validationResult.manifest).toBeDefined();

      // Verify manifest fields match
      expect(validationResult.manifest!.schema_version).toBe(
        result.manifest.schema_version,
      );
      expect(validationResult.manifest!.manifest_sha256).toBe(
        result.manifest.manifest_sha256,
      );

      // Verify file entries match
      const validatedFiles = validationResult
        .manifest!.files.slice()
        .sort((a, b) => a.path.localeCompare(b.path));
      const resultFiles = result.manifest.files
        .slice()
        .sort((a, b) => a.path.localeCompare(b.path));

      expect(validatedFiles).toEqual(resultFiles);
    } finally {
      await result.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Streaming config sanitization test
// ---------------------------------------------------------------------------

describe("streamExportVBundle config sanitization", () => {
  test("exported config.json has environment-specific fields stripped", async () => {
    // Write a config with environment-specific fields that should be stripped
    const configWithEnvFields = {
      provider: "anthropic",
      model: "test-model",
      ingress: {
        publicBaseUrl: "https://my-tunnel.example.com",
        enabled: true,
        port: 8080,
      },
      daemon: {
        autoStart: true,
        logLevel: "debug",
      },
      skills: {
        load: {
          extraDirs: ["/home/user/custom-skills", "/opt/skills"],
          autoReload: true,
        },
      },
      memory: { enabled: true },
    };
    writeFileSync(testConfigPath, JSON.stringify(configWithEnvFields, null, 2));

    const result = await streamExportVBundle({
      workspaceDir: testDir,
    });

    try {
      const archiveData = new Uint8Array(readFileSync(result.tempPath));
      const entries = parseTarEntries(archiveData);

      const configEntry = entries.find(
        (e) => e.name === "workspace/config.json",
      );
      expect(configEntry).toBeDefined();

      const parsedConfig = JSON.parse(
        new TextDecoder().decode(configEntry!.data),
      );

      // Environment-specific fields should be stripped/reset
      expect(parsedConfig.ingress.publicBaseUrl).toBe("");
      expect(parsedConfig.ingress.enabled).toBeUndefined();
      expect(parsedConfig.daemon).toBeUndefined();
      expect(parsedConfig.skills.load.extraDirs).toEqual([]);

      // Non-environment-specific fields should be preserved
      expect(parsedConfig.provider).toBe("anthropic");
      expect(parsedConfig.model).toBe("test-model");
      expect(parsedConfig.ingress.port).toBe(8080);
      expect(parsedConfig.skills.load.autoReload).toBe(true);
      expect(parsedConfig.memory.enabled).toBe(true);
    } finally {
      // Restore original config for subsequent tests
      writeFileSync(testConfigPath, JSON.stringify(TEST_CONFIG, null, 2));
      await result.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Cleanup idempotency test
// ---------------------------------------------------------------------------

describe("streamExportVBundle cleanup", () => {
  test("calling cleanup twice does not throw", async () => {
    const result = await streamExportVBundle({
      workspaceDir: testDir,
    });

    await result.cleanup();
    // Second call should not throw
    await result.cleanup();

    expect(existsSync(result.tempPath)).toBe(false);
  });
});
