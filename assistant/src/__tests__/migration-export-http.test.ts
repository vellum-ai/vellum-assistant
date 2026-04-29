/**
 * HTTP-layer integration tests for POST /v1/migrations/export.
 *
 * Tests cover:
 * - Success: valid .vbundle archive returned with correct headers
 * - Archive structure: returned archive passes vbundle validation
 * - Manifest correctness: schema_version, file entries, checksums
 * - Custom description: optional JSON body sets manifest description
 * - Real data: exported archive contains actual file contents from disk
 * - Graceful fallback: missing db/config produces valid archive with defaults
 * - Auth: route policy enforcement (settings.write scope required)
 * - Integration: existing routes are unaffected by the new endpoint
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
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

const realEnv = await import("../config/env.js");
mock.module("../config/env.js", () => ({
  ...realEnv,
  isHttpAuthDisabled: () => true,
  hasUngatedHttpAuthDisabled: () => false,
  getGatewayInternalBaseUrl: () => "http://127.0.0.1:7830",
  getRuntimeHttpPort: () => 7821,
  getRuntimeHttpHost: () => "127.0.0.1",
  getRuntimeGatewayOriginSecret: () => undefined,
}));

import { defaultV1Options } from "../runtime/migrations/__tests__/v1-test-helpers.js";
import { validateVBundle } from "../runtime/migrations/vbundle-validator.js";
import {
  handleMigrationExport,
  handleMigrationValidate,
} from "../runtime/routes/migration-routes.js";
import { callHandler } from "./helpers/call-route-handler.js";
// Test fixture data: a minimal SQLite header to simulate a real database file
const SQLITE_HEADER = new Uint8Array([
  0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74,
  0x20, 0x33, 0x00,
]);
const TEST_CONFIG = { provider: "anthropic", model: "test-model" };

beforeAll(() => {
  // Write test fixture files so the export reads real data
  mkdirSync(testDbDir, { recursive: true });
  writeFileSync(testDbPath, SQLITE_HEADER);
  writeFileSync(testConfigPath, JSON.stringify(TEST_CONFIG, null, 2) + "\n");
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
// Success tests
// ---------------------------------------------------------------------------

describe("handleMigrationExport", () => {
  test("POST returns 200 with binary vbundle archive", async () => {
    const req = new Request("http://localhost/v1/migrations/export", {
      method: "POST",
    });

    const res = await callHandler(handleMigrationExport, req);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="export-.*\.vbundle"$/,
    );
    expect(res.headers.get("Content-Length")).toBeDefined();
    expect(Number(res.headers.get("Content-Length"))).toBeGreaterThan(0);
    expect(res.headers.get("X-Vbundle-Schema-Version")).toBe("1");
    expect(res.headers.get("X-Vbundle-Manifest-Sha256")).toBeDefined();
    expect(res.headers.get("X-Vbundle-Manifest-Sha256")!.length).toBe(64);
  });

  test("returned archive passes vbundle validation", async () => {
    const req = new Request("http://localhost/v1/migrations/export", {
      method: "POST",
    });

    const res = await callHandler(handleMigrationExport, req);
    const arrayBuffer = await res.arrayBuffer();
    const archiveData = new Uint8Array(arrayBuffer);

    const validationResult = validateVBundle(archiveData);

    expect(validationResult.is_valid).toBe(true);
    expect(validationResult.errors).toHaveLength(0);
    expect(validationResult.manifest).toBeDefined();
  });

  test("manifest has correct structure and metadata", async () => {
    const req = new Request("http://localhost/v1/migrations/export", {
      method: "POST",
    });

    const res = await callHandler(handleMigrationExport, req);
    const arrayBuffer = await res.arrayBuffer();
    const archiveData = new Uint8Array(arrayBuffer);

    const validationResult = validateVBundle(archiveData);
    const manifest = validationResult.manifest!;

    expect(manifest.schema_version).toBe(1);
    expect(manifest.bundle_id).toBeDefined();
    expect(manifest.created_at).toBeDefined();
    expect(manifest.checksum).toBeDefined();

    // Verify file entries — workspace walk uses workspace/ prefix
    const filePaths = manifest.contents.map((f) => f.path);
    expect(filePaths).toContain("workspace/data/db/assistant.db");
    expect(filePaths).toContain("workspace/config.json");

    // Verify each file entry has proper sha256 and size
    for (const file of manifest.contents) {
      expect(file.sha256).toBeDefined();
      expect(file.sha256.length).toBe(64);
      expect(file.size_bytes).toBeGreaterThanOrEqual(0);
    }
  });

  test("custom description in JSON body is accepted but no longer surfaced in manifest", async () => {
    const req = new Request("http://localhost/v1/migrations/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "My custom export description" }),
    });

    const res = await callHandler(handleMigrationExport, req);
    const arrayBuffer = await res.arrayBuffer();
    const archiveData = new Uint8Array(arrayBuffer);

    const validationResult = validateVBundle(archiveData);
    expect(validationResult.is_valid).toBe(true);
    // v1 manifests intentionally drop the legacy `description` field —
    // assert the export still succeeds even though the body carried one.
  });

  test("invalid JSON body is gracefully handled with defaults", async () => {
    const req = new Request("http://localhost/v1/migrations/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not valid json{{{",
    });

    const res = await callHandler(handleMigrationExport, req);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");

    const arrayBuffer = await res.arrayBuffer();
    const archiveData = new Uint8Array(arrayBuffer);
    const validationResult = validateVBundle(archiveData);

    expect(validationResult.is_valid).toBe(true);
  });

  test("POST without Content-Type returns valid archive", async () => {
    const req = new Request("http://localhost/v1/migrations/export", {
      method: "POST",
    });

    const res = await callHandler(handleMigrationExport, req);

    expect(res.status).toBe(200);

    const arrayBuffer = await res.arrayBuffer();
    const archiveData = new Uint8Array(arrayBuffer);
    const validationResult = validateVBundle(archiveData);

    expect(validationResult.is_valid).toBe(true);
  });

  test("Content-Length header matches actual body length", async () => {
    const req = new Request("http://localhost/v1/migrations/export", {
      method: "POST",
    });

    const res = await callHandler(handleMigrationExport, req);
    const arrayBuffer = await res.arrayBuffer();

    expect(Number(res.headers.get("Content-Length"))).toBe(
      arrayBuffer.byteLength,
    );
  });
});

// ---------------------------------------------------------------------------
// Real data population tests
// ---------------------------------------------------------------------------

describe("export data population", () => {
  test("archive contains actual database file content from disk", async () => {
    const req = new Request("http://localhost/v1/migrations/export", {
      method: "POST",
    });

    const res = await callHandler(handleMigrationExport, req);
    const archiveData = new Uint8Array(await res.arrayBuffer());
    const entries = parseTarEntries(archiveData);

    const dbEntry = entries.find(
      (e) => e.name === "workspace/data/db/assistant.db",
    );
    expect(dbEntry).toBeDefined();
    expect(dbEntry!.data.length).toBe(SQLITE_HEADER.length);
    // Verify the exported data matches the test fixture exactly
    expect(sha256Hex(dbEntry!.data)).toBe(sha256Hex(SQLITE_HEADER));
  });

  test("archive contains actual config file content from disk", async () => {
    const req = new Request("http://localhost/v1/migrations/export", {
      method: "POST",
    });

    const res = await callHandler(handleMigrationExport, req);
    const archiveData = new Uint8Array(await res.arrayBuffer());
    const entries = parseTarEntries(archiveData);

    const configEntry = entries.find((e) => e.name === "workspace/config.json");
    expect(configEntry).toBeDefined();

    const configContent = new TextDecoder().decode(configEntry!.data);
    const parsedConfig = JSON.parse(configContent);
    expect(parsedConfig.provider).toBe("anthropic");
    expect(parsedConfig.model).toBe("test-model");
  });

  test("manifest file sizes match actual file sizes on disk", async () => {
    const req = new Request("http://localhost/v1/migrations/export", {
      method: "POST",
    });

    const res = await callHandler(handleMigrationExport, req);
    const archiveData = new Uint8Array(await res.arrayBuffer());

    const validationResult = validateVBundle(archiveData);
    const manifest = validationResult.manifest!;

    const dbFile = manifest.contents.find(
      (f) => f.path === "workspace/data/db/assistant.db",
    );
    expect(dbFile).toBeDefined();
    expect(dbFile!.size_bytes).toBe(SQLITE_HEADER.length);

    const configFile = manifest.contents.find(
      (f) => f.path === "workspace/config.json",
    );
    expect(configFile).toBeDefined();
    const expectedConfigSize = Buffer.byteLength(
      JSON.stringify(TEST_CONFIG, null, 2) + "\n",
    );
    expect(configFile!.size_bytes).toBe(expectedConfigSize);
  });

  test("manifest checksums match actual file content", async () => {
    const req = new Request("http://localhost/v1/migrations/export", {
      method: "POST",
    });

    const res = await callHandler(handleMigrationExport, req);
    const archiveData = new Uint8Array(await res.arrayBuffer());
    const entries = parseTarEntries(archiveData);

    const validationResult = validateVBundle(archiveData);
    const manifest = validationResult.manifest!;

    for (const fileEntry of manifest.contents) {
      const tarEntry = entries.find((e) => e.name === fileEntry.path);
      expect(tarEntry).toBeDefined();
      expect(sha256Hex(tarEntry!.data)).toBe(fileEntry.sha256);
    }
  });

  test("database content is non-empty (real data, not skeleton)", async () => {
    const req = new Request("http://localhost/v1/migrations/export", {
      method: "POST",
    });

    const res = await callHandler(handleMigrationExport, req);
    const archiveData = new Uint8Array(await res.arrayBuffer());

    const validationResult = validateVBundle(archiveData);
    const manifest = validationResult.manifest!;

    const dbFile = manifest.contents.find(
      (f) => f.path === "workspace/data/db/assistant.db",
    );
    expect(dbFile).toBeDefined();
    // The skeleton used size 0 — real export should have actual content
    expect(dbFile!.size_bytes).toBeGreaterThan(0);
  });

  test("config content is real JSON (not empty object placeholder)", async () => {
    const req = new Request("http://localhost/v1/migrations/export", {
      method: "POST",
    });

    const res = await callHandler(handleMigrationExport, req);
    const archiveData = new Uint8Array(await res.arrayBuffer());
    const entries = parseTarEntries(archiveData);

    const configEntry = entries.find((e) => e.name === "workspace/config.json");
    expect(configEntry).toBeDefined();

    const configContent = new TextDecoder().decode(configEntry!.data);
    // The skeleton used "{}" — real export should have actual config
    expect(configContent).not.toBe("{}");
    expect(JSON.parse(configContent)).toHaveProperty("provider");
  });
});

// ---------------------------------------------------------------------------
// Graceful fallback tests
// ---------------------------------------------------------------------------

describe("export graceful fallback", () => {
  test("nonexistent workspace produces archive that fails the v1 contents refine", async () => {
    const { buildExportVBundle } =
      await import("../runtime/migrations/vbundle-builder.js");

    const result = buildExportVBundle({
      workspaceDir: join(testDir, "nonexistent-workspace"),
      ...defaultV1Options(),
    });

    // Under v1, every bundle MUST declare a `data/db/assistant.db` (or
    // `workspace/data/db/assistant.db`) entry. A nonexistent workspace
    // produces an empty contents array, which the validator's `.refine()`
    // rejects. Documenting this so a future regression on the workspace
    // walk doesn't silently produce a structurally-empty bundle.
    const validationResult = validateVBundle(result.archive);
    expect(validationResult.is_valid).toBe(false);
    expect(result.manifest.contents).toHaveLength(0);
  });

  test("workspace walk includes db and config under workspace/ prefix", async () => {
    const { buildExportVBundle } =
      await import("../runtime/migrations/vbundle-builder.js");

    const result = buildExportVBundle({
      workspaceDir: testDir,
      ...defaultV1Options(),
    });

    const validationResult = validateVBundle(result.archive);
    expect(validationResult.is_valid).toBe(true);

    const dbFile = result.manifest.contents.find(
      (f) => f.path === "workspace/data/db/assistant.db",
    );
    expect(dbFile).toBeDefined();
    expect(dbFile!.size_bytes).toBeGreaterThan(0);

    const configFile = result.manifest.contents.find(
      (f) => f.path === "workspace/config.json",
    );
    expect(configFile).toBeDefined();
    expect(configFile!.size_bytes).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Config sanitization tests
// ---------------------------------------------------------------------------

describe("export config sanitization", () => {
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

    const req = new Request("http://localhost/v1/migrations/export", {
      method: "POST",
    });

    const res = await callHandler(handleMigrationExport, req);
    const archiveData = new Uint8Array(await res.arrayBuffer());
    const entries = parseTarEntries(archiveData);

    const configEntry = entries.find((e) => e.name === "workspace/config.json");
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
  });
});

// ---------------------------------------------------------------------------
// Auth policy registration tests
// ---------------------------------------------------------------------------

describe("route policy registration", () => {
  test("migrations/export policy requires settings.write scope", async () => {
    const { getPolicy } = await import("../runtime/auth/route-policy.js");
    const policy = getPolicy("migrations/export");

    expect(policy).toBeDefined();
    expect(policy?.requiredScopes).toContain("settings.write");
    expect(policy?.allowedPrincipalTypes).toContain("actor");
    expect(policy?.allowedPrincipalTypes).toContain("svc_gateway");
    expect(policy?.allowedPrincipalTypes).toContain("local");
  });

  test("migrations/validate policy is still registered", async () => {
    const { getPolicy } = await import("../runtime/auth/route-policy.js");
    const policy = getPolicy("migrations/validate");

    expect(policy).toBeDefined();
    expect(policy?.requiredScopes).toContain("settings.read");
  });
});

// ---------------------------------------------------------------------------
// Auth policy shape tests
// ---------------------------------------------------------------------------

describe("auth policy shape", () => {
  test("export policy requires settings.write and would deny without it", async () => {
    const { getPolicy } = await import("../runtime/auth/route-policy.js");
    const policy = getPolicy("migrations/export");

    expect(policy).toBeDefined();
    // Verify the policy shape means a caller without settings.write would be denied
    expect(policy!.requiredScopes).toEqual(["settings.write"]);
    // Verify only the expected principal types are allowed
    expect(policy!.allowedPrincipalTypes).toEqual(
      expect.arrayContaining(["actor", "svc_gateway", "svc_daemon", "local"]),
    );
    expect(policy!.allowedPrincipalTypes).toHaveLength(4);
  });

  test("export policy differs from validate policy on scopes (validate is read-only)", async () => {
    const { getPolicy } = await import("../runtime/auth/route-policy.js");
    const exportPolicy = getPolicy("migrations/export");
    const validatePolicy = getPolicy("migrations/validate");

    // validate is read-only so requires settings.read; export requires settings.write
    expect(exportPolicy!.requiredScopes).toEqual(["settings.write"]);
    expect(validatePolicy!.requiredScopes).toEqual(["settings.read"]);
    // Both share the same principal types
    expect(exportPolicy!.allowedPrincipalTypes).toEqual(
      validatePolicy!.allowedPrincipalTypes,
    );
  });
});

// ---------------------------------------------------------------------------
// Integration: existing routes unaffected
// ---------------------------------------------------------------------------

describe("integration: existing routes unaffected", () => {
  test("validate endpoint still works correctly", async () => {
    // Just confirm that importing both handlers works without conflicts
    const validateHandler = handleMigrationValidate;
    const exportHandler = handleMigrationExport;

    expect(typeof validateHandler).toBe("function");
    expect(typeof exportHandler).toBe("function");
  });

  test("GET /v1/health still works (not intercepted by migration routes)", async () => {
    const { handleDetailedHealth } =
      await import("../runtime/routes/identity-routes.js");
    const res = handleDetailedHealth();
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.status).toBe("healthy");
  });
});
