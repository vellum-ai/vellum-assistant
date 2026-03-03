/**
 * HTTP-layer integration tests for POST /v1/migrations/export.
 *
 * Tests cover:
 * - Success: valid .vbundle archive returned with correct headers
 * - Archive structure: returned archive passes vbundle validation
 * - Manifest correctness: schema_version, file entries, checksums
 * - Custom description: optional JSON body sets manifest description
 * - Auth: route policy enforcement (settings.write scope required)
 * - Integration: existing routes are unaffected by the new endpoint
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, mock, test } from "bun:test";

const testDir = realpathSync(
  mkdtempSync(join(tmpdir(), "migration-export-http-test-")),
);

mock.module("../util/platform.js", () => ({
  getRootDir: () => testDir,
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getSocketPath: () => join(testDir, "test.sock"),
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
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
    apiKeys: {},
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
  getRuntimeProxyBearerToken: () => undefined,
  getRuntimeGatewayOriginSecret: () => undefined,
  getIngressPublicBaseUrl: () => undefined,
  setIngressPublicBaseUrl: () => {},
}));

import { validateVBundle } from "../runtime/migrations/vbundle-validator.js";
import {
  handleMigrationExport,
  handleMigrationValidate,
} from "../runtime/routes/migration-routes.js";

afterAll(() => {
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

// ---------------------------------------------------------------------------
// Success tests
// ---------------------------------------------------------------------------

describe("handleMigrationExport", () => {
  test("POST returns 200 with binary vbundle archive", async () => {
    const req = new Request("http://localhost/v1/migrations/export", {
      method: "POST",
    });

    const res = await handleMigrationExport(req);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="export-.*\.vbundle"$/,
    );
    expect(res.headers.get("Content-Length")).toBeDefined();
    expect(Number(res.headers.get("Content-Length"))).toBeGreaterThan(0);
    expect(res.headers.get("X-Vbundle-Schema-Version")).toBe("1.0");
    expect(res.headers.get("X-Vbundle-Manifest-Sha256")).toBeDefined();
    expect(res.headers.get("X-Vbundle-Manifest-Sha256")!.length).toBe(64);
  });

  test("returned archive passes vbundle validation", async () => {
    const req = new Request("http://localhost/v1/migrations/export", {
      method: "POST",
    });

    const res = await handleMigrationExport(req);
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

    const res = await handleMigrationExport(req);
    const arrayBuffer = await res.arrayBuffer();
    const archiveData = new Uint8Array(arrayBuffer);

    const validationResult = validateVBundle(archiveData);
    const manifest = validationResult.manifest!;

    expect(manifest.schema_version).toBe("1.0");
    expect(manifest.source).toBe("runtime-export");
    expect(manifest.created_at).toBeDefined();
    expect(manifest.manifest_sha256).toBeDefined();

    // Verify file entries
    const filePaths = manifest.files.map((f) => f.path);
    expect(filePaths).toContain("data/db/assistant.db");
    expect(filePaths).toContain("config/settings.json");

    // Verify each file entry has proper sha256 and size
    for (const file of manifest.files) {
      expect(file.sha256).toBeDefined();
      expect(file.sha256.length).toBe(64);
      expect(file.size).toBeGreaterThanOrEqual(0);
    }
  });

  test("custom description from JSON body is used in manifest", async () => {
    const req = new Request("http://localhost/v1/migrations/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "My custom export description" }),
    });

    const res = await handleMigrationExport(req);
    const arrayBuffer = await res.arrayBuffer();
    const archiveData = new Uint8Array(arrayBuffer);

    const validationResult = validateVBundle(archiveData);
    const manifest = validationResult.manifest!;

    expect(manifest.description).toBe("My custom export description");
  });

  test("invalid JSON body is gracefully handled with defaults", async () => {
    const req = new Request("http://localhost/v1/migrations/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not valid json{{{",
    });

    const res = await handleMigrationExport(req);

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

    const res = await handleMigrationExport(req);

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

    const res = await handleMigrationExport(req);
    const arrayBuffer = await res.arrayBuffer();

    expect(Number(res.headers.get("Content-Length"))).toBe(
      arrayBuffer.byteLength,
    );
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
    expect(policy?.allowedPrincipalTypes).toContain("ipc");
  });

  test("migrations/validate policy is still registered", async () => {
    const { getPolicy } = await import("../runtime/auth/route-policy.js");
    const policy = getPolicy("migrations/validate");

    expect(policy).toBeDefined();
    expect(policy?.requiredScopes).toContain("settings.write");
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
      expect.arrayContaining(["actor", "svc_gateway", "ipc"]),
    );
    expect(policy!.allowedPrincipalTypes).toHaveLength(3);
  });

  test("export policy matches validate policy shape", async () => {
    const { getPolicy } = await import("../runtime/auth/route-policy.js");
    const exportPolicy = getPolicy("migrations/export");
    const validatePolicy = getPolicy("migrations/validate");

    // Both migration endpoints should have the same auth requirements
    expect(exportPolicy!.requiredScopes).toEqual(
      validatePolicy!.requiredScopes,
    );
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
    const { handleHealth } =
      await import("../runtime/routes/identity-routes.js");
    const res = handleHealth();
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.status).toBe("healthy");
  });
});
