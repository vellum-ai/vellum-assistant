/**
 * HTTP-layer integration tests for POST /v1/migrations/import.
 *
 * Tests cover:
 * - Success: valid .vbundle writes files to disk and returns import report
 * - Validation failures: invalid bundle returns success: false with errors
 * - Request errors: empty body, invalid multipart
 * - Backup creation: existing files are backed up before overwriting
 * - Post-write integrity: written files match expected checksums
 * - Skipped files: unknown archive paths are reported as skipped
 * - Auth: route policy enforcement (settings.write scope required)
 * - Integration: existing routes are unaffected by the new endpoint
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

/** Convert a Uint8Array to an ArrayBuffer for BodyInit compatibility. */
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength,
  ) as ArrayBuffer;
}

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

import { DefaultPathResolver } from "../runtime/migrations/vbundle-import-analyzer.js";
import { commitImport } from "../runtime/migrations/vbundle-importer.js";
import { handleMigrationImport } from "../runtime/routes/migration-routes.js";

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

// Restore test files before each test so mutations from previous tests
// do not leak across test cases.
beforeEach(() => {
  mkdirSync(testDbDir, { recursive: true });
  writeFileSync(testDbPath, EXISTING_DB_DATA);
  writeFileSync(testConfigPath, JSON.stringify(EXISTING_CONFIG, null, 2));
});

// Clean up backup files after each test
afterEach(() => {
  try {
    const entries = readdirSync(testDbDir);
    for (const entry of entries) {
      if (entry.includes(".backup-")) {
        unlinkSync(join(testDbDir, entry));
      }
    }
    const parentEntries = readdirSync(testDir);
    for (const entry of parentEntries) {
      if (entry.includes(".backup-")) {
        unlinkSync(join(testDir, entry));
      }
    }
  } catch {
    /* best effort */
  }
});

// ---------------------------------------------------------------------------
// Tar archive builder helpers (mirrors validate/preflight tests)
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
// Import commit report types (for type-safe assertions)
// ---------------------------------------------------------------------------

interface ImportCommitResponse {
  success: boolean;
  summary: {
    total_files: number;
    files_created: number;
    files_overwritten: number;
    files_skipped: number;
    backups_created: number;
  };
  files: Array<{
    path: string;
    disk_path: string;
    action: string;
    size: number;
    sha256: string;
    backup_path: string | null;
  }>;
  manifest: Record<string, unknown>;
  warnings: string[];
}

interface ImportValidationFailureResponse {
  success: boolean;
  reason: string;
  errors: Array<{ code: string; message: string; path?: string }>;
}

// ---------------------------------------------------------------------------
// HTTP handler tests: success cases
// ---------------------------------------------------------------------------

describe("handleMigrationImport", () => {
  test("POST with valid vbundle returns 200 with import report", async () => {
    const newDbData = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const vbundle = createValidVBundle([
      { path: "data/db/assistant.db", data: newDbData },
    ]);
    const req = new Request("http://localhost/v1/migrations/import", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: toArrayBuffer(vbundle),
    });

    const res = await handleMigrationImport(req);
    const body = (await res.json()) as ImportCommitResponse;

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.summary).toBeDefined();
    expect(body.summary.total_files).toBeGreaterThan(0);
    expect(body.files).toBeDefined();
    expect(body.files.length).toBeGreaterThan(0);
    expect(body.manifest).toBeDefined();
  });

  test("writes bundle data to disk", async () => {
    const newDbData = new Uint8Array([0xca, 0xfe, 0xba, 0xbe, 0xde, 0xad]);
    const vbundle = createValidVBundle([
      { path: "data/db/assistant.db", data: newDbData },
    ]);
    const req = new Request("http://localhost/v1/migrations/import", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: toArrayBuffer(vbundle),
    });

    await handleMigrationImport(req);

    // Verify the file was actually written to disk
    const writtenData = new Uint8Array(readFileSync(testDbPath));
    expect(writtenData).toEqual(newDbData);
  });

  test("workspace is cleared before restore — preserved dirs are overwritten", async () => {
    // New-format bundles (workspace/ prefix) trigger workspace clearing, but
    // data/db/ is preserved during clearing to avoid destroying the database
    // if the import fails partway. The DB file is overwritten (with backup).
    const newDbData = new Uint8Array([0x01, 0x02, 0x03]);
    const vbundle = createValidVBundle([
      { path: "workspace/data/db/assistant.db", data: newDbData },
    ]);
    const req = new Request("http://localhost/v1/migrations/import", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: toArrayBuffer(vbundle),
    });

    const res = await handleMigrationImport(req);
    const body = (await res.json()) as ImportCommitResponse;

    expect(body.success).toBe(true);
    expect(body.summary.backups_created).toBe(1);

    const dbFile = body.files.find(
      (f) => f.path === "workspace/data/db/assistant.db",
    );
    expect(dbFile).toBeDefined();
    expect(dbFile!.action).toBe("overwritten");
  });

  test("workspace clear: preserved dirs overwritten, cleared dirs created", async () => {
    // data/db/ is preserved during workspace clearing → DB is "overwritten".
    // config.json lives at the workspace root which IS cleared → "created".
    const newDbData = new Uint8Array([0xaa, 0xbb]);
    const newConfigData = new TextEncoder().encode('{"provider":"openai"}');
    const vbundle = createValidVBundle([
      { path: "workspace/data/db/assistant.db", data: newDbData },
      { path: "workspace/config.json", data: newConfigData },
    ]);
    const req = new Request("http://localhost/v1/migrations/import", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: toArrayBuffer(vbundle),
    });

    const res = await handleMigrationImport(req);
    const body = (await res.json()) as ImportCommitResponse;

    expect(body.success).toBe(true);

    const dbFile = body.files.find(
      (f) => f.path === "workspace/data/db/assistant.db",
    );
    const configFile = body.files.find(
      (f) => f.path === "workspace/config.json",
    );

    // data/db/ preserved during clearing → overwritten; config.json cleared → created
    expect(dbFile!.action).toBe("overwritten");
    expect(configFile!.action).toBe("created");
  });

  test("summary counts match file details", async () => {
    const newDbData = new Uint8Array([0xdd, 0xee, 0xff]);
    const newConfigData = new TextEncoder().encode('{"provider":"test"}');
    const vbundle = createValidVBundle([
      { path: "data/db/assistant.db", data: newDbData },
      { path: "config/settings.json", data: newConfigData },
    ]);
    const req = new Request("http://localhost/v1/migrations/import", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: toArrayBuffer(vbundle),
    });

    const res = await handleMigrationImport(req);
    const body = (await res.json()) as ImportCommitResponse;

    expect(body.success).toBe(true);
    expect(body.summary.total_files).toBe(body.files.length);

    const created = body.files.filter((f) => f.action === "created").length;
    const overwritten = body.files.filter(
      (f) => f.action === "overwritten",
    ).length;
    const skipped = body.files.filter((f) => f.action === "skipped").length;

    expect(body.summary.files_created).toBe(created);
    expect(body.summary.files_overwritten).toBe(overwritten);
    expect(body.summary.files_skipped).toBe(skipped);
  });

  test("includes manifest in response", async () => {
    const vbundle = createValidVBundle(undefined, {
      source: "test-import-source",
      description: "Test import commit",
    });
    const req = new Request("http://localhost/v1/migrations/import", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: toArrayBuffer(vbundle),
    });

    const res = await handleMigrationImport(req);
    const body = (await res.json()) as ImportCommitResponse;

    expect(body.manifest).toBeDefined();
    expect(body.manifest.schema_version).toBe("1.0");
    expect(body.manifest.source).toBe("test-import-source");
    expect(body.manifest.description).toBe("Test import commit");
  });

  test("POST with multipart form data works", async () => {
    const vbundle = createValidVBundle();
    const formData = new FormData();
    formData.append("file", new Blob([toArrayBuffer(vbundle)]), "test.vbundle");

    const req = new Request("http://localhost/v1/migrations/import", {
      method: "POST",
      body: formData,
    });

    const res = await handleMigrationImport(req);
    const body = (await res.json()) as ImportCommitResponse;

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
  });

  test("skips files with unknown archive paths", async () => {
    const dbData = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]);
    const extraData = new Uint8Array([0x01, 0x02]);
    const vbundle = createValidVBundle([
      { path: "data/db/assistant.db", data: dbData },
      { path: "unknown/extra-file.bin", data: extraData },
    ]);
    const req = new Request("http://localhost/v1/migrations/import", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: toArrayBuffer(vbundle),
    });

    const res = await handleMigrationImport(req);
    const body = (await res.json()) as ImportCommitResponse;

    expect(body.success).toBe(true);
    expect(body.summary.files_skipped).toBe(1);

    const skippedFile = body.files.find(
      (f) => f.path === "unknown/extra-file.bin",
    );
    expect(skippedFile).toBeDefined();
    expect(skippedFile!.action).toBe("skipped");
    expect(body.warnings.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// HTTP handler tests: validation failure cases
// ---------------------------------------------------------------------------

describe("handleMigrationImport — validation failures", () => {
  test("invalid gzip returns success: false with validation errors", async () => {
    const req = new Request("http://localhost/v1/migrations/import", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: toArrayBuffer(new Uint8Array([0xde, 0xad, 0xbe, 0xef])),
    });

    const res = await handleMigrationImport(req);
    const body = (await res.json()) as ImportValidationFailureResponse;

    expect(res.status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.reason).toBe("validation_failed");
    expect(body.errors.length).toBeGreaterThan(0);
    expect(body.errors[0].code).toBe("INVALID_GZIP");
  });

  test("missing manifest returns success: false", async () => {
    const dbData = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]);
    const tar = createTarArchive([
      { name: "data/db/assistant.db", data: dbData },
    ]);
    const vbundle = gzipSync(tar);

    const req = new Request("http://localhost/v1/migrations/import", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: toArrayBuffer(vbundle),
    });

    const res = await handleMigrationImport(req);
    const body = (await res.json()) as ImportValidationFailureResponse;

    expect(res.status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.reason).toBe("validation_failed");
  });

  test("empty body returns 400", async () => {
    const req = new Request("http://localhost/v1/migrations/import", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: toArrayBuffer(new Uint8Array(0)),
    });

    const res = await handleMigrationImport(req);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  test("multipart without file field returns 400", async () => {
    const formData = new FormData();
    formData.append("notfile", "some text");

    const req = new Request("http://localhost/v1/migrations/import", {
      method: "POST",
      body: formData,
    });

    const res = await handleMigrationImport(req);
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  test("does not modify disk when validation fails", async () => {
    // Save original data
    const originalDb = new Uint8Array(readFileSync(testDbPath));
    const originalConfig = readFileSync(testConfigPath, "utf8");

    // Send invalid bundle
    const req = new Request("http://localhost/v1/migrations/import", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: toArrayBuffer(new Uint8Array([0xde, 0xad, 0xbe, 0xef])),
    });

    await handleMigrationImport(req);

    // Verify disk was not modified
    const currentDb = new Uint8Array(readFileSync(testDbPath));
    const currentConfig = readFileSync(testConfigPath, "utf8");

    expect(currentDb).toEqual(originalDb);
    expect(currentConfig).toBe(originalConfig);
  });
});

// ---------------------------------------------------------------------------
// commitImport unit tests
// ---------------------------------------------------------------------------

describe("commitImport", () => {
  test("returns ok: true with report on success", () => {
    const newDbData = new Uint8Array([0xfa, 0xce]);
    const vbundle = createValidVBundle([
      { path: "data/db/assistant.db", data: newDbData },
    ]);

    const resolver = new DefaultPathResolver(testDir);
    const result = commitImport({
      archiveData: vbundle,
      pathResolver: resolver,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.success).toBe(true);
      expect(result.report.files.length).toBeGreaterThan(0);
    }
  });

  test("returns validation_failed for invalid bundles", () => {
    const resolver = new DefaultPathResolver(testDir);
    const result = commitImport({
      archiveData: new Uint8Array([0xba, 0xad]),
      pathResolver: resolver,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("validation_failed");
      if (result.reason === "validation_failed") {
        expect(result.errors.length).toBeGreaterThan(0);
      }
    }
  });

  test("creates parent directories if they do not exist", () => {
    // Use a workspace that does not exist yet
    const nonexistentWorkspace = join(testDir, "new-workspace");
    const expectedDbPath = join(
      nonexistentWorkspace,
      "data",
      "db",
      "assistant.db",
    );

    const dbData = new Uint8Array([0x01, 0x02, 0x03]);
    const vbundle = createValidVBundle([
      { path: "data/db/assistant.db", data: dbData },
    ]);

    const resolver = new DefaultPathResolver(nonexistentWorkspace);
    const result = commitImport({
      archiveData: vbundle,
      pathResolver: resolver,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.files[0].action).toBe("created");
      expect(existsSync(expectedDbPath)).toBe(true);
    }

    // Clean up
    rmSync(nonexistentWorkspace, { recursive: true, force: true });
  });

  test("post-write integrity: written file SHA-256 matches expected", () => {
    const newDbData = new Uint8Array([0xab, 0xcd, 0xef]);
    const expectedSha256 = sha256Hex(newDbData);

    const vbundle = createValidVBundle([
      { path: "data/db/assistant.db", data: newDbData },
    ]);

    const resolver = new DefaultPathResolver(testDir);
    const result = commitImport({
      archiveData: vbundle,
      pathResolver: resolver,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // No integrity warnings should be present
      const integrityWarnings = result.report.warnings.filter((w) =>
        w.includes("integrity"),
      );
      expect(integrityWarnings).toHaveLength(0);

      // Verify the file on disk matches
      const writtenData = new Uint8Array(readFileSync(testDbPath));
      const writtenSha256 = sha256Hex(writtenData);
      expect(writtenSha256).toBe(expectedSha256);
    }
  });

  test("handles multiple files (db + config)", () => {
    const newDbData = new Uint8Array([0x11, 0x22, 0x33]);
    const newConfigData = new TextEncoder().encode('{"model":"claude"}');

    const vbundle = createValidVBundle([
      { path: "data/db/assistant.db", data: newDbData },
      { path: "config/settings.json", data: newConfigData },
    ]);

    const resolver = new DefaultPathResolver(testDir);
    const result = commitImport({
      archiveData: vbundle,
      pathResolver: resolver,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.summary.total_files).toBe(2);

      // Verify both files were written
      const writtenDb = new Uint8Array(readFileSync(testDbPath));
      expect(writtenDb).toEqual(newDbData);

      const writtenConfig = readFileSync(testConfigPath, "utf8");
      expect(writtenConfig).toBe('{"model":"claude"}');
    }
  });
});

// ---------------------------------------------------------------------------
// Workspace clearing tests
// ---------------------------------------------------------------------------

describe("commitImport — workspace clearing", () => {
  const skillsDir = join(testDir, "skills");
  const hooksDir = join(testDir, "hooks");

  afterEach(() => {
    // Restore test fixture files for subsequent tests
    mkdirSync(testDbDir, { recursive: true });
    writeFileSync(testDbPath, EXISTING_DB_DATA);
    writeFileSync(testConfigPath, JSON.stringify(EXISTING_CONFIG, null, 2));
    // Clean up skills/hooks dirs
    for (const dir of [skillsDir, hooksDir]) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  test("clears stale files via workspace clearing (new-format workspace/ entries)", () => {
    mkdirSync(join(skillsDir, "stale-skill"), { recursive: true });
    writeFileSync(join(skillsDir, "stale-skill", "SKILL.md"), "stale");

    const skillData = new TextEncoder().encode("# New Skill");
    const vbundle = createValidVBundle([
      { path: "workspace/skills/new-skill/SKILL.md", data: skillData },
    ]);

    const resolver = new DefaultPathResolver(testDir);
    const result = commitImport({
      archiveData: vbundle,
      pathResolver: resolver,
      workspaceDir: testDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // New skill written
    expect(existsSync(join(skillsDir, "new-skill", "SKILL.md"))).toBe(true);
    expect(readFileSync(join(skillsDir, "new-skill", "SKILL.md"), "utf8")).toBe(
      "# New Skill",
    );

    // Stale skill removed by workspace clearing
    expect(existsSync(join(skillsDir, "stale-skill"))).toBe(false);
  });

  test("old-format skills/ entries do not trigger workspace clearing", () => {
    mkdirSync(join(skillsDir, "stale-skill"), { recursive: true });
    writeFileSync(join(skillsDir, "stale-skill", "SKILL.md"), "stale");

    const skillData = new TextEncoder().encode("# New Skill");
    const vbundle = createValidVBundle([
      { path: "skills/new-skill/SKILL.md", data: skillData },
    ]);

    const resolver = new DefaultPathResolver(testDir);
    const result = commitImport({
      archiveData: vbundle,
      pathResolver: resolver,
      workspaceDir: testDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // New skill written
    expect(existsSync(join(skillsDir, "new-skill", "SKILL.md"))).toBe(true);

    // Stale skill survives — old-format bundles don't trigger workspace clearing
    expect(existsSync(join(skillsDir, "stale-skill", "SKILL.md"))).toBe(true);
  });

  test("hooks/ entries import to hooksDir (not workspace/hooks/)", () => {
    // Use a separate hooks dir outside the workspace, like production layout
    const externalHooksDir = join(testDir, ".hooks-external");
    mkdirSync(externalHooksDir, { recursive: true });

    const hookData = new TextEncoder().encode("#!/bin/sh\necho new");
    const vbundle = createValidVBundle([
      { path: "hooks/new-hook/hook.sh", data: hookData },
    ]);

    const resolver = new DefaultPathResolver(testDir, externalHooksDir);
    const result = commitImport({
      archiveData: vbundle,
      pathResolver: resolver,
      workspaceDir: testDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Hook written to the external hooks dir, not workspace/hooks/
    expect(existsSync(join(externalHooksDir, "new-hook", "hook.sh"))).toBe(
      true,
    );
    expect(
      readFileSync(join(externalHooksDir, "new-hook", "hook.sh"), "utf8"),
    ).toBe("#!/bin/sh\necho new");

    // Cleanup
    rmSync(externalHooksDir, { recursive: true, force: true });
  });

  test("without workspaceDir, no clearing happens", () => {
    mkdirSync(join(skillsDir, "existing-skill"), { recursive: true });
    writeFileSync(
      join(skillsDir, "existing-skill", "SKILL.md"),
      "should survive",
    );

    const vbundle = createValidVBundle([
      {
        path: "skills/new-skill/SKILL.md",
        data: new TextEncoder().encode("new"),
      },
    ]);

    const resolver = new DefaultPathResolver(testDir);
    // No workspaceDir — no clearing
    const result = commitImport({
      archiveData: vbundle,
      pathResolver: resolver,
    });

    expect(result.ok).toBe(true);

    // Existing skill survives (no workspace clearing without workspaceDir)
    expect(existsSync(join(skillsDir, "existing-skill", "SKILL.md"))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Config sanitization tests
// ---------------------------------------------------------------------------

describe("commitImport — config sanitization", () => {
  test("imported workspace/config.json has environment-specific fields stripped", () => {
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
          extraDirs: ["/home/user/custom-skills"],
          autoReload: true,
        },
      },
      memory: { enabled: true },
    };
    const configData = new TextEncoder().encode(
      JSON.stringify(configWithEnvFields, null, 2),
    );

    const vbundle = createValidVBundle([
      { path: "workspace/config.json", data: configData },
    ]);

    const resolver = new DefaultPathResolver(testDir);
    const result = commitImport({
      archiveData: vbundle,
      pathResolver: resolver,
      workspaceDir: testDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Read the written config from disk and verify sanitization
    const writtenConfig = JSON.parse(readFileSync(testConfigPath, "utf8"));

    // Environment-specific fields should be stripped/reset
    expect(writtenConfig.ingress.publicBaseUrl).toBe("");
    expect(writtenConfig.ingress.enabled).toBeUndefined();
    expect(writtenConfig.daemon).toBeUndefined();
    expect(writtenConfig.skills.load.extraDirs).toEqual([]);

    // Non-environment-specific fields should be preserved
    expect(writtenConfig.provider).toBe("anthropic");
    expect(writtenConfig.model).toBe("test-model");
    expect(writtenConfig.ingress.port).toBe(8080);
    expect(writtenConfig.skills.load.autoReload).toBe(true);
    expect(writtenConfig.memory.enabled).toBe(true);
  });

  test("imported config/settings.json (legacy) has environment-specific fields stripped", () => {
    const configWithEnvFields = {
      provider: "openai",
      daemon: { autoStart: false },
      ingress: {
        publicBaseUrl: "https://old-tunnel.example.com",
        enabled: false,
      },
      skills: { load: { extraDirs: ["/legacy/skills"] } },
    };
    const configData = new TextEncoder().encode(
      JSON.stringify(configWithEnvFields, null, 2),
    );

    const vbundle = createValidVBundle([
      { path: "config/settings.json", data: configData },
    ]);

    const resolver = new DefaultPathResolver(testDir);
    const result = commitImport({
      archiveData: vbundle,
      pathResolver: resolver,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const writtenConfig = JSON.parse(readFileSync(testConfigPath, "utf8"));

    expect(writtenConfig.ingress.publicBaseUrl).toBe("");
    expect(writtenConfig.ingress.enabled).toBeUndefined();
    expect(writtenConfig.daemon).toBeUndefined();
    expect(writtenConfig.skills.load.extraDirs).toEqual([]);
    expect(writtenConfig.provider).toBe("openai");
  });
});

// ---------------------------------------------------------------------------
// Auth policy registration tests
// ---------------------------------------------------------------------------

describe("route policy registration", () => {
  test("migrations/import policy requires settings.write scope", async () => {
    const { getPolicy } = await import("../runtime/auth/route-policy.js");
    const policy = getPolicy("migrations/import");

    expect(policy).toBeDefined();
    expect(policy?.requiredScopes).toContain("settings.write");
    expect(policy?.allowedPrincipalTypes).toContain("actor");
    expect(policy?.allowedPrincipalTypes).toContain("svc_gateway");
    expect(policy?.allowedPrincipalTypes).toContain("local");
  });

  test("import policy matches other migration endpoint policies", async () => {
    const { getPolicy } = await import("../runtime/auth/route-policy.js");
    const importPolicy = getPolicy("migrations/import");
    const validatePolicy = getPolicy("migrations/validate");
    const exportPolicy = getPolicy("migrations/export");
    const preflightPolicy = getPolicy("migrations/import-preflight");

    expect(importPolicy!.requiredScopes).toEqual(
      validatePolicy!.requiredScopes,
    );
    expect(importPolicy!.allowedPrincipalTypes).toEqual(
      validatePolicy!.allowedPrincipalTypes,
    );
    expect(importPolicy!.requiredScopes).toEqual(exportPolicy!.requiredScopes);
    expect(importPolicy!.requiredScopes).toEqual(
      preflightPolicy!.requiredScopes,
    );
  });
});

// ---------------------------------------------------------------------------
// Integration: existing routes unaffected
// ---------------------------------------------------------------------------

describe("integration: existing routes unaffected", () => {
  test("GET /v1/health still works", async () => {
    const { handleDetailedHealth } =
      await import("../runtime/routes/identity-routes.js");
    const res = handleDetailedHealth();
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.status).toBe("healthy");
  });

  test("validate, export, and import-preflight handlers still importable", async () => {
    const {
      handleMigrationValidate,
      handleMigrationExport,
      handleMigrationImportPreflight,
    } = await import("../runtime/routes/migration-routes.js");

    expect(typeof handleMigrationValidate).toBe("function");
    expect(typeof handleMigrationExport).toBe("function");
    expect(typeof handleMigrationImportPreflight).toBe("function");
  });
});
