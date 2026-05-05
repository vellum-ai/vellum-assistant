/**
 * HTTP-layer integration tests for POST /v1/migrations/validate.
 *
 * Tests cover:
 * - Success: valid .vbundle archive returns is_valid: true with manifest
 * - Validation failures: invalid gzip, missing entries, bad manifest, checksum mismatches
 * - Request errors: empty body, invalid multipart
 * - Auth: route policy enforcement (settings.read scope required)
 * - Integration: existing routes are unaffected by the new endpoint
 */
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, mock, test } from "bun:test";

/** Convert a Uint8Array to an ArrayBuffer for BodyInit compatibility. */
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  // Slice to get an owned ArrayBuffer (not a view into a SharedArrayBuffer)
  return data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength,
  ) as ArrayBuffer;
}

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

import { validateVBundle } from "../runtime/migrations/vbundle-validator.js";
import { BadRequestError } from "../runtime/routes/errors.js";
import { handleMigrationValidate } from "../runtime/routes/migration-routes.js";
import type { RouteHandlerArgs } from "../runtime/routes/types.js";

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
  // Per tar spec, checksum uses spaces (0x20) in the checksum field
  let sum = 0;
  for (let i = 0; i < 512; i++) {
    if (i >= 148 && i < 156) {
      sum += 0x20; // space
    } else {
      sum += header[i];
    }
  }
  return sum;
}

function createTarEntry(name: string, data: Uint8Array): Uint8Array {
  const header = new Uint8Array(BLOCK_SIZE);
  const encoder = new TextEncoder();

  // File name (0-99)
  const nameBytes = encoder.encode(name);
  header.set(nameBytes.subarray(0, 100), 0);

  // File mode (100-107): 0644
  writeOctal(header, 100, 8, 0o644);

  // Owner ID (108-115)
  writeOctal(header, 108, 8, 0);

  // Group ID (116-123)
  writeOctal(header, 116, 8, 0);

  // File size (124-135)
  writeOctal(header, 124, 12, data.length);

  // Modification time (136-147)
  writeOctal(header, 136, 12, Math.floor(Date.now() / 1000));

  // Type flag (156): regular file
  header[156] = "0".charCodeAt(0);

  // USTAR magic (257-262)
  const magic = encoder.encode("ustar\0");
  header.set(magic, 257);

  // USTAR version (263-264)
  header[263] = "0".charCodeAt(0);
  header[264] = "0".charCodeAt(0);

  // Compute and write checksum (148-155)
  const checksum = computeHeaderChecksum(header);
  writeOctal(header, 148, 7, checksum);
  header[155] = 0x20; // trailing space

  // Combine header + data (padded to block boundary) + end-of-archive
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
  // End-of-archive: two zero blocks
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

/** Build a v1-compliant manifest skeleton; tests override specific fields. */
function v1Skeleton() {
  return {
    schema_version: 1,
    bundle_id: "00000000-0000-4000-8000-000000000000",
    created_at: new Date().toISOString(),
    assistant: { id: "self", name: "Test", runtime_version: "0.0.0-test" },
    origin: { mode: "self-hosted-local" as const },
    compatibility: {
      min_runtime_version: "0.0.0-test",
      max_runtime_version: null,
    },
    secrets_redacted: false,
    export_options: {
      include_logs: false,
      include_browser_state: false,
      include_memory_vectors: false,
    },
  };
}

function createValidVBundle(files?: VBundleFile[]): Uint8Array {
  const dbData = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]); // "SQLite"
  const bundleFiles = files ?? [{ path: "data/db/assistant.db", data: dbData }];

  const contents = bundleFiles.map((f) => ({
    path: f.path,
    sha256: sha256Hex(f.data),
    size_bytes: f.data.length,
  }));

  const manifestWithEmptyChecksum = {
    schema_version: 1,
    bundle_id: "00000000-0000-4000-8000-000000000000",
    created_at: new Date().toISOString(),
    assistant: { id: "self", name: "Test", runtime_version: "0.0.0-test" },
    origin: { mode: "self-hosted-local" },
    compatibility: {
      min_runtime_version: "0.0.0-test",
      max_runtime_version: null,
    },
    contents,
    checksum: "",
    secrets_redacted: false,
    export_options: {
      include_logs: false,
      include_browser_state: false,
      include_memory_vectors: false,
    },
  };

  const checksum = sha256Hex(canonicalizeJson(manifestWithEmptyChecksum));
  const manifest = { ...manifestWithEmptyChecksum, checksum };
  const manifestData = new TextEncoder().encode(JSON.stringify(manifest));

  const tarEntries = [
    { name: "manifest.json", data: manifestData },
    ...bundleFiles.map((f) => ({ name: f.path, data: f.data })),
  ];

  const tar = createTarArchive(tarEntries);
  return gzipSync(tar);
}

// ---------------------------------------------------------------------------
// Validator unit tests
// ---------------------------------------------------------------------------

describe("validateVBundle", () => {
  test("valid bundle returns is_valid: true with manifest", () => {
    const vbundle = createValidVBundle();
    const result = validateVBundle(vbundle);

    expect(result.is_valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.manifest).toBeDefined();
    expect(result.manifest?.schema_version).toBe(1);
    expect(result.manifest?.contents).toHaveLength(1);
    expect(result.manifest?.contents[0].path).toBe("data/db/assistant.db");
  });

  test("valid bundle with multiple files", () => {
    const configData = new TextEncoder().encode('{"key": "value"}');
    const dbData = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]);
    const files: VBundleFile[] = [
      { path: "data/db/assistant.db", data: dbData },
      { path: "config/settings.json", data: configData },
    ];
    const vbundle = createValidVBundle(files);
    const result = validateVBundle(vbundle);

    expect(result.is_valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.manifest?.contents).toHaveLength(2);
  });

  test("invalid gzip returns INVALID_GZIP error", () => {
    const result = validateVBundle(new Uint8Array([0x00, 0x01, 0x02]));

    expect(result.is_valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe("INVALID_GZIP");
  });

  test("missing manifest.json returns MISSING_ENTRY error", () => {
    const dbData = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]);
    const tar = createTarArchive([
      { name: "data/db/assistant.db", data: dbData },
    ]);
    const vbundle = gzipSync(tar);
    const result = validateVBundle(vbundle);

    expect(result.is_valid).toBe(false);
    const manifestError = result.errors.find(
      (e) => e.code === "MISSING_ENTRY" && e.path === "manifest.json",
    );
    expect(manifestError).toBeDefined();
  });

  test("bundle with only manifest (no data files) — valid schema rejects empty contents via refine", () => {
    // The v1 schema's `.refine()` requires `data/db/assistant.db` in
    // contents, so a manifest declaring `contents: []` is rejected by
    // the validator. This documents the new behavior: bundles must
    // declare the assistant DB even when no other data files are
    // present.
    const skeleton = {
      ...v1Skeleton(),
      contents: [] as Array<{
        path: string;
        sha256: string;
        size_bytes: number;
      }>,
      checksum: "",
    };
    skeleton.checksum = sha256Hex(canonicalizeJson(skeleton));
    const manifestData = new TextEncoder().encode(JSON.stringify(skeleton));
    const tar = createTarArchive([
      { name: "manifest.json", data: manifestData },
    ]);
    const vbundle = gzipSync(tar);
    const result = validateVBundle(vbundle);

    expect(result.is_valid).toBe(false);
  });

  test("invalid manifest JSON returns INVALID_MANIFEST_JSON error", () => {
    const badJson = new TextEncoder().encode("not valid json{{{");
    const dbData = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]);
    const tar = createTarArchive([
      { name: "manifest.json", data: badJson },
      { name: "data/db/assistant.db", data: dbData },
    ]);
    const vbundle = gzipSync(tar);
    const result = validateVBundle(vbundle);

    expect(result.is_valid).toBe(false);
    expect(result.errors.some((e) => e.code === "INVALID_MANIFEST_JSON")).toBe(
      true,
    );
  });

  test("manifest with missing required fields returns MANIFEST_SCHEMA_ERROR", () => {
    // Missing schema_version, created_at, files, manifest_sha256
    const manifestData = new TextEncoder().encode(
      JSON.stringify({ extra: "field" }),
    );
    const dbData = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]);
    const tar = createTarArchive([
      { name: "manifest.json", data: manifestData },
      { name: "data/db/assistant.db", data: dbData },
    ]);
    const vbundle = gzipSync(tar);
    const result = validateVBundle(vbundle);

    expect(result.is_valid).toBe(false);
    expect(result.errors.some((e) => e.code === "MANIFEST_SCHEMA_ERROR")).toBe(
      true,
    );
  });

  test("manifest checksum mismatch returns MANIFEST_CHECKSUM_MISMATCH", () => {
    const dbData = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]);
    const manifest = {
      ...v1Skeleton(),
      contents: [
        {
          path: "data/db/assistant.db",
          sha256: sha256Hex(dbData),
          size_bytes: dbData.length,
        },
      ],
      // Deliberately wrong checksum (correct shape, wrong value).
      checksum:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };
    const manifestData = new TextEncoder().encode(JSON.stringify(manifest));
    const tar = createTarArchive([
      { name: "manifest.json", data: manifestData },
      { name: "data/db/assistant.db", data: dbData },
    ]);
    const vbundle = gzipSync(tar);
    const result = validateVBundle(vbundle);

    expect(result.is_valid).toBe(false);
    expect(
      result.errors.some((e) => e.code === "MANIFEST_CHECKSUM_MISMATCH"),
    ).toBe(true);
  });

  test("file checksum mismatch returns FILE_CHECKSUM_MISMATCH", () => {
    const dbData = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]);
    const wrongChecksum =
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    const manifest = {
      ...v1Skeleton(),
      contents: [
        {
          path: "data/db/assistant.db",
          sha256: wrongChecksum,
          size_bytes: dbData.length,
        },
      ],
      checksum: "",
    };
    manifest.checksum = sha256Hex(canonicalizeJson(manifest));
    const manifestData = new TextEncoder().encode(JSON.stringify(manifest));

    const tar = createTarArchive([
      { name: "manifest.json", data: manifestData },
      { name: "data/db/assistant.db", data: dbData },
    ]);
    const vbundle = gzipSync(tar);
    const result = validateVBundle(vbundle);

    expect(result.is_valid).toBe(false);
    expect(result.errors.some((e) => e.code === "FILE_CHECKSUM_MISMATCH")).toBe(
      true,
    );
  });

  test("file size mismatch returns FILE_SIZE_MISMATCH", () => {
    const dbData = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]);

    const manifest = {
      ...v1Skeleton(),
      contents: [
        {
          path: "data/db/assistant.db",
          sha256: sha256Hex(dbData),
          size_bytes: 999,
        },
      ],
      checksum: "",
    };
    manifest.checksum = sha256Hex(canonicalizeJson(manifest));
    const manifestData = new TextEncoder().encode(JSON.stringify(manifest));

    const tar = createTarArchive([
      { name: "manifest.json", data: manifestData },
      { name: "data/db/assistant.db", data: dbData },
    ]);
    const vbundle = gzipSync(tar);
    const result = validateVBundle(vbundle);

    expect(result.is_valid).toBe(false);
    expect(result.errors.some((e) => e.code === "FILE_SIZE_MISMATCH")).toBe(
      true,
    );
  });

  test("missing declared file returns MISSING_DECLARED_FILE", () => {
    const dbData = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]);
    const missingFileHash = sha256Hex(new TextEncoder().encode("missing"));

    const manifest = {
      ...v1Skeleton(),
      contents: [
        {
          path: "data/db/assistant.db",
          sha256: sha256Hex(dbData),
          size_bytes: dbData.length,
        },
        {
          path: "config/missing.json",
          sha256: missingFileHash,
          size_bytes: 7,
        },
      ],
      checksum: "",
    };
    manifest.checksum = sha256Hex(canonicalizeJson(manifest));
    const manifestData = new TextEncoder().encode(JSON.stringify(manifest));

    const tar = createTarArchive([
      { name: "manifest.json", data: manifestData },
      { name: "data/db/assistant.db", data: dbData },
    ]);
    const vbundle = gzipSync(tar);
    const result = validateVBundle(vbundle);

    expect(result.is_valid).toBe(false);
    expect(
      result.errors.some(
        (e) =>
          e.code === "MISSING_DECLARED_FILE" &&
          e.path === "config/missing.json",
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// HTTP route handler tests
// ---------------------------------------------------------------------------

/** Build RouteHandlerArgs from multipart FormData by serializing through a temp Request. */
async function multipartArgs(formData: FormData): Promise<RouteHandlerArgs> {
  const tmpReq = new Request("http://localhost", {
    method: "POST",
    body: formData,
  });
  // Read content-type BEFORE consuming the body — Bun clears headers after arrayBuffer().
  const contentType = tmpReq.headers.get("content-type") ?? "";
  const rawBody = new Uint8Array(await tmpReq.arrayBuffer());
  return { rawBody, headers: { "content-type": contentType } };
}

describe("handleMigrationValidate", () => {
  test("POST with valid vbundle returns is_valid: true", async () => {
    const vbundle = createValidVBundle();
    const body = (await handleMigrationValidate({
      rawBody: vbundle,
      headers: { "content-type": "application/octet-stream" },
    })) as Record<string, unknown>;

    expect(body.is_valid).toBe(true);
    expect(body.errors).toEqual([]);
    expect(body.manifest).toBeDefined();
  });

  test("POST with invalid gzip returns is_valid: false", async () => {
    const body = (await handleMigrationValidate({
      rawBody: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      headers: { "content-type": "application/octet-stream" },
    })) as { is_valid: boolean; errors: Array<{ code: string }> };

    expect(body.is_valid).toBe(false);
    expect(body.errors.length).toBeGreaterThan(0);
    expect(body.errors[0].code).toBe("INVALID_GZIP");
  });

  test("POST with empty body throws BadRequestError", async () => {
    await expect(
      handleMigrationValidate({
        rawBody: new Uint8Array(0),
        headers: { "content-type": "application/octet-stream" },
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  test("POST with multipart form data containing valid vbundle", async () => {
    const vbundle = createValidVBundle();
    const formData = new FormData();
    formData.append("file", new Blob([toArrayBuffer(vbundle)]), "test.vbundle");

    const body = (await handleMigrationValidate(
      await multipartArgs(formData),
    )) as Record<string, unknown>;

    expect(body.is_valid).toBe(true);
  });

  test("POST multipart without file field throws BadRequestError", async () => {
    const formData = new FormData();
    formData.append("notfile", "some text");

    await expect(
      handleMigrationValidate(await multipartArgs(formData)),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  test("POST with missing manifest returns validation errors", async () => {
    const dbData = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]);
    const tar = createTarArchive([
      { name: "data/db/assistant.db", data: dbData },
    ]);
    const vbundle = gzipSync(tar);

    const body = (await handleMigrationValidate({
      rawBody: vbundle,
      headers: { "content-type": "application/octet-stream" },
    })) as {
      is_valid: boolean;
      errors: Array<{ code: string; path?: string }>;
    };

    expect(body.is_valid).toBe(false);
    expect(
      body.errors.some(
        (e) => e.code === "MISSING_ENTRY" && e.path === "manifest.json",
      ),
    ).toBe(true);
  });

  test("POST with checksum mismatch returns validation errors", async () => {
    const dbData = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]);
    const manifest = {
      ...v1Skeleton(),
      contents: [
        {
          path: "data/db/assistant.db",
          sha256: sha256Hex(dbData),
          size_bytes: dbData.length,
        },
      ],
      // Deliberately wrong checksum (correct shape, wrong value).
      checksum:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };
    const manifestData = new TextEncoder().encode(JSON.stringify(manifest));
    const tar = createTarArchive([
      { name: "manifest.json", data: manifestData },
      { name: "data/db/assistant.db", data: dbData },
    ]);
    const vbundle = gzipSync(tar);

    const body = (await handleMigrationValidate({
      rawBody: vbundle,
      headers: { "content-type": "application/octet-stream" },
    })) as { is_valid: boolean; errors: Array<{ code: string }> };

    expect(body.is_valid).toBe(false);
    expect(
      body.errors.some((e) => e.code === "MANIFEST_CHECKSUM_MISMATCH"),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Auth policy registration test
// ---------------------------------------------------------------------------

describe("route policy registration", () => {
  test("migrations/validate policy requires settings.read scope", async () => {
    // Import route-policy to verify the registration exists
    const { getPolicy } = await import("../runtime/auth/route-policy.js");
    const policy = getPolicy("migrations/validate");

    expect(policy).toBeDefined();
    expect(policy?.requiredScopes).toContain("settings.read");
    expect(policy?.allowedPrincipalTypes).toContain("actor");
    expect(policy?.allowedPrincipalTypes).toContain("svc_gateway");
    expect(policy?.allowedPrincipalTypes).toContain("local");
  });
});

// ---------------------------------------------------------------------------
// Integration: existing routes unaffected
// ---------------------------------------------------------------------------

describe("integration: existing routes unaffected", () => {
  test("GET /v1/health still works (not intercepted by migration routes)", async () => {
    const { handleDetailedHealth } =
      await import("../runtime/routes/identity-routes.js");
    const res = handleDetailedHealth();
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.status).toBe("healthy");
  });
});
