/**
 * Tests for platform credential filtering during bundle import.
 *
 * Verifies that `handleMigrationImport` filters out `vellum:*` platform-identity
 * credentials before passing them to `bulkSetSecureKeysAsync`, while still
 * importing user credentials normally. The `credentialsImported.skippedPlatform`
 * count in the response is also verified.
 *
 * Module-level mocks replace external dependencies so the handler can be
 * driven directly without a live HTTP server, database, or credential store.
 */

import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  ManifestType,
  VBundleTarEntry,
} from "../../migrations/vbundle-validator.js";

// ---------------------------------------------------------------------------
// Module mocks — must appear before any imports of the module under test
// ---------------------------------------------------------------------------

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../../../config/loader.js", () => ({
  getConfig: () => ({}),
  invalidateConfigCache: () => {},
}));

mock.module("../../../permissions/trust-store.js", () => ({
  clearCache: () => {},
}));

const mockWorkspaceDir = "/tmp/test-workspace";

mock.module("../../../util/platform.js", () => ({
  getWorkspaceDir: () => mockWorkspaceDir,
  getWorkspaceHooksDir: () => join(mockWorkspaceDir, "hooks"),
  getDbPath: () => join(mockWorkspaceDir, "data", "db", "assistant.db"),
}));

mock.module("../../../memory/db-connection.js", () => ({
  getDb: () => ({}),
  resetDb: () => {},
}));

mock.module("../../../memory/migrations/validate-migration-state.js", () => ({
  validateMigrationState: () => ({ unknownCheckpoints: [] }),
}));

// -- bulkSetSecureKeysAsync spy -------------------------------------------
// Records which credentials were passed so tests can assert on the filtering.

let bulkSetCalls: Array<Array<{ account: string; value: string }>> = [];
let bulkSetReturnFn: (
  creds: Array<{ account: string; value: string }>,
) => Array<{ account: string; ok: boolean }> = (creds) =>
  creds.map((c) => ({ account: c.account, ok: true }));

mock.module("../../../security/secure-keys.js", () => ({
  bulkSetSecureKeysAsync: async (
    creds: Array<{ account: string; value: string }>,
  ) => {
    bulkSetCalls.push(creds);
    return bulkSetReturnFn(creds);
  },
  listSecureKeysAsync: async () => ({ accounts: [], unreachable: false }),
  getSecureKeyResultAsync: async () => ({ value: null, unreachable: false }),
}));

// -- vbundle-validator mock -----------------------------------------------
// Returns a canned valid result with credentials embedded in entries.

let mockValidationResult: {
  is_valid: boolean;
  manifest: ManifestType | null;
  entries: Map<string, VBundleTarEntry> | null;
  errors: Array<{ code: string; message: string }>;
} = {
  is_valid: true,
  manifest: null,
  entries: null,
  errors: [],
};

mock.module("../../migrations/vbundle-validator.js", () => ({
  validateVBundle: () => mockValidationResult,
}));

// -- vbundle-importer mock ------------------------------------------------
// commitImport returns success; extractCredentialsFromBundle uses real logic.

const { extractCredentialsFromBundle: realExtract } =
  await import("../../migrations/vbundle-importer.js");

mock.module("../../migrations/vbundle-importer.js", () => ({
  commitImport: () => ({
    ok: true,
    report: {
      success: true,
      summary: {
        total_files: 0,
        files_created: 0,
        files_overwritten: 0,
        files_skipped: 0,
        backups_created: 0,
      },
      files: [],
      manifest: mockValidationResult.manifest,
      warnings: [],
    },
  }),
  extractCredentialsFromBundle: realExtract,
}));

// -- Import the handler under test ----------------------------------------

const { handleMigrationImport } = await import("../migration-routes.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTarEntry(data: string): VBundleTarEntry {
  const encoded = new TextEncoder().encode(data);
  return { name: "", data: encoded, size: encoded.length };
}

function makeManifest(paths: string[]): ManifestType {
  return {
    schema_version: "1.0.0",
    created_at: new Date().toISOString(),
    source: "test",
    manifest_sha256: "test",
    files: paths.map((path) => ({
      path,
      size: 0,
      sha256: "test",
    })),
  } as ManifestType;
}

function buildRequest(): Request {
  // handleMigrationImport reads the body as arrayBuffer; the actual bundle
  // data doesn't matter because validateVBundle is mocked.
  return new Request("http://localhost/v1/migrations/import", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array([1, 2, 3]),
  });
}

function setupValidation(
  credentialPaths: string[],
  credentialValues: Record<string, string>,
) {
  const entries = new Map<string, VBundleTarEntry>();
  for (const path of credentialPaths) {
    const value = credentialValues[path] ?? "test-value";
    entries.set(path, makeTarEntry(value));
  }
  const manifest = makeManifest(credentialPaths);
  mockValidationResult = {
    is_valid: true,
    manifest,
    entries,
    errors: [],
  };
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  bulkSetCalls = [];
  bulkSetReturnFn = (creds) =>
    creds.map((c) => ({ account: c.account, ok: true }));
});

afterEach(() => {
  mockValidationResult = {
    is_valid: true,
    manifest: null,
    entries: null,
    errors: [],
  };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("migration import credential filtering", () => {
  test("vellum:-prefixed credentials are excluded from bulkSetSecureKeysAsync", async () => {
    setupValidation(
      [
        "credentials/vellum:assistant_api_key",
        "credentials/vellum:platform_assistant_id",
        "credentials/vellum:platform_base_url",
        "credentials/vellum:platform_organization_id",
        "credentials/vellum:platform_user_id",
        "credentials/vellum:webhook_secret",
      ],
      {
        "credentials/vellum:assistant_api_key": "key-1",
        "credentials/vellum:platform_assistant_id": "asst-2",
        "credentials/vellum:platform_base_url": "https://example.com",
        "credentials/vellum:platform_organization_id": "org-3",
        "credentials/vellum:platform_user_id": "user-4",
        "credentials/vellum:webhook_secret": "whsec-5",
      },
    );

    const res = await handleMigrationImport(buildRequest());
    const body = (await res.json()) as Record<string, unknown>;

    // No credentials should have been sent to the credential store
    expect(bulkSetCalls).toHaveLength(0);

    // Response should report all were skipped
    const creds = body.credentialsImported as {
      total: number;
      succeeded: number;
      failed: number;
      skippedPlatform: number;
    };
    expect(creds).toBeDefined();
    expect(creds.total).toBe(6);
    expect(creds.succeeded).toBe(0);
    expect(creds.failed).toBe(0);
    expect(creds.skippedPlatform).toBe(6);
  });

  test("user credentials without vellum: prefix are passed through unchanged", async () => {
    setupValidation(["credentials/openai-key", "credentials/anthropic-key"], {
      "credentials/openai-key": "sk-user-123",
      "credentials/anthropic-key": "sk-ant-456",
    });

    const res = await handleMigrationImport(buildRequest());
    const body = (await res.json()) as Record<string, unknown>;

    // All user credentials should be sent to CES
    expect(bulkSetCalls).toHaveLength(1);
    expect(bulkSetCalls[0]).toHaveLength(2);
    expect(bulkSetCalls[0]).toContainEqual({
      account: "openai-key",
      value: "sk-user-123",
    });
    expect(bulkSetCalls[0]).toContainEqual({
      account: "anthropic-key",
      value: "sk-ant-456",
    });

    const creds = body.credentialsImported as {
      total: number;
      succeeded: number;
      skippedPlatform: number;
    };
    expect(creds.total).toBe(2);
    expect(creds.succeeded).toBe(2);
    expect(creds.skippedPlatform).toBe(0);
  });

  test("mixed bundle with both vellum:* and user credentials correctly splits", async () => {
    setupValidation(
      [
        "credentials/vellum:assistant_api_key",
        "credentials/vellum:platform_user_id",
        "credentials/openai-key",
        "credentials/anthropic-key",
        "credentials/github-token",
      ],
      {
        "credentials/vellum:assistant_api_key": "platform-key",
        "credentials/vellum:platform_user_id": "platform-user",
        "credentials/openai-key": "sk-user-123",
        "credentials/anthropic-key": "sk-ant-456",
        "credentials/github-token": "ghp-789",
      },
    );

    const res = await handleMigrationImport(buildRequest());
    const body = (await res.json()) as Record<string, unknown>;

    // Only user credentials should be sent to CES
    expect(bulkSetCalls).toHaveLength(1);
    expect(bulkSetCalls[0]).toHaveLength(3);
    const accounts = bulkSetCalls[0]!.map((c) => c.account).sort();
    expect(accounts).toEqual(["anthropic-key", "github-token", "openai-key"]);

    // No vellum: credentials should appear in the bulk set call
    const vellumCreds = bulkSetCalls[0]!.filter((c) =>
      c.account.startsWith("vellum:"),
    );
    expect(vellumCreds).toHaveLength(0);

    const creds = body.credentialsImported as {
      total: number;
      succeeded: number;
      failed: number;
      skippedPlatform: number;
    };
    expect(creds.total).toBe(5);
    expect(creds.succeeded).toBe(3);
    expect(creds.failed).toBe(0);
    expect(creds.skippedPlatform).toBe(2);
  });

  test("credentialsImported.skippedPlatform count is accurate", async () => {
    setupValidation(
      [
        "credentials/vellum:assistant_api_key",
        "credentials/vellum:platform_base_url",
        "credentials/vellum:webhook_secret",
        "credentials/user-key",
      ],
      {
        "credentials/vellum:assistant_api_key": "v1",
        "credentials/vellum:platform_base_url": "v2",
        "credentials/vellum:webhook_secret": "v3",
        "credentials/user-key": "user-val",
      },
    );

    const res = await handleMigrationImport(buildRequest());
    const body = (await res.json()) as Record<string, unknown>;

    const creds = body.credentialsImported as {
      total: number;
      succeeded: number;
      failed: number;
      failedAccounts: string[];
      skippedPlatform: number;
    };

    expect(creds.skippedPlatform).toBe(3);
    expect(creds.total).toBe(4);
    expect(creds.succeeded).toBe(1);
    expect(creds.failed).toBe(0);
    expect(creds.failedAccounts).toEqual([]);
  });
});
