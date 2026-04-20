/**
 * Integration tests for the JSON `{url}` body on POST /v1/migrations/import.
 *
 * Covered:
 * - Happy path: a local http server serves a valid .vbundle, the handler
 *   fetches it, streams it through `streamCommitImport`, and returns the
 *   same success-report shape the raw-bytes path returns.
 * - GCS 500: upstream server returns 500 → handler returns 502 with
 *   `{ reason: "fetch_failed", upstream_status: 500 }`.
 * - Malformed body: `{}` and `{ "url": "" }` → 400.
 * - Invalid GCS URL: a real https://evil.com URL is rejected with the
 *   redacted `Invalid URL: host` message; the raw URL is not echoed back
 *   in the response body.
 * - Memory ceiling: a 100 MB fixture streams through with peak RSS delta
 *   under ~128 MB (looser than PR 4's 64 MB bound to allow for HTTP +
 *   gunzip + tar-stream overhead on top of the streamCommitImport path).
 *
 * The raw-bytes regression path is exercised by the separate test file
 * `migration-import-commit-http.test.ts`, which this PR must leave
 * untouched.
 */

import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// ---------------------------------------------------------------------------
// Test isolation: per-file workspace root.
//
// The shared test preload points VELLUM_WORKSPACE_DIR at a tmp dir. The
// streaming importer does an atomic rename of the workspace dir itself,
// which implicitly invalidates the shared tmp dir for subsequent tests in
// the same file. Each test below creates its own isolated workspace and
// re-points getWorkspaceDir() at it via the env var before invoking the
// handler.
// ---------------------------------------------------------------------------

const originalWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;

function freshWorkspaceRoot(): string {
  const parent = realpathSync(
    mkdtempSync(join(tmpdir(), "migration-import-from-url-")),
  );
  // The streaming importer renames workspaceDir itself, so put the
  // workspace inside a parent dir we own.
  const workspaceDir = join(parent, "workspace");
  mkdirSync(workspaceDir, { recursive: true });
  return workspaceDir;
}

function setWorkspaceDir(dir: string): void {
  process.env.VELLUM_WORKSPACE_DIR = dir;
}

// ---------------------------------------------------------------------------
// Mocks (mirrors migration-import-commit-http.test.ts)
// ---------------------------------------------------------------------------

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
  invalidateConfigCache: () => {},
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

// ---------------------------------------------------------------------------
// Imports (after mocks so module-level code picks up the stubs)
// ---------------------------------------------------------------------------

import { buildVBundle } from "../runtime/migrations/vbundle-builder.js";
import {
  _setUrlImportValidatorOptionsForTests,
  handleMigrationImport,
} from "../runtime/routes/migration-routes.js";

// ---------------------------------------------------------------------------
// Local http fixture server
// ---------------------------------------------------------------------------

interface FixtureServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

async function startFixtureServer(
  handler: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) => void,
): Promise<FixtureServer> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture server bound to unexpected address");
  }
  const port = address.port;
  return {
    server,
    port,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function makeFakeSignedUrl(port: number): string {
  // `validateGcsSignedUrl` requires a signature query param; pin a dummy.
  return `http://127.0.0.1:${port}/bundle?X-Goog-Signature=fake`;
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeSmallValidBundlePath(parent: string): string {
  const { archive } = buildVBundle({
    files: [
      {
        path: "workspace/data/db/assistant.db",
        data: new TextEncoder().encode("SQLite format 3\0"),
      },
      {
        path: "workspace/config.json",
        data: new TextEncoder().encode(
          JSON.stringify({ provider: "anthropic", model: "test-model" }),
        ),
      },
    ],
  });
  const bundlePath = join(parent, "fixture-small.vbundle");
  writeFileSync(bundlePath, archive);
  return bundlePath;
}

// ---------------------------------------------------------------------------
// Global test-only allowlist: widen the URL validator to accept 127.0.0.1.
// ---------------------------------------------------------------------------

beforeAll(() => {
  _setUrlImportValidatorOptionsForTests({
    allowedHosts: ["127.0.0.1", "storage.googleapis.com"],
  });
});

afterAll(() => {
  _setUrlImportValidatorOptionsForTests(undefined);
  if (originalWorkspaceDir !== undefined) {
    process.env.VELLUM_WORKSPACE_DIR = originalWorkspaceDir;
  }
});

// Each test gets its own workspace dir so the streaming importer's atomic
// swap doesn't leak state across tests.
let testWorkspaceRoot: string;
let testParent: string;

beforeEach(() => {
  testWorkspaceRoot = freshWorkspaceRoot();
  testParent = join(testWorkspaceRoot, "..");
  setWorkspaceDir(testWorkspaceRoot);
});

afterEach(() => {
  try {
    rmSync(testParent, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ---------------------------------------------------------------------------
// Response shape types
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

interface FetchFailedResponse {
  success: false;
  reason: "fetch_failed";
  upstream_status?: number;
}

interface BadRequestResponse {
  error: { code: string; message: string };
}

// ---------------------------------------------------------------------------
// Tests: JSON URL body
// ---------------------------------------------------------------------------

describe("handleMigrationImport — JSON {url} body", () => {
  test("happy path: fetches fixture bundle from local http server and imports", async () => {
    const bundlePath = makeSmallValidBundlePath(testParent);

    const fixture = await startFixtureServer((req, res) => {
      // Prove the server itself streams the response body.
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      createReadStream(bundlePath).pipe(res);
    });

    try {
      const req = new Request("http://localhost/v1/migrations/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: makeFakeSignedUrl(fixture.port) }),
      });

      const res = await handleMigrationImport(req);
      const body = (await res.json()) as ImportCommitResponse;

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.summary).toBeDefined();
      expect(body.summary.total_files).toBeGreaterThan(0);
      expect(body.files.length).toBeGreaterThan(0);
      expect(body.manifest).toBeDefined();

      // Workspace was swapped into place and contains the fixture files.
      expect(
        existsSync(join(testWorkspaceRoot, "data", "db", "assistant.db")),
      ).toBe(true);
      expect(existsSync(join(testWorkspaceRoot, "config.json"))).toBe(true);
    } finally {
      await fixture.close();
    }
  });

  test("upstream 500 returns 502 with reason: fetch_failed", async () => {
    const fixture = await startFixtureServer((_req, res) => {
      res.writeHead(500);
      res.end("oh no");
    });

    try {
      const req = new Request("http://localhost/v1/migrations/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: makeFakeSignedUrl(fixture.port) }),
      });

      const res = await handleMigrationImport(req);
      const body = (await res.json()) as FetchFailedResponse;

      expect(res.status).toBe(502);
      expect(body.success).toBe(false);
      expect(body.reason).toBe("fetch_failed");
      expect(body.upstream_status).toBe(500);
    } finally {
      await fixture.close();
    }
  });

  test('malformed body: {"url": ""} returns 400', async () => {
    const req = new Request("http://localhost/v1/migrations/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "" }),
    });

    const res = await handleMigrationImport(req);
    const body = (await res.json()) as BadRequestResponse;

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  test("missing url key: {} returns 400", async () => {
    const req = new Request("http://localhost/v1/migrations/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    const res = await handleMigrationImport(req);
    const body = (await res.json()) as BadRequestResponse;

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  test("unparseable JSON body returns 400", async () => {
    const req = new Request("http://localhost/v1/migrations/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    });

    const res = await handleMigrationImport(req);
    const body = (await res.json()) as BadRequestResponse;

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  test("invalid GCS URL returns 400 and does not leak the URL", async () => {
    const rawUrl = "https://evil.example.com/bucket/obj?X-Goog-Signature=fake";
    const req = new Request("http://localhost/v1/migrations/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: rawUrl }),
    });

    const res = await handleMigrationImport(req);
    const rawBody = await res.text();

    expect(res.status).toBe(400);

    const parsed = JSON.parse(rawBody) as BadRequestResponse;
    expect(parsed.error.code).toBe("BAD_REQUEST");
    // The message should carry the redacted reason, not the URL itself.
    expect(parsed.error.message.toLowerCase()).toContain("invalid url");
    // Defense-in-depth: the raw URL must not appear anywhere in the response.
    expect(rawBody).not.toContain("evil.example.com");
    expect(rawBody).not.toContain("X-Goog-Signature=fake");
  });

  test("non-https scheme on default allowlist is rejected", async () => {
    // Temporarily reset to the strict default allowlist so this test
    // exercises the production validator configuration.
    _setUrlImportValidatorOptionsForTests(undefined);
    try {
      const req = new Request("http://localhost/v1/migrations/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: "http://storage.googleapis.com/b/o?X-Goog-Signature=x",
        }),
      });

      const res = await handleMigrationImport(req);
      const body = (await res.json()) as BadRequestResponse;

      expect(res.status).toBe(400);
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(body.error.message).toContain("scheme");
    } finally {
      _setUrlImportValidatorOptionsForTests({
        allowedHosts: ["127.0.0.1", "storage.googleapis.com"],
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Memory ceiling — streams a 100 MB fixture through and caps RSS.
// ---------------------------------------------------------------------------

function writeLargeFixtureToDisk(archivePath: string): void {
  const CHUNK = 25 * 1024 * 1024;
  const files = [0, 1, 2, 3].map((i) => ({
    path: `workspace/big-${i}.bin`,
    data: new Uint8Array(CHUNK).fill(0x41 + i),
  }));
  const { archive } = buildVBundle({ files });
  writeFileSync(archivePath, archive);
}

describe("handleMigrationImport — URL body memory ceiling", () => {
  test("100 MB fixture streams in without pushing RSS past ~128 MB over baseline", async () => {
    const archivePath = join(testParent, "fixture-large.vbundle");
    writeLargeFixtureToDisk(archivePath);

    const fixture = await startFixtureServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      createReadStream(archivePath).pipe(res);
    });

    try {
      // Force a GC opportunity before measuring baseline so stale fixture
      // buffers don't count against the importer's budget. Bun exposes
      // `Bun.gc` but not process.gc; gate on whether it exists.
      const maybeBunGc = (
        globalThis as { Bun?: { gc?: (sync?: boolean) => void } }
      ).Bun?.gc;
      if (typeof maybeBunGc === "function") maybeBunGc(true);

      const baselineRss = process.memoryUsage().rss;

      const req = new Request("http://localhost/v1/migrations/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: makeFakeSignedUrl(fixture.port) }),
      });

      const res = await handleMigrationImport(req);
      const body = (await res.json()) as ImportCommitResponse;

      const peakRss = process.memoryUsage().rss;

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);

      // 128 MB is the looser bound documented in the PR 5 plan — adds
      // headroom for HTTP response buffers + gunzip + tar-stream state
      // on top of the per-entry working set the streaming importer uses.
      const delta = peakRss - baselineRss;
      expect(delta).toBeLessThan(128 * 1024 * 1024);
    } finally {
      await fixture.close();
    }
  }, 90_000);
});

// ---------------------------------------------------------------------------
// Regression: raw-bytes path still works through the same handler.
// ---------------------------------------------------------------------------

describe("handleMigrationImport — raw-bytes regression", () => {
  test("application/octet-stream body still imports successfully", async () => {
    const { archive } = buildVBundle({
      files: [
        {
          path: "workspace/data/db/assistant.db",
          data: new TextEncoder().encode("SQLite format 3\0"),
        },
      ],
    });

    const req = new Request("http://localhost/v1/migrations/import", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: archive.buffer.slice(
        archive.byteOffset,
        archive.byteOffset + archive.byteLength,
      ) as ArrayBuffer,
    });

    const res = await handleMigrationImport(req);
    const body = (await res.json()) as ImportCommitResponse;

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.files.length).toBeGreaterThan(0);
  });
});
