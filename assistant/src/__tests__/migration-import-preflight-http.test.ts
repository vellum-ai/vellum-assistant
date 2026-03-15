/**
 * HTTP-layer integration tests for POST /v1/migrations/import-preflight.
 *
 * Tests cover:
 * - Success: valid .vbundle returns dry-run report with file analysis
 * - Validation failures: invalid bundle returns can_import: false with validation errors
 * - Request errors: empty body, invalid multipart
 * - File comparison: detects creates, overwrites, and unchanged files
 * - Conflicts: unknown archive paths are flagged
 * - Auth: route policy enforcement (settings.write scope required)
 * - Integration: existing routes are unaffected by the new endpoint
 */
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

/** Convert a Uint8Array to an ArrayBuffer for BodyInit compatibility. */
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength,
  ) as ArrayBuffer;
}

const testDir = realpathSync(
  mkdtempSync(join(tmpdir(), "migration-import-preflight-http-test-")),
);
const testDbDir = join(testDir, "db");
const testDbPath = join(testDbDir, "assistant.db");
const testConfigPath = join(testDir, "config.json");

mock.module("../util/platform.js", () => ({
  getRootDir: () => testDir,
  getDataDir: () => testDir,
  getWorkspaceConfigPath: () => testConfigPath,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => testDbPath,
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
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
    secretDetection: { enabled: false },
    sandbox: { enabled: false },
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
  analyzeImport,
  DefaultPathResolver,
} from "../runtime/migrations/vbundle-import-analyzer.js";
import { handleMigrationImportPreflight } from "../runtime/routes/migration-routes.js";

// Test fixture data
const EXISTING_DB_DATA = new Uint8Array([
  0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74,
  0x20, 0x33, 0x00,
]);
const EXISTING_CONFIG = { provider: "anthropic", model: "test-model" };

beforeAll(() => {
  mkdirSync(testDbDir, { recursive: true });
  writeFileSync(testDbPath, EXISTING_DB_DATA);
  writeFileSync(testConfigPath, JSON.stringify(EXISTING_CONFIG, null, 2));
});

afterAll(() => {
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

// ---------------------------------------------------------------------------
// Tar archive builder helpers (mirrors validate test)
// ---------------------------------------------------------------------------

const BLOCK_SIZE = 512;

function padToBlock(data: Uint8Array): Uint8Array {
  const remainder = data.length % BLOCK_SIZE;
  if (remainder === 0) return data;
  const padded = new Uint8Array(data.length + (BLOCK_SIZE - remainder));
  padded.set(data);
  return padded;
}

function writeOctal(
  buf: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void {
  const str = value.toString(8).padStart(length - 1, "0");
  for (let i = 0; i < str.length; i++) {
    buf[offset + i] = str.charCodeAt(i);
  }
  buf[offset + length - 1] = 0;
}

function computeHeaderChecksum(header: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < 512; i++) {
    if (i >= 148 && i < 156) {
      sum += 0x20;
    } else {
      sum += header[i];
    }
  }
  return sum;
}

function createTarEntry(name: string, data: Uint8Array): Uint8Array {
  const header = new Uint8Array(BLOCK_SIZE);
  const encoder = new TextEncoder();

  const nameBytes = encoder.encode(name);
  header.set(nameBytes.subarray(0, 100), 0);

  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, data.length);
  writeOctal(header, 136, 12, Math.floor(Date.now() / 1000));
  header[156] = "0".charCodeAt(0);

  const magic = encoder.encode("ustar\0");
  header.set(magic, 257);
  header[263] = "0".charCodeAt(0);
  header[264] = "0".charCodeAt(0);

  const checksum = computeHeaderChecksum(header);
  writeOctal(header, 148, 7, checksum);
  header[155] = 0x20;

  const paddedData = padToBlock(data);
  const result = new Uint8Array(header.length + paddedData.length);
  result.set(header, 0);
  result.set(paddedData, header.length);
  return result;
}

function createTarArchive(
  entries: Array<{ name: string; data: Uint8Array }>,
): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    parts.push(createTarEntry(entry.name, entry.data));
  }
  parts.push(new Uint8Array(BLOCK_SIZE * 2));

  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function canonicalizeJson(obj: unknown): string {
  return JSON.stringify(obj, (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[k] = (value as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return value;
  });
}

interface VBundleFile {
  path: string;
  data: Uint8Array;
}

function createValidVBundle(
  files?: VBundleFile[],
  overrides?: Partial<{
    schema_version: string;
    source: string;
    description: string;
  }>,
): Uint8Array {
  const dbData = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]);
  const bundleFiles = files ?? [{ path: "data/db/assistant.db", data: dbData }];

  const fileEntries = bundleFiles.map((f) => ({
    path: f.path,
    sha256: sha256Hex(f.data),
    size: f.data.length,
  }));

  const manifestWithoutChecksum = {
    schema_version: overrides?.schema_version ?? "1.0",
    created_at: new Date().toISOString(),
    source: overrides?.source ?? "test",
    description: overrides?.description ?? "Test bundle",
    files: fileEntries,
  };

  const manifestSha256 = sha256Hex(canonicalizeJson(manifestWithoutChecksum));
  const manifest = {
    ...manifestWithoutChecksum,
    manifest_sha256: manifestSha256,
  };
  const manifestData = new TextEncoder().encode(JSON.stringify(manifest));

  const tarEntries = [
    { name: "manifest.json", data: manifestData },
    ...bundleFiles.map((f) => ({ name: f.path, data: f.data })),
  ];

  const tar = createTarArchive(tarEntries);
  return gzipSync(tar);
}

// ---------------------------------------------------------------------------
// Import dry-run report types (for type-safe assertions)
// ---------------------------------------------------------------------------

interface ImportDryRunResponse {
  can_import: boolean;
  summary: {
    total_files: number;
    files_to_create: number;
    files_to_overwrite: number;
    files_unchanged: number;
    files_to_skip: number;
  };
  files: Array<{
    path: string;
    action: string;
    bundle_size: number;
    current_size: number | null;
    bundle_sha256: string;
    current_sha256: string | null;
  }>;
  conflicts: Array<{
    code: string;
    message: string;
    path?: string;
  }>;
  manifest: Record<string, unknown>;
}

interface ImportValidationFailureResponse {
  can_import: boolean;
  validation: {
    is_valid: boolean;
    errors: Array<{ code: string; message: string; path?: string }>;
  };
}

// ---------------------------------------------------------------------------
// HTTP handler tests: success cases
// ---------------------------------------------------------------------------

describe("handleMigrationImportPreflight", () => {
  test("POST with valid vbundle returns 200 with dry-run report", async () => {
    const vbundle = createValidVBundle();
    const req = new Request("http://localhost/v1/migrations/import-preflight", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: toArrayBuffer(vbundle),
    });

    const res = await handleMigrationImportPreflight(req);
    const body = (await res.json()) as ImportDryRunResponse;

    expect(res.status).toBe(200);
    expect(body.can_import).toBe(true);
    expect(body.summary).toBeDefined();
    expect(body.summary.total_files).toBeGreaterThan(0);
    expect(body.files).toBeDefined();
    expect(body.files.length).toBeGreaterThan(0);
    expect(body.manifest).toBeDefined();
  });

  test("report summary counts match file details", async () => {
    // Bundle with a db file different from disk (overwrite) and config (overwrite)
    const newDbData = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const newConfigData = new TextEncoder().encode('{"provider":"openai"}');
    const vbundle = createValidVBundle([
      { path: "data/db/assistant.db", data: newDbData },
      { path: "config/settings.json", data: newConfigData },
    ]);

    const req = new Request("http://localhost/v1/migrations/import-preflight", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: toArrayBuffer(vbundle),
    });

    const res = await handleMigrationImportPreflight(req);
    const body = (await res.json()) as ImportDryRunResponse;

    expect(body.can_import).toBe(true);
    expect(body.summary.total_files).toBe(body.files.length);

    const creates = body.files.filter((f) => f.action === "create").length;
    const overwrites = body.files.filter(
      (f) => f.action === "overwrite",
    ).length;
    const unchanged = body.files.filter((f) => f.action === "unchanged").length;
    const skips = body.files.filter((f) => f.action === "skip").length;

    expect(body.summary.files_to_create).toBe(creates);
    expect(body.summary.files_to_overwrite).toBe(overwrites);
    expect(body.summary.files_unchanged).toBe(unchanged);
    expect(body.summary.files_to_skip).toBe(skips);
  });

  test("detects overwrite when bundle db differs from disk", async () => {
    const differentDbData = new Uint8Array([0xca, 0xfe, 0xba, 0xbe]);
    const vbundle = createValidVBundle([
      { path: "data/db/assistant.db", data: differentDbData },
    ]);

    const req = new Request("http://localhost/v1/migrations/import-preflight", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: toArrayBuffer(vbundle),
    });

    const res = await handleMigrationImportPreflight(req);
    const body = (await res.json()) as ImportDryRunResponse;

    expect(body.can_import).toBe(true);
    const dbFile = body.files.find((f) => f.path === "data/db/assistant.db");
    expect(dbFile).toBeDefined();
    expect(dbFile!.action).toBe("overwrite");
    expect(dbFile!.bundle_size).toBe(differentDbData.length);
    expect(dbFile!.current_size).toBe(EXISTING_DB_DATA.length);
    expect(dbFile!.bundle_sha256).toBe(sha256Hex(differentDbData));
    expect(dbFile!.current_sha256).toBe(sha256Hex(EXISTING_DB_DATA));
  });

  test("detects unchanged when bundle db matches disk", async () => {
    // Use the same data as what's on disk
    const vbundle = createValidVBundle([
      { path: "data/db/assistant.db", data: EXISTING_DB_DATA },
    ]);

    const req = new Request("http://localhost/v1/migrations/import-preflight", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: toArrayBuffer(vbundle),
    });

    const res = await handleMigrationImportPreflight(req);
    const body = (await res.json()) as ImportDryRunResponse;

    expect(body.can_import).toBe(true);
    const dbFile = body.files.find((f) => f.path === "data/db/assistant.db");
    expect(dbFile).toBeDefined();
    expect(dbFile!.action).toBe("unchanged");
  });

  test("includes manifest in response", async () => {
    const vbundle = createValidVBundle(undefined, {
      source: "test-export",
      description: "Test import preflight",
    });

    const req = new Request("http://localhost/v1/migrations/import-preflight", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: toArrayBuffer(vbundle),
    });

    const res = await handleMigrationImportPreflight(req);
    const body = (await res.json()) as ImportDryRunResponse;

    expect(body.manifest).toBeDefined();
    expect(body.manifest.schema_version).toBe("1.0");
    expect(body.manifest.source).toBe("test-export");
    expect(body.manifest.description).toBe("Test import preflight");
  });

  test("POST with multipart form data works", async () => {
    const vbundle = createValidVBundle();
    const formData = new FormData();
    formData.append("file", new Blob([toArrayBuffer(vbundle)]), "test.vbundle");

    const req = new Request("http://localhost/v1/migrations/import-preflight", {
      method: "POST",
      body: formData,
    });

    const res = await handleMigrationImportPreflight(req);
    const body = (await res.json()) as ImportDryRunResponse;

    expect(res.status).toBe(200);
    expect(body.can_import).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// HTTP handler tests: validation failure cases
// ---------------------------------------------------------------------------

describe("handleMigrationImportPreflight — validation failures", () => {
  test("invalid gzip returns can_import: false with validation errors", async () => {
    const req = new Request("http://localhost/v1/migrations/import-preflight", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: toArrayBuffer(new Uint8Array([0xde, 0xad, 0xbe, 0xef])),
    });

    const res = await handleMigrationImportPreflight(req);
    const body = (await res.json()) as ImportValidationFailureResponse;

    expect(res.status).toBe(200);
    expect(body.can_import).toBe(false);
    expect(body.validation).toBeDefined();
    expect(body.validation.is_valid).toBe(false);
    expect(body.validation.errors.length).toBeGreaterThan(0);
    expect(body.validation.errors[0].code).toBe("INVALID_GZIP");
  });

  test("missing manifest returns can_import: false", async () => {
    const dbData = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]);
    const tar = createTarArchive([
      { name: "data/db/assistant.db", data: dbData },
    ]);
    const vbundle = gzipSync(tar);

    const req = new Request("http://localhost/v1/migrations/import-preflight", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: toArrayBuffer(vbundle),
    });

    const res = await handleMigrationImportPreflight(req);
    const body = (await res.json()) as ImportValidationFailureResponse;

    expect(res.status).toBe(200);
    expect(body.can_import).toBe(false);
    expect(body.validation.is_valid).toBe(false);
  });

  test("empty body returns 400", async () => {
    const req = new Request("http://localhost/v1/migrations/import-preflight", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: toArrayBuffer(new Uint8Array(0)),
    });

    const res = await handleMigrationImportPreflight(req);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  test("multipart without file field returns 400", async () => {
    const formData = new FormData();
    formData.append("notfile", "some text");

    const req = new Request("http://localhost/v1/migrations/import-preflight", {
      method: "POST",
      body: formData,
    });

    const res = await handleMigrationImportPreflight(req);
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });
});

// ---------------------------------------------------------------------------
// Import analyzer unit tests
// ---------------------------------------------------------------------------

describe("analyzeImport", () => {
  test("detects create when file does not exist on disk", () => {
    const resolver = new DefaultPathResolver(
      join(testDir, "nonexistent.db"),
      join(testDir, "nonexistent-config.json"),
    );

    const report = analyzeImport({
      manifest: {
        schema_version: "1.0",
        created_at: new Date().toISOString(),
        files: [
          {
            path: "data/db/assistant.db",
            sha256: sha256Hex(new Uint8Array([1, 2, 3])),
            size: 3,
          },
        ],
        manifest_sha256: "test",
      },
      pathResolver: resolver,
    });

    expect(report.can_import).toBe(true);
    expect(report.files[0].action).toBe("create");
    expect(report.files[0].current_size).toBeNull();
    expect(report.files[0].current_sha256).toBeNull();
    expect(report.summary.files_to_create).toBe(1);
  });

  test("detects unchanged when file on disk matches bundle", () => {
    const resolver = new DefaultPathResolver(testDbPath, testConfigPath);

    const report = analyzeImport({
      manifest: {
        schema_version: "1.0",
        created_at: new Date().toISOString(),
        files: [
          {
            path: "data/db/assistant.db",
            sha256: sha256Hex(EXISTING_DB_DATA),
            size: EXISTING_DB_DATA.length,
          },
        ],
        manifest_sha256: "test",
      },
      pathResolver: resolver,
    });

    expect(report.can_import).toBe(true);
    expect(report.files[0].action).toBe("unchanged");
    expect(report.summary.files_unchanged).toBe(1);
  });

  test("detects overwrite when file on disk differs from bundle", () => {
    const resolver = new DefaultPathResolver(testDbPath, testConfigPath);

    const report = analyzeImport({
      manifest: {
        schema_version: "1.0",
        created_at: new Date().toISOString(),
        files: [
          {
            path: "data/db/assistant.db",
            sha256: sha256Hex(new Uint8Array([0xca, 0xfe])),
            size: 2,
          },
        ],
        manifest_sha256: "test",
      },
      pathResolver: resolver,
    });

    expect(report.can_import).toBe(true);
    expect(report.files[0].action).toBe("overwrite");
    expect(report.files[0].current_size).toBe(EXISTING_DB_DATA.length);
    expect(report.summary.files_to_overwrite).toBe(1);
  });

  test("flags unknown archive paths as conflicts with skip action", () => {
    const resolver = new DefaultPathResolver(testDbPath, testConfigPath);

    const report = analyzeImport({
      manifest: {
        schema_version: "1.0",
        created_at: new Date().toISOString(),
        files: [
          {
            path: "data/db/assistant.db",
            sha256: sha256Hex(EXISTING_DB_DATA),
            size: EXISTING_DB_DATA.length,
          },
          {
            path: "unknown/extra-file.bin",
            sha256: sha256Hex(new Uint8Array([1])),
            size: 1,
          },
        ],
        manifest_sha256: "test",
      },
      pathResolver: resolver,
    });

    expect(report.can_import).toBe(false);
    expect(report.conflicts.length).toBe(1);
    expect(report.conflicts[0].code).toBe("UNKNOWN_ARCHIVE_PATH");
    expect(report.conflicts[0].path).toBe("unknown/extra-file.bin");

    const unknownFile = report.files.find(
      (f) => f.path === "unknown/extra-file.bin",
    );
    expect(unknownFile).toBeDefined();
    expect(unknownFile!.action).toBe("skip");
    expect(report.summary.files_to_skip).toBe(1);
    expect(report.summary.files_to_create).toBe(0);
  });

  test("includes manifest in report", () => {
    const resolver = new DefaultPathResolver(testDbPath, testConfigPath);
    const manifest = {
      schema_version: "1.0",
      created_at: "2024-01-01T00:00:00.000Z",
      source: "test",
      files: [
        {
          path: "data/db/assistant.db",
          sha256: sha256Hex(EXISTING_DB_DATA),
          size: EXISTING_DB_DATA.length,
        },
      ],
      manifest_sha256: "test",
    };

    const report = analyzeImport({ manifest, pathResolver: resolver });

    expect(report.manifest).toBe(manifest);
    expect(report.manifest.schema_version).toBe("1.0");
    expect(report.manifest.source).toBe("test");
  });
});

// ---------------------------------------------------------------------------
// DefaultPathResolver unit tests
// ---------------------------------------------------------------------------

describe("DefaultPathResolver", () => {
  test("resolves data/db/assistant.db to configured db path", () => {
    const resolver = new DefaultPathResolver(
      "/some/db.db",
      "/some/config.json",
    );
    expect(resolver.resolve("data/db/assistant.db")).toBe("/some/db.db");
  });

  test("resolves config/settings.json to configured config path", () => {
    const resolver = new DefaultPathResolver(
      "/some/db.db",
      "/some/config.json",
    );
    expect(resolver.resolve("config/settings.json")).toBe("/some/config.json");
  });

  test("returns null for unknown paths", () => {
    const resolver = new DefaultPathResolver(
      "/some/db.db",
      "/some/config.json",
    );
    expect(resolver.resolve("unknown/path.txt")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Auth policy registration tests
// ---------------------------------------------------------------------------

describe("route policy registration", () => {
  test("migrations/import-preflight policy requires settings.write scope", async () => {
    const { getPolicy } = await import("../runtime/auth/route-policy.js");
    const policy = getPolicy("migrations/import-preflight");

    expect(policy).toBeDefined();
    expect(policy?.requiredScopes).toContain("settings.write");
    expect(policy?.allowedPrincipalTypes).toContain("actor");
    expect(policy?.allowedPrincipalTypes).toContain("svc_gateway");
    expect(policy?.allowedPrincipalTypes).toContain("local");
  });

  test("import-preflight policy matches validate/export policy shape", async () => {
    const { getPolicy } = await import("../runtime/auth/route-policy.js");
    const preflightPolicy = getPolicy("migrations/import-preflight");
    const validatePolicy = getPolicy("migrations/validate");
    const exportPolicy = getPolicy("migrations/export");

    expect(preflightPolicy!.requiredScopes).toEqual(
      validatePolicy!.requiredScopes,
    );
    expect(preflightPolicy!.allowedPrincipalTypes).toEqual(
      validatePolicy!.allowedPrincipalTypes,
    );
    expect(preflightPolicy!.requiredScopes).toEqual(
      exportPolicy!.requiredScopes,
    );
  });
});

// ---------------------------------------------------------------------------
// Integration: existing routes unaffected
// ---------------------------------------------------------------------------

describe("integration: existing routes unaffected", () => {
  test("GET /v1/health still works", async () => {
    const { handleHealth } =
      await import("../runtime/routes/identity-routes.js");
    const res = handleHealth();
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.status).toBe("healthy");
  });

  test("validate and export handlers still importable", async () => {
    const { handleMigrationValidate, handleMigrationExport } =
      await import("../runtime/routes/migration-routes.js");

    expect(typeof handleMigrationValidate).toBe("function");
    expect(typeof handleMigrationExport).toBe("function");
  });
});
