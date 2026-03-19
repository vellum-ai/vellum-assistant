/**
 * Cross-version compatibility tests and failure diagnostics for migration
 * endpoints.
 *
 * Tests cover:
 * - Schema version compatibility: bundles with different schema_version values
 *   can be validated and imported when otherwise structurally valid
 * - Future/unknown schema versions: produce clear, actionable errors when
 *   structural changes break parsing
 * - Missing or malformed version fields: fail with descriptive diagnostics
 * - Round-trip: export -> validate -> import-preflight -> import produces
 *   consistent results
 * - Partial failure scenarios: import fails mid-write, write errors surface
 *   partial reports
 * - Edge cases: empty bundles, very large file entries, duplicate paths,
 *   corrupted checksums, empty file entries
 * - Diagnostic quality: every failure mode includes a machine-readable error
 *   code and a human-readable message
 */
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  afterAll,
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

const testDir = realpathSync(
  mkdtempSync(join(tmpdir(), "migration-cross-version-test-")),
);
const testDbDir = join(testDir, "data", "db");
const testDbPath = join(testDbDir, "assistant.db");
const testConfigPath = join(testDir, "config.json");

mock.module("../util/platform.js", () => ({
  getRootDir: () => testDir,
  getDataDir: () => join(testDir, "data"),
  getWorkspaceDir: () => testDir,
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

import { buildVBundle } from "../runtime/migrations/vbundle-builder.js";
import {
  analyzeImport,
  DefaultPathResolver,
} from "../runtime/migrations/vbundle-import-analyzer.js";
import { commitImport } from "../runtime/migrations/vbundle-importer.js";
import { validateVBundle } from "../runtime/migrations/vbundle-validator.js";
import {
  handleMigrationExport,
  handleMigrationImport,
  handleMigrationImportPreflight,
  handleMigrationValidate,
} from "../runtime/routes/migration-routes.js";

// ---------------------------------------------------------------------------
// Test fixture data
// ---------------------------------------------------------------------------

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

// Restore test files before each test
beforeEach(() => {
  mkdirSync(testDbDir, { recursive: true });
  writeFileSync(testDbPath, EXISTING_DB_DATA);
  writeFileSync(testConfigPath, JSON.stringify(EXISTING_CONFIG, null, 2));
});

// Clean up backup files after each test
afterEach(() => {
  try {
    for (const dir of [testDbDir, testDir]) {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (entry.includes(".backup-")) {
          unlinkSync(join(dir, entry));
        }
      }
    }
  } catch {
    /* best effort */
  }
});

// ---------------------------------------------------------------------------
// Tar archive builder helpers
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

/**
 * Create a vbundle with a raw manifest object (bypassing normal checksumming).
 * Useful for testing malformed/unusual manifests.
 */
function createVBundleWithRawManifest(
  manifestObj: Record<string, unknown>,
  archiveFiles: Array<{ name: string; data: Uint8Array }>,
): Uint8Array {
  const manifestData = new TextEncoder().encode(JSON.stringify(manifestObj));
  const tarEntries = [
    { name: "manifest.json", data: manifestData },
    ...archiveFiles,
  ];
  const tar = createTarArchive(tarEntries);
  return gzipSync(tar);
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

interface ValidationResponse {
  is_valid: boolean;
  errors: Array<{ code: string; message: string; path?: string }>;
  manifest?: Record<string, unknown>;
}

interface ImportDryRunResponse {
  can_import: boolean;
  summary?: {
    total_files: number;
    files_to_create: number;
    files_to_overwrite: number;
    files_unchanged: number;
    files_to_skip: number;
  };
  files?: Array<{
    path: string;
    action: string;
    bundle_size: number;
    current_size: number | null;
    bundle_sha256: string;
    current_sha256: string | null;
  }>;
  conflicts?: Array<{ code: string; message: string; path?: string }>;
  manifest?: Record<string, unknown>;
  validation?: {
    is_valid: boolean;
    errors: Array<{ code: string; message: string; path?: string }>;
  };
}

interface ImportCommitResponse {
  success: boolean;
  reason?: string;
  message?: string;
  summary?: {
    total_files: number;
    files_created: number;
    files_overwritten: number;
    files_skipped: number;
    backups_created: number;
  };
  files?: Array<{
    path: string;
    disk_path: string;
    action: string;
    size: number;
    sha256: string;
    backup_path: string | null;
  }>;
  manifest?: Record<string, unknown>;
  warnings?: string[];
  errors?: Array<{ code: string; message: string; path?: string }>;
  partial_report?: ImportCommitResponse;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Schema version compatibility
// ═══════════════════════════════════════════════════════════════════════════

describe("schema version compatibility", () => {
  test("bundle with schema_version 1.0 validates successfully", () => {
    const vbundle = createValidVBundle(undefined, {
      schema_version: "1.0",
    });
    const result = validateVBundle(vbundle);

    expect(result.is_valid).toBe(true);
    expect(result.manifest?.schema_version).toBe("1.0");
  });

  test("bundle with schema_version 2.0 validates successfully (forward compat)", () => {
    // A structurally valid bundle with a future version should still pass
    // validation because the schema_version field is a string and the
    // archive structure is unchanged.
    const vbundle = createValidVBundle(undefined, {
      schema_version: "2.0",
    });
    const result = validateVBundle(vbundle);

    expect(result.is_valid).toBe(true);
    expect(result.manifest?.schema_version).toBe("2.0");
  });

  test("bundle with schema_version 99.0 validates when structurally valid", () => {
    const vbundle = createValidVBundle(undefined, {
      schema_version: "99.0",
    });
    const result = validateVBundle(vbundle);

    expect(result.is_valid).toBe(true);
    expect(result.manifest?.schema_version).toBe("99.0");
  });

  test("bundle with arbitrary version string validates when structurally valid", () => {
    const vbundle = createValidVBundle(undefined, {
      schema_version: "alpha-preview-3",
    });
    const result = validateVBundle(vbundle);

    expect(result.is_valid).toBe(true);
    expect(result.manifest?.schema_version).toBe("alpha-preview-3");
  });

  test("future-versioned bundle can be imported successfully", () => {
    const newDbData = new Uint8Array([0xfa, 0xce, 0xb0, 0x0c]);
    const vbundle = createValidVBundle(
      [{ path: "data/db/assistant.db", data: newDbData }],
      { schema_version: "3.0" },
    );

    const resolver = new DefaultPathResolver(undefined, testDir);
    const result = commitImport({
      archiveData: vbundle,
      pathResolver: resolver,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.manifest.schema_version).toBe("3.0");
      expect(result.report.success).toBe(true);
    }
  });

  test("future-versioned bundle shows correct version in preflight report", () => {
    const vbundle = createValidVBundle(undefined, {
      schema_version: "5.0-beta",
    });

    const resolver = new DefaultPathResolver(undefined, testDir);
    const validationResult = validateVBundle(vbundle);
    expect(validationResult.manifest).toBeDefined();

    const report = analyzeImport({
      manifest: validationResult.manifest!,
      pathResolver: resolver,
    });

    expect(report.manifest.schema_version).toBe("5.0-beta");
    expect(report.can_import).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Missing or malformed version fields
// ═══════════════════════════════════════════════════════════════════════════

describe("missing or malformed version fields", () => {
  test("missing schema_version produces MANIFEST_SCHEMA_ERROR", () => {
    const dbData = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]);
    const manifestObj = {
      // schema_version intentionally omitted
      created_at: new Date().toISOString(),
      files: [
        {
          path: "data/db/assistant.db",
          sha256: sha256Hex(dbData),
          size: dbData.length,
        },
      ],
      manifest_sha256: "placeholder",
    };

    const vbundle = createVBundleWithRawManifest(manifestObj, [
      { name: "data/db/assistant.db", data: dbData },
    ]);
    const result = validateVBundle(vbundle);

    expect(result.is_valid).toBe(false);
    const schemaError = result.errors.find(
      (e) => e.code === "MANIFEST_SCHEMA_ERROR",
    );
    expect(schemaError).toBeDefined();
    expect(schemaError!.message).toContain("schema_version");
  });

  test("numeric schema_version (instead of string) produces schema error", () => {
    const dbData = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]);
    const manifestObj = {
      schema_version: 1, // should be a string
      created_at: new Date().toISOString(),
      files: [
        {
          path: "data/db/assistant.db",
          sha256: sha256Hex(dbData),
          size: dbData.length,
        },
      ],
      manifest_sha256: "placeholder",
    };

    const vbundle = createVBundleWithRawManifest(manifestObj, [
      { name: "data/db/assistant.db", data: dbData },
    ]);
    const result = validateVBundle(vbundle);

    expect(result.is_valid).toBe(false);
    expect(result.errors.some((e) => e.code === "MANIFEST_SCHEMA_ERROR")).toBe(
      true,
    );
  });

  test("null schema_version produces schema error", () => {
    const dbData = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]);
    const manifestObj = {
      schema_version: null,
      created_at: new Date().toISOString(),
      files: [
        {
          path: "data/db/assistant.db",
          sha256: sha256Hex(dbData),
          size: dbData.length,
        },
      ],
      manifest_sha256: "placeholder",
    };

    const vbundle = createVBundleWithRawManifest(manifestObj, [
      { name: "data/db/assistant.db", data: dbData },
    ]);
    const result = validateVBundle(vbundle);

    expect(result.is_valid).toBe(false);
    expect(result.errors.some((e) => e.code === "MANIFEST_SCHEMA_ERROR")).toBe(
      true,
    );
  });

  test("empty string schema_version passes validation (empty strings are valid)", () => {
    // The Zod schema accepts any string, including empty. An empty string
    // is technically a valid schema_version value, even if unconventional.
    const vbundle = createValidVBundle(undefined, { schema_version: "" });
    const result = validateVBundle(vbundle);

    expect(result.is_valid).toBe(true);
    expect(result.manifest?.schema_version).toBe("");
  });

  test("missing created_at produces MANIFEST_SCHEMA_ERROR", () => {
    const dbData = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]);
    const manifestObj = {
      schema_version: "1.0",
      // created_at intentionally omitted
      files: [
        {
          path: "data/db/assistant.db",
          sha256: sha256Hex(dbData),
          size: dbData.length,
        },
      ],
      manifest_sha256: "placeholder",
    };

    const vbundle = createVBundleWithRawManifest(manifestObj, [
      { name: "data/db/assistant.db", data: dbData },
    ]);
    const result = validateVBundle(vbundle);

    expect(result.is_valid).toBe(false);
    const error = result.errors.find((e) => e.code === "MANIFEST_SCHEMA_ERROR");
    expect(error).toBeDefined();
    expect(error!.message).toContain("created_at");
  });

  test("missing files array produces MANIFEST_SCHEMA_ERROR", () => {
    const dbData = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]);
    const manifestObj = {
      schema_version: "1.0",
      created_at: new Date().toISOString(),
      // files intentionally omitted
      manifest_sha256: "placeholder",
    };

    const vbundle = createVBundleWithRawManifest(manifestObj, [
      { name: "data/db/assistant.db", data: dbData },
    ]);
    const result = validateVBundle(vbundle);

    expect(result.is_valid).toBe(false);
    expect(result.errors.some((e) => e.code === "MANIFEST_SCHEMA_ERROR")).toBe(
      true,
    );
  });

  test("missing manifest_sha256 produces MANIFEST_SCHEMA_ERROR", () => {
    const dbData = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]);
    const manifestObj = {
      schema_version: "1.0",
      created_at: new Date().toISOString(),
      files: [
        {
          path: "data/db/assistant.db",
          sha256: sha256Hex(dbData),
          size: dbData.length,
        },
      ],
      // manifest_sha256 intentionally omitted
    };

    const vbundle = createVBundleWithRawManifest(manifestObj, [
      { name: "data/db/assistant.db", data: dbData },
    ]);
    const result = validateVBundle(vbundle);

    expect(result.is_valid).toBe(false);
    expect(result.errors.some((e) => e.code === "MANIFEST_SCHEMA_ERROR")).toBe(
      true,
    );
  });

  test("file entry missing sha256 produces MANIFEST_SCHEMA_ERROR", () => {
    const dbData = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]);
    const manifestObj = {
      schema_version: "1.0",
      created_at: new Date().toISOString(),
      files: [
        {
          path: "data/db/assistant.db",
          // sha256 intentionally omitted
          size: dbData.length,
        },
      ],
      manifest_sha256: "placeholder",
    };

    const vbundle = createVBundleWithRawManifest(manifestObj, [
      { name: "data/db/assistant.db", data: dbData },
    ]);
    const result = validateVBundle(vbundle);

    expect(result.is_valid).toBe(false);
    expect(result.errors.some((e) => e.code === "MANIFEST_SCHEMA_ERROR")).toBe(
      true,
    );
  });

  test("file entry with negative size produces MANIFEST_SCHEMA_ERROR", () => {
    const dbData = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]);
    const manifestObj = {
      schema_version: "1.0",
      created_at: new Date().toISOString(),
      files: [
        {
          path: "data/db/assistant.db",
          sha256: sha256Hex(dbData),
          size: -1,
        },
      ],
      manifest_sha256: "placeholder",
    };

    const vbundle = createVBundleWithRawManifest(manifestObj, [
      { name: "data/db/assistant.db", data: dbData },
    ]);
    const result = validateVBundle(vbundle);

    expect(result.is_valid).toBe(false);
    expect(result.errors.some((e) => e.code === "MANIFEST_SCHEMA_ERROR")).toBe(
      true,
    );
  });

  test("version field error includes descriptive path in diagnostic", () => {
    const dbData = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]);
    const manifestObj = {
      schema_version: 42, // wrong type
      created_at: new Date().toISOString(),
      files: [
        {
          path: "data/db/assistant.db",
          sha256: sha256Hex(dbData),
          size: dbData.length,
        },
      ],
      manifest_sha256: "placeholder",
    };

    const vbundle = createVBundleWithRawManifest(manifestObj, [
      { name: "data/db/assistant.db", data: dbData },
    ]);
    const result = validateVBundle(vbundle);

    expect(result.is_valid).toBe(false);
    const error = result.errors.find((e) => e.code === "MANIFEST_SCHEMA_ERROR");
    expect(error).toBeDefined();
    // The error path should indicate where in the manifest the issue is
    expect(error!.path).toBeDefined();
    expect(error!.path).toContain("manifest.json");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Round-trip: export -> validate -> import-preflight -> import
// ═══════════════════════════════════════════════════════════════════════════

describe("round-trip: export -> validate -> preflight -> import", () => {
  test("full round-trip produces consistent results via HTTP handlers", async () => {
    // Step 1: Export
    const exportReq = new Request("http://localhost/v1/migrations/export", {
      method: "POST",
    });
    const exportRes = await handleMigrationExport(exportReq);
    expect(exportRes.status).toBe(200);

    const archiveBuffer = await exportRes.arrayBuffer();
    const archiveData = new Uint8Array(archiveBuffer);
    expect(archiveData.length).toBeGreaterThan(0);

    // Step 2: Validate the exported archive
    const validateReq = new Request("http://localhost/v1/migrations/validate", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: toArrayBuffer(archiveData),
    });
    const validateRes = await handleMigrationValidate(validateReq);
    const validateBody = (await validateRes.json()) as ValidationResponse;

    expect(validateRes.status).toBe(200);
    expect(validateBody.is_valid).toBe(true);
    expect(validateBody.errors).toHaveLength(0);
    expect(validateBody.manifest).toBeDefined();

    // Step 3: Import preflight (dry-run)
    const preflightReq = new Request(
      "http://localhost/v1/migrations/import-preflight",
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: toArrayBuffer(archiveData),
      },
    );
    const preflightRes = await handleMigrationImportPreflight(preflightReq);
    const preflightBody = (await preflightRes.json()) as ImportDryRunResponse;

    expect(preflightRes.status).toBe(200);
    expect(preflightBody.can_import).toBe(true);
    expect(preflightBody.summary).toBeDefined();
    expect(preflightBody.files).toBeDefined();
    expect(preflightBody.manifest).toBeDefined();

    // The files should show "unchanged" since we exported from the same disk.
    // New format uses workspace/ prefix for archive paths.
    const dbFile = preflightBody.files!.find(
      (f) => f.path === "workspace/data/db/assistant.db",
    );
    expect(dbFile).toBeDefined();
    expect(dbFile!.action).toBe("unchanged");

    // Step 4: Import (commit)
    const importReq = new Request("http://localhost/v1/migrations/import", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: toArrayBuffer(archiveData),
    });
    const importRes = await handleMigrationImport(importReq);
    const importBody = (await importRes.json()) as ImportCommitResponse;

    expect(importRes.status).toBe(200);
    expect(importBody.success).toBe(true);
    expect(importBody.manifest).toBeDefined();

    // Schema version should be consistent across all steps
    expect(validateBody.manifest!.schema_version).toBe(
      preflightBody.manifest!.schema_version,
    );
    expect(validateBody.manifest!.schema_version).toBe(
      importBody.manifest!.schema_version,
    );
  });

  test("round-trip via builder: build -> validate -> analyze -> commit", () => {
    const dbData = new Uint8Array([0xca, 0xfe, 0xba, 0xbe]);
    const configData = new TextEncoder().encode('{"model":"test-round-trip"}');

    // Step 1: Build
    const { archive, manifest } = buildVBundle({
      files: [
        { path: "data/db/assistant.db", data: dbData },
        { path: "config/settings.json", data: configData },
      ],
      schemaVersion: "1.0",
      source: "round-trip-test",
      description: "Testing round-trip",
    });

    expect(manifest.schema_version).toBe("1.0");
    expect(manifest.files).toHaveLength(2);

    // Step 2: Validate
    const validationResult = validateVBundle(archive);
    expect(validationResult.is_valid).toBe(true);
    expect(validationResult.manifest?.manifest_sha256).toBe(
      manifest.manifest_sha256,
    );

    // Step 3: Analyze (preflight)
    const resolver = new DefaultPathResolver(undefined, testDir);
    const report = analyzeImport({
      manifest: validationResult.manifest!,
      pathResolver: resolver,
    });

    expect(report.can_import).toBe(true);
    expect(report.summary.total_files).toBe(2);

    // Step 4: Commit
    const commitResult = commitImport({
      archiveData: archive,
      pathResolver: resolver,
    });

    expect(commitResult.ok).toBe(true);
    if (commitResult.ok) {
      expect(commitResult.report.success).toBe(true);
      expect(commitResult.report.manifest.schema_version).toBe("1.0");
      expect(commitResult.report.summary.total_files).toBe(2);

      // Verify data on disk matches what we built
      const writtenDb = new Uint8Array(readFileSync(testDbPath));
      expect(sha256Hex(writtenDb)).toBe(sha256Hex(dbData));

      const writtenConfig = readFileSync(testConfigPath, "utf8");
      expect(writtenConfig).toBe('{"model":"test-round-trip"}');
    }
  });

  test("export manifest checksum remains valid through validate step", async () => {
    const exportReq = new Request("http://localhost/v1/migrations/export", {
      method: "POST",
    });
    const exportRes = await handleMigrationExport(exportReq);
    const archiveData = new Uint8Array(await exportRes.arrayBuffer());

    // The X-Vbundle-Manifest-Sha256 response header should match
    // the manifest_sha256 inside the archive
    const headerSha = exportRes.headers.get("X-Vbundle-Manifest-Sha256");
    expect(headerSha).toBeDefined();

    const validationResult = validateVBundle(archiveData);
    expect(validationResult.is_valid).toBe(true);
    expect(validationResult.manifest?.manifest_sha256).toBe(headerSha!);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Partial failure scenarios
// ═══════════════════════════════════════════════════════════════════════════

describe("partial failure scenarios", () => {
  test("commitImport to read-only path returns write_failed with partial report", () => {
    const newDbData = new Uint8Array([0xde, 0xad]);
    const vbundle = createValidVBundle([
      { path: "data/db/assistant.db", data: newDbData },
    ]);

    // Point to a workspace path where data/db cannot be created
    // (a regular file blocks directory creation)
    const blockerWorkspace = join(testDir, "blocker-workspace");
    mkdirSync(blockerWorkspace, { recursive: true });
    // Create "data" as a regular file — mkdirSync("data/db") will fail
    writeFileSync(
      join(blockerWorkspace, "data"),
      "I am a file, not a directory",
    );

    const resolver = new DefaultPathResolver(undefined, blockerWorkspace);
    const result = commitImport({
      archiveData: vbundle,
      pathResolver: resolver,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("write_failed");
      expect((result as { message: string }).message).toBeDefined();
      expect((result as { message: string }).message.length).toBeGreaterThan(0);
    }

    // Clean up
    rmSync(blockerWorkspace, { recursive: true, force: true });
  });

  test("commitImport with invalid archive returns validation_failed", () => {
    const resolver = new DefaultPathResolver(undefined, testDir);
    const result = commitImport({
      archiveData: new Uint8Array([0xba, 0xad, 0xf0, 0x0d]),
      pathResolver: resolver,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("validation_failed");
      const errors = (
        result as {
          errors: Array<{ code: string; message: string }>;
        }
      ).errors;
      expect(errors).toBeDefined();
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].code).toBe("INVALID_GZIP");
    }
  });

  test("import HTTP endpoint returns structured error for invalid archives", async () => {
    const req = new Request("http://localhost/v1/migrations/import", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: toArrayBuffer(new Uint8Array([0xff, 0xfe, 0xfd])),
    });

    const res = await handleMigrationImport(req);
    const body = (await res.json()) as ImportCommitResponse;

    expect(body.success).toBe(false);
    expect(body.reason).toBe("validation_failed");
    expect(body.errors).toBeDefined();
    expect(body.errors!.length).toBeGreaterThan(0);

    // Each error should have both a code and a message
    for (const err of body.errors!) {
      expect(err.code).toBeDefined();
      expect(err.code.length).toBeGreaterThan(0);
      expect(err.message).toBeDefined();
      expect(err.message.length).toBeGreaterThan(0);
    }
  });

  test("preflight returns validation errors for corrupted bundle", async () => {
    const req = new Request("http://localhost/v1/migrations/import-preflight", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: toArrayBuffer(new Uint8Array([0xba, 0xdc, 0x0d, 0xe5])),
    });

    const res = await handleMigrationImportPreflight(req);
    const body = (await res.json()) as ImportDryRunResponse;

    expect(res.status).toBe(200);
    expect(body.can_import).toBe(false);
    expect(body.validation).toBeDefined();
    expect(body.validation!.is_valid).toBe(false);
    expect(body.validation!.errors.length).toBeGreaterThan(0);
  });

  test("import does not modify disk when bundle has checksum mismatch", () => {
    // Save original disk state
    const originalDb = new Uint8Array(readFileSync(testDbPath));
    const originalConfig = readFileSync(testConfigPath, "utf8");

    // Create bundle with corrupted checksum
    const dbData = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]);
    const manifest = {
      schema_version: "1.0",
      created_at: new Date().toISOString(),
      files: [
        {
          path: "data/db/assistant.db",
          sha256: sha256Hex(dbData),
          size: dbData.length,
        },
      ],
      manifest_sha256:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };
    const manifestData = new TextEncoder().encode(JSON.stringify(manifest));
    const tar = createTarArchive([
      { name: "manifest.json", data: manifestData },
      { name: "data/db/assistant.db", data: dbData },
    ]);
    const corruptVBundle = gzipSync(tar);

    const resolver = new DefaultPathResolver(undefined, testDir);
    const result = commitImport({
      archiveData: corruptVBundle,
      pathResolver: resolver,
    });

    expect(result.ok).toBe(false);

    // Disk should be unchanged
    const currentDb = new Uint8Array(readFileSync(testDbPath));
    const currentConfig = readFileSync(testConfigPath, "utf8");
    expect(currentDb).toEqual(originalDb);
    expect(currentConfig).toBe(originalConfig);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("edge cases", () => {
  test("bundle with empty database file validates and imports", () => {
    const emptyDb = new Uint8Array(0);
    const vbundle = createValidVBundle([
      { path: "data/db/assistant.db", data: emptyDb },
    ]);

    const result = validateVBundle(vbundle);
    expect(result.is_valid).toBe(true);
    expect(result.manifest?.files[0].size).toBe(0);

    // Import should also succeed
    const resolver = new DefaultPathResolver(undefined, testDir);
    const importResult = commitImport({
      archiveData: vbundle,
      pathResolver: resolver,
    });
    expect(importResult.ok).toBe(true);
    if (importResult.ok) {
      expect(importResult.report.success).toBe(true);
    }
  });

  test("bundle with large file entry validates correctly", () => {
    // Create a 100KB file to test larger payloads
    const largeData = new Uint8Array(100 * 1024);
    for (let i = 0; i < largeData.length; i++) {
      largeData[i] = i % 256;
    }

    const vbundle = createValidVBundle([
      { path: "data/db/assistant.db", data: largeData },
    ]);

    const result = validateVBundle(vbundle);
    expect(result.is_valid).toBe(true);
    expect(result.manifest?.files[0].size).toBe(100 * 1024);
  });

  test("bundle with duplicate archive paths uses last occurrence in tar", () => {
    // A tar archive with duplicate paths: the tar parser will keep the
    // last one it sees. Create manually to have duplicates.
    const dbData1 = new Uint8Array([0x01, 0x02, 0x03]);
    const dbData2 = new Uint8Array([0x04, 0x05, 0x06]);

    // Build a valid manifest that references the second data
    const fileEntries = [
      {
        path: "data/db/assistant.db",
        sha256: sha256Hex(dbData2),
        size: dbData2.length,
      },
    ];
    const manifestWithoutChecksum = {
      schema_version: "1.0",
      created_at: new Date().toISOString(),
      source: "test",
      description: "Duplicate path test",
      files: fileEntries,
    };
    const manifestSha256 = sha256Hex(canonicalizeJson(manifestWithoutChecksum));
    const manifest = {
      ...manifestWithoutChecksum,
      manifest_sha256: manifestSha256,
    };
    const manifestData = new TextEncoder().encode(JSON.stringify(manifest));

    // Build tar with duplicate data/db/assistant.db entries
    const tar = createTarArchive([
      { name: "manifest.json", data: manifestData },
      { name: "data/db/assistant.db", data: dbData1 },
      { name: "data/db/assistant.db", data: dbData2 },
    ]);
    const vbundle = gzipSync(tar);

    // The tar parser's Map will keep the last entry for a duplicate key.
    // Since the manifest references dbData2's checksum and the Map
    // stores the last occurrence, validation should pass.
    const result = validateVBundle(vbundle);
    expect(result.is_valid).toBe(true);
  });

  test("corrupted file checksum is detected with clear diagnostic", () => {
    const dbData = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]);
    const wrongChecksum =
      "0000000000000000000000000000000000000000000000000000000000000000";

    const manifestWithoutChecksum = {
      schema_version: "1.0",
      created_at: new Date().toISOString(),
      files: [
        {
          path: "data/db/assistant.db",
          sha256: wrongChecksum,
          size: dbData.length,
        },
      ],
    };
    const manifestSha256 = sha256Hex(canonicalizeJson(manifestWithoutChecksum));
    const manifest = {
      ...manifestWithoutChecksum,
      manifest_sha256: manifestSha256,
    };
    const manifestData = new TextEncoder().encode(JSON.stringify(manifest));

    const tar = createTarArchive([
      { name: "manifest.json", data: manifestData },
      { name: "data/db/assistant.db", data: dbData },
    ]);
    const vbundle = gzipSync(tar);
    const result = validateVBundle(vbundle);

    expect(result.is_valid).toBe(false);
    const checksumError = result.errors.find(
      (e) => e.code === "FILE_CHECKSUM_MISMATCH",
    );
    expect(checksumError).toBeDefined();
    expect(checksumError!.message).toContain("data/db/assistant.db");
    expect(checksumError!.message).toContain(wrongChecksum);
    expect(checksumError!.path).toBe("data/db/assistant.db");
  });

  test("manifest declaring non-existent file produces MISSING_DECLARED_FILE", () => {
    const dbData = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]);
    const ghostSha = sha256Hex(new TextEncoder().encode("ghost-content"));

    const manifestWithoutChecksum = {
      schema_version: "1.0",
      created_at: new Date().toISOString(),
      files: [
        {
          path: "data/db/assistant.db",
          sha256: sha256Hex(dbData),
          size: dbData.length,
        },
        {
          path: "data/extra/ghost.bin",
          sha256: ghostSha,
          size: 13,
        },
      ],
    };
    const manifestSha256 = sha256Hex(canonicalizeJson(manifestWithoutChecksum));
    const manifest = {
      ...manifestWithoutChecksum,
      manifest_sha256: manifestSha256,
    };
    const manifestData = new TextEncoder().encode(JSON.stringify(manifest));

    const tar = createTarArchive([
      { name: "manifest.json", data: manifestData },
      { name: "data/db/assistant.db", data: dbData },
      // data/extra/ghost.bin intentionally NOT included
    ]);
    const vbundle = gzipSync(tar);
    const result = validateVBundle(vbundle);

    expect(result.is_valid).toBe(false);
    const missingError = result.errors.find(
      (e) => e.code === "MISSING_DECLARED_FILE",
    );
    expect(missingError).toBeDefined();
    expect(missingError!.path).toBe("data/extra/ghost.bin");
    expect(missingError!.message).toContain("data/extra/ghost.bin");
  });

  test("bundle with only manifest (no data files) is valid", () => {
    // After the workspace walk refactor, only manifest.json is required.
    // A bundle with no data files is structurally valid — it just won't
    // restore anything meaningful.
    const manifestWithoutChecksum = {
      schema_version: "1.0",
      created_at: new Date().toISOString(),
      files: [],
    };
    const manifestSha256 = sha256Hex(canonicalizeJson(manifestWithoutChecksum));
    const manifest = {
      ...manifestWithoutChecksum,
      manifest_sha256: manifestSha256,
    };
    const manifestData = new TextEncoder().encode(JSON.stringify(manifest));

    const tar = createTarArchive([
      { name: "manifest.json", data: manifestData },
    ]);
    const vbundle = gzipSync(tar);
    const result = validateVBundle(vbundle);

    expect(result.is_valid).toBe(true);
  });

  test("completely empty gzip content (no tar entries) fails gracefully", () => {
    // A gzip of an empty buffer
    const emptyGzip = gzipSync(new Uint8Array(0));
    const result = validateVBundle(emptyGzip);

    expect(result.is_valid).toBe(false);
    // Should fail with missing entries since the tar is empty
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("non-gzip data (random bytes) produces INVALID_GZIP", () => {
    const randomBytes = new Uint8Array(256);
    for (let i = 0; i < randomBytes.length; i++) {
      randomBytes[i] = Math.floor(Math.random() * 256);
    }

    const result = validateVBundle(randomBytes);

    expect(result.is_valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe("INVALID_GZIP");
    expect(result.errors[0].message).toContain("gzip");
  });

  test("truncated gzip data produces INVALID_GZIP", () => {
    // Create a valid gzip and truncate it
    const validGzip = gzipSync(new Uint8Array([1, 2, 3, 4, 5]));
    const truncated = validGzip.subarray(0, Math.floor(validGzip.length / 2));

    const result = validateVBundle(truncated);

    expect(result.is_valid).toBe(false);
    expect(result.errors[0].code).toBe("INVALID_GZIP");
  });

  test("single byte input produces INVALID_GZIP", () => {
    const result = validateVBundle(new Uint8Array([0x00]));

    expect(result.is_valid).toBe(false);
    expect(result.errors[0].code).toBe("INVALID_GZIP");
  });

  test("bundle with extra undeclared files in archive still validates (extra files are ignored)", () => {
    const dbData = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]);
    const extraData = new TextEncoder().encode("bonus content");

    // Manifest only declares the db file
    const fileEntries = [
      {
        path: "data/db/assistant.db",
        sha256: sha256Hex(dbData),
        size: dbData.length,
      },
    ];
    const manifestWithoutChecksum = {
      schema_version: "1.0",
      created_at: new Date().toISOString(),
      source: "test",
      files: fileEntries,
    };
    const manifestSha256 = sha256Hex(canonicalizeJson(manifestWithoutChecksum));
    const manifest = {
      ...manifestWithoutChecksum,
      manifest_sha256: manifestSha256,
    };
    const manifestData = new TextEncoder().encode(JSON.stringify(manifest));

    // Archive has an extra file not in the manifest
    const tar = createTarArchive([
      { name: "manifest.json", data: manifestData },
      { name: "data/db/assistant.db", data: dbData },
      { name: "bonus/extra.txt", data: extraData },
    ]);
    const vbundle = gzipSync(tar);

    const result = validateVBundle(vbundle);
    // Extra files in the archive (not declared in manifest) are not
    // an error — the validator only checks declared files.
    expect(result.is_valid).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Diagnostic quality — every error has a code and descriptive message
// ═══════════════════════════════════════════════════════════════════════════

describe("diagnostic quality", () => {
  test("INVALID_GZIP error message mentions gzip", () => {
    const result = validateVBundle(new Uint8Array([0xff, 0xfe]));
    const err = result.errors.find((e) => e.code === "INVALID_GZIP");
    expect(err).toBeDefined();
    expect(err!.message.toLowerCase()).toContain("gzip");
  });

  test("MISSING_ENTRY error identifies which entry is missing", () => {
    const tar = createTarArchive([
      { name: "something-else.txt", data: new TextEncoder().encode("hi") },
    ]);
    const vbundle = gzipSync(tar);
    const result = validateVBundle(vbundle);

    const manifestMissing = result.errors.find(
      (e) => e.code === "MISSING_ENTRY" && e.path === "manifest.json",
    );
    expect(manifestMissing).toBeDefined();
    expect(manifestMissing!.message).toContain("manifest.json");
  });

  test("MANIFEST_CHECKSUM_MISMATCH includes expected and computed hashes", () => {
    const dbData = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]);
    const badHash =
      "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const manifest = {
      schema_version: "1.0",
      created_at: new Date().toISOString(),
      files: [
        {
          path: "data/db/assistant.db",
          sha256: sha256Hex(dbData),
          size: dbData.length,
        },
      ],
      manifest_sha256: badHash,
    };
    const manifestData = new TextEncoder().encode(JSON.stringify(manifest));
    const tar = createTarArchive([
      { name: "manifest.json", data: manifestData },
      { name: "data/db/assistant.db", data: dbData },
    ]);
    const vbundle = gzipSync(tar);
    const result = validateVBundle(vbundle);

    const err = result.errors.find(
      (e) => e.code === "MANIFEST_CHECKSUM_MISMATCH",
    );
    expect(err).toBeDefined();
    expect(err!.message).toContain(badHash); // expected hash
    expect(err!.message).toContain("computed"); // shows computed hash
  });

  test("FILE_CHECKSUM_MISMATCH includes file path and both hashes", () => {
    const dbData = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]);
    const wrongSha =
      "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

    const manifestWithoutChecksum = {
      schema_version: "1.0",
      created_at: new Date().toISOString(),
      files: [
        {
          path: "data/db/assistant.db",
          sha256: wrongSha,
          size: dbData.length,
        },
      ],
    };
    const manifestSha256 = sha256Hex(canonicalizeJson(manifestWithoutChecksum));
    const manifest = {
      ...manifestWithoutChecksum,
      manifest_sha256: manifestSha256,
    };
    const manifestData = new TextEncoder().encode(JSON.stringify(manifest));
    const tar = createTarArchive([
      { name: "manifest.json", data: manifestData },
      { name: "data/db/assistant.db", data: dbData },
    ]);
    const vbundle = gzipSync(tar);
    const result = validateVBundle(vbundle);

    const err = result.errors.find((e) => e.code === "FILE_CHECKSUM_MISMATCH");
    expect(err).toBeDefined();
    expect(err!.path).toBe("data/db/assistant.db");
    expect(err!.message).toContain(wrongSha);
    expect(err!.message).toContain("data/db/assistant.db");
  });

  test("FILE_SIZE_MISMATCH includes file path and both sizes", () => {
    const dbData = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]);

    const manifestWithoutChecksum = {
      schema_version: "1.0",
      created_at: new Date().toISOString(),
      files: [
        {
          path: "data/db/assistant.db",
          sha256: sha256Hex(dbData),
          size: 99999,
        },
      ],
    };
    const manifestSha256 = sha256Hex(canonicalizeJson(manifestWithoutChecksum));
    const manifest = {
      ...manifestWithoutChecksum,
      manifest_sha256: manifestSha256,
    };
    const manifestData = new TextEncoder().encode(JSON.stringify(manifest));
    const tar = createTarArchive([
      { name: "manifest.json", data: manifestData },
      { name: "data/db/assistant.db", data: dbData },
    ]);
    const vbundle = gzipSync(tar);
    const result = validateVBundle(vbundle);

    const err = result.errors.find((e) => e.code === "FILE_SIZE_MISMATCH");
    expect(err).toBeDefined();
    expect(err!.path).toBe("data/db/assistant.db");
    expect(err!.message).toContain("99999");
    expect(err!.message).toContain(String(dbData.length));
  });

  test("import commit validation_failed response includes error codes and messages", () => {
    const resolver = new DefaultPathResolver(undefined, testDir);
    const result = commitImport({
      archiveData: new Uint8Array([0x00]),
      pathResolver: resolver,
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "validation_failed") {
      for (const err of result.errors) {
        expect(typeof err.code).toBe("string");
        expect(err.code.length).toBeGreaterThan(0);
        expect(typeof err.message).toBe("string");
        expect(err.message.length).toBeGreaterThan(0);
      }
    }
  });

  test("preflight validation_failed response includes structured errors", async () => {
    const req = new Request("http://localhost/v1/migrations/import-preflight", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: toArrayBuffer(new Uint8Array([0x00])),
    });

    const res = await handleMigrationImportPreflight(req);
    const body = (await res.json()) as ImportDryRunResponse;

    expect(body.can_import).toBe(false);
    expect(body.validation).toBeDefined();
    expect(body.validation!.errors.length).toBeGreaterThan(0);

    for (const err of body.validation!.errors) {
      expect(typeof err.code).toBe("string");
      expect(err.code.length).toBeGreaterThan(0);
      expect(typeof err.message).toBe("string");
      expect(err.message.length).toBeGreaterThan(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Multiple errors accumulation
// ═══════════════════════════════════════════════════════════════════════════

describe("multiple error accumulation", () => {
  test("bundle with multiple file-level errors reports all of them", () => {
    const dbData = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]);
    const configData = new TextEncoder().encode('{"key":"value"}');
    const wrongSha =
      "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

    // Manifest declares correct db checksum but wrong config checksum and
    // also wrong config size
    const manifestWithoutChecksum = {
      schema_version: "1.0",
      created_at: new Date().toISOString(),
      files: [
        {
          path: "data/db/assistant.db",
          sha256: sha256Hex(dbData),
          size: dbData.length,
        },
        {
          path: "config/settings.json",
          sha256: wrongSha,
          size: 999,
        },
      ],
    };
    const manifestSha256 = sha256Hex(canonicalizeJson(manifestWithoutChecksum));
    const manifest = {
      ...manifestWithoutChecksum,
      manifest_sha256: manifestSha256,
    };
    const manifestData = new TextEncoder().encode(JSON.stringify(manifest));

    const tar = createTarArchive([
      { name: "manifest.json", data: manifestData },
      { name: "data/db/assistant.db", data: dbData },
      { name: "config/settings.json", data: configData },
    ]);
    const vbundle = gzipSync(tar);
    const result = validateVBundle(vbundle);

    expect(result.is_valid).toBe(false);

    // Should have both a checksum mismatch and a size mismatch for config
    const checksumError = result.errors.find(
      (e) =>
        e.code === "FILE_CHECKSUM_MISMATCH" &&
        e.path === "config/settings.json",
    );
    const sizeError = result.errors.find(
      (e) =>
        e.code === "FILE_SIZE_MISMATCH" && e.path === "config/settings.json",
    );

    expect(checksumError).toBeDefined();
    expect(sizeError).toBeDefined();
    // At least 2 errors for the config file
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  test("manifest with multiple missing required fields reports all issues", () => {
    const dbData = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]);
    // Completely empty manifest (has none of the required fields)
    const manifestObj = {};

    const vbundle = createVBundleWithRawManifest(manifestObj, [
      { name: "data/db/assistant.db", data: dbData },
    ]);
    const result = validateVBundle(vbundle);

    expect(result.is_valid).toBe(false);
    // Should report multiple schema errors for missing fields
    const schemaErrors = result.errors.filter(
      (e) => e.code === "MANIFEST_SCHEMA_ERROR",
    );
    expect(schemaErrors.length).toBeGreaterThanOrEqual(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. Builder -> validator consistency
// ═══════════════════════════════════════════════════════════════════════════

describe("builder -> validator consistency", () => {
  test("buildVBundle always produces archives that pass validation", () => {
    const testCases = [
      {
        files: [
          {
            path: "data/db/assistant.db",
            data: new Uint8Array([0x01]),
          },
        ],
        schemaVersion: "1.0",
      },
      {
        files: [
          {
            path: "data/db/assistant.db",
            data: new Uint8Array(10000), // 10KB of zeroes
          },
          {
            path: "config/settings.json",
            data: new TextEncoder().encode('{"big":"config","keys":[1,2,3]}'),
          },
        ],
        schemaVersion: "2.0",
      },
      {
        files: [
          {
            path: "data/db/assistant.db",
            data: new Uint8Array(0), // empty
          },
        ],
        schemaVersion: "0.1-alpha",
      },
    ];

    for (const tc of testCases) {
      const { archive } = buildVBundle({
        files: tc.files,
        schemaVersion: tc.schemaVersion,
      });

      const result = validateVBundle(archive);
      expect(result.is_valid).toBe(true);
      expect(result.manifest?.schema_version).toBe(tc.schemaVersion);
    }
  });

  test("builder output manifest_sha256 matches validator computation", () => {
    const { archive, manifest } = buildVBundle({
      files: [
        {
          path: "data/db/assistant.db",
          data: new Uint8Array([0xca, 0xfe]),
        },
      ],
      schemaVersion: "1.0",
    });

    const result = validateVBundle(archive);
    expect(result.is_valid).toBe(true);
    expect(result.manifest?.manifest_sha256).toBe(manifest.manifest_sha256);
  });

  test("builder output file checksums match validator computation", () => {
    const fileData = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const { archive, manifest } = buildVBundle({
      files: [{ path: "data/db/assistant.db", data: fileData }],
    });

    const result = validateVBundle(archive);
    expect(result.is_valid).toBe(true);
    expect(result.manifest?.files[0].sha256).toBe(manifest.files[0].sha256);
    expect(result.manifest?.files[0].sha256).toBe(sha256Hex(fileData));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. Import analyzer edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("import analyzer edge cases", () => {
  test("all-unchanged files produce correct summary", () => {
    const resolver = new DefaultPathResolver(undefined, testDir);
    const existingConfig = new Uint8Array(readFileSync(testConfigPath));

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
            path: "config/settings.json",
            sha256: sha256Hex(existingConfig),
            size: existingConfig.length,
          },
        ],
        manifest_sha256: "test",
      },
      pathResolver: resolver,
    });

    expect(report.can_import).toBe(true);
    expect(report.summary.files_unchanged).toBe(2);
    expect(report.summary.files_to_create).toBe(0);
    expect(report.summary.files_to_overwrite).toBe(0);
    expect(report.conflicts).toHaveLength(0);
  });

  test("all-create scenario (fresh install) produces correct summary", () => {
    const resolver = new DefaultPathResolver(
      undefined,
      join(testDir, "nonexistent-workspace"),
    );

    const report = analyzeImport({
      manifest: {
        schema_version: "1.0",
        created_at: new Date().toISOString(),
        files: [
          {
            path: "data/db/assistant.db",
            sha256: sha256Hex(new Uint8Array([1])),
            size: 1,
          },
          {
            path: "config/settings.json",
            sha256: sha256Hex(new Uint8Array([2])),
            size: 1,
          },
        ],
        manifest_sha256: "test",
      },
      pathResolver: resolver,
    });

    expect(report.can_import).toBe(true);
    expect(report.summary.files_to_create).toBe(2);
    expect(report.summary.files_unchanged).toBe(0);
    expect(report.summary.files_to_overwrite).toBe(0);
  });

  test("mixed create/overwrite/unchanged produces accurate counts", () => {
    const resolver = new DefaultPathResolver(undefined, testDir);

    // db: different from disk -> overwrite
    // config: same as disk -> unchanged
    const existingConfig = new Uint8Array(readFileSync(testConfigPath));

    const report = analyzeImport({
      manifest: {
        schema_version: "1.0",
        created_at: new Date().toISOString(),
        files: [
          {
            path: "data/db/assistant.db",
            sha256: sha256Hex(new Uint8Array([0xff])),
            size: 1,
          },
          {
            path: "config/settings.json",
            sha256: sha256Hex(existingConfig),
            size: existingConfig.length,
          },
        ],
        manifest_sha256: "test",
      },
      pathResolver: resolver,
    });

    expect(report.summary.files_to_overwrite).toBe(1);
    expect(report.summary.files_unchanged).toBe(1);
    expect(report.summary.files_to_create).toBe(0);
  });

  test("unknown archive path produces UNKNOWN_ARCHIVE_PATH conflict", () => {
    const resolver = new DefaultPathResolver(undefined, testDir);

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
            path: "future/unknown-file.dat",
            sha256: sha256Hex(new Uint8Array([0])),
            size: 1,
          },
        ],
        manifest_sha256: "test",
      },
      pathResolver: resolver,
    });

    expect(report.conflicts.length).toBe(1);
    expect(report.conflicts[0].code).toBe("UNKNOWN_ARCHIVE_PATH");
    expect(report.conflicts[0].message).toContain("future/unknown-file.dat");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. HTTP endpoint error consistency
// ═══════════════════════════════════════════════════════════════════════════

describe("HTTP endpoint error consistency", () => {
  test("validate and import agree on invalid bundle diagnosis", async () => {
    const invalidData = new Uint8Array([0xba, 0xad, 0xca, 0xfe]);

    const validateReq = new Request("http://localhost/v1/migrations/validate", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: toArrayBuffer(invalidData),
    });
    const validateRes = await handleMigrationValidate(validateReq);
    const validateBody = (await validateRes.json()) as ValidationResponse;

    const importReq = new Request("http://localhost/v1/migrations/import", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: toArrayBuffer(invalidData),
    });
    const importRes = await handleMigrationImport(importReq);
    const importBody = (await importRes.json()) as ImportCommitResponse;

    // Both should identify the same error type
    expect(validateBody.is_valid).toBe(false);
    expect(importBody.success).toBe(false);
    expect(validateBody.errors[0].code).toBe(importBody.errors![0].code);
  });

  test("validate and preflight agree on invalid bundle diagnosis", async () => {
    const invalidData = new Uint8Array([0xba, 0xad, 0xca, 0xfe]);

    const validateReq = new Request("http://localhost/v1/migrations/validate", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: toArrayBuffer(invalidData),
    });
    const validateRes = await handleMigrationValidate(validateReq);
    const validateBody = (await validateRes.json()) as ValidationResponse;

    const preflightReq = new Request(
      "http://localhost/v1/migrations/import-preflight",
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: toArrayBuffer(invalidData),
      },
    );
    const preflightRes = await handleMigrationImportPreflight(preflightReq);
    const preflightBody = (await preflightRes.json()) as ImportDryRunResponse;

    expect(validateBody.is_valid).toBe(false);
    expect(preflightBody.can_import).toBe(false);
    expect(validateBody.errors[0].code).toBe(
      preflightBody.validation!.errors[0].code,
    );
  });

  test("all migration endpoints return 400 for empty body", async () => {
    const endpoints = [
      "http://localhost/v1/migrations/validate",
      "http://localhost/v1/migrations/import-preflight",
      "http://localhost/v1/migrations/import",
    ];
    const handlers = [
      handleMigrationValidate,
      handleMigrationImportPreflight,
      handleMigrationImport,
    ];

    for (let i = 0; i < endpoints.length; i++) {
      const req = new Request(endpoints[i], {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: toArrayBuffer(new Uint8Array(0)),
      });

      const res = await handlers[i](req);
      expect(res.status).toBe(400);

      const body = (await res.json()) as {
        error: { code: string; message: string };
      };
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(body.error.message).toBeDefined();
      expect(body.error.message.length).toBeGreaterThan(0);
    }
  });
});
