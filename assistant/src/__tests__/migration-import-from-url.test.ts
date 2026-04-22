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
 *
 * Memory-ceiling coverage lives at the streaming-importer layer — see
 * `vbundle-streaming-importer.test.ts` ("streamCommitImport — memory
 * ceiling"). The URL handler adds only fixed HTTP/framing overhead on top
 * of that pipeline, not bundle-size-proportional allocation.
 *
 * The raw-bytes ingress path is exercised by a separate test file,
 * `migration-import-commit-http.test.ts`.
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
import { Database } from "bun:sqlite";
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

import { resetDb } from "../memory/db-connection.js";
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
// Gap A regression: no-swap success path must not append a stale
// "newer migration" warning sourced from the live DB. The warning would
// wrongly attribute live-DB state to the imported bundle when no bundle
// files actually land on disk (e.g. credentials-only bundle).
// ---------------------------------------------------------------------------

describe("handleMigrationImport — no-swap path omits newer-migration warning", () => {
  test("credentials-only bundle does not inherit live-DB migration warnings", async () => {
    // Seed the live workspace DB with a migration_* checkpoint that's NOT
    // in the registry. validateMigrationState treats this as a "newer
    // version" and would otherwise push a warning into the report. With
    // the gate in appendNewerMigrationWarningsIfAny the warning must be
    // suppressed when the import didn't modify the workspace.
    const dbDir = join(testWorkspaceRoot, "data", "db");
    mkdirSync(dbDir, { recursive: true });
    const dbPath = join(dbDir, "assistant.db");
    const seed = new Database(dbPath);
    try {
      seed.exec(`
        CREATE TABLE memory_checkpoints (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      seed
        .query(
          `INSERT INTO memory_checkpoints (key, value, updated_at) VALUES (?, ?, ?)`,
        )
        .run("migration_from_the_future", "1", Date.now());
    } finally {
      seed.close();
    }

    // Drop any cached Drizzle singleton so getDb() re-opens from the
    // seeded path above when the handler calls it post-import.
    resetDb();

    // All-`vellum:*` credentials bundle: the streaming importer returns
    // ok=true with zero files_created/overwritten (no-swap success),
    // and the credential-import callback filters every entry as a
    // platform credential so CES is never invoked.
    const { archive } = buildVBundle({
      files: [
        {
          path: "credentials/vellum:device-id",
          data: new TextEncoder().encode("test-device-id"),
        },
      ],
    });
    const bundlePath = join(testParent, "fixture-creds-only.vbundle");
    writeFileSync(bundlePath, archive);

    const fixture = await startFixtureServer((_req, res) => {
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
      // Zero files touched — this is the no-swap success path.
      expect(body.summary.files_created).toBe(0);
      expect(body.summary.files_overwritten).toBe(0);

      // The gate must suppress the newer-migration warning text. The
      // helper's wording starts with "Imported data contains" and ends
      // with "migration(s) from a newer version" — matching either
      // substring is sufficient.
      const stale = body.warnings.filter((w) =>
        w.includes("from a newer version"),
      );
      expect(stale).toEqual([]);
    } finally {
      await fixture.close();
      // Close the cached DB handle before the workspace dir gets rm'd
      // in afterEach so we don't leak WAL/SHM files across tests.
      resetDb();
    }
  });
});

// ---------------------------------------------------------------------------
// Gap B regression: an upstream body that drops mid-stream (peer reset,
// socket.destroy() after headers are sent) must surface as 502
// fetch_failed, not 500 extraction_failed. The tag-at-source plumbing in
// the URL handler routes importer-rethrown upstream errors to the fetch-
// failed branch.
// ---------------------------------------------------------------------------

describe("handleMigrationImport — upstream body dropped mid-stream", () => {
  test("socket destroy mid-body returns 502 with reason: fetch_failed", async () => {
    // Build a real gzipped tar prefix, then serve only the first N bytes
    // and tear down the connection. gunzip inside streamCommitImport
    // will surface this as a stream error; we tag it at the source so
    // the handler maps it to 502 fetch_failed. Use random payload bytes
    // so the gzip output is ~incompressible — a compressed all-zeros
    // payload shrinks to <500 bytes total, which doesn't give us enough
    // material to reliably deliver a partial body with gunzip state
    // still alive across the socket teardown.
    const incompressible = new Uint8Array(64 * 1024);
    for (let i = 0; i < incompressible.length; i += 1) {
      incompressible[i] = Math.floor(Math.random() * 256);
    }
    const { archive } = buildVBundle({
      files: [
        {
          path: "workspace/data/db/assistant.db",
          data: incompressible,
        },
      ],
    });
    // Safety net: if someone changes buildVBundle to return very small
    // outputs, drop the test early rather than flaking on a too-short
    // truncation window. 512 bytes is plenty given 64 KB of random data
    // gzips to essentially its original size.
    expect(archive.byteLength).toBeGreaterThan(512);

    // Truncate to the first 256 bytes so upstream cannot deliver a
    // usable tar stream. gunzip will error on the abrupt close.
    const truncatedPrefix = archive.slice(0, 256);

    const fixture = await startFixtureServer((_req, res) => {
      // Chunked transfer (no Content-Length) + socket.destroy() mid-body
      // is the cleanest way to force Bun's fetch to surface a
      // post-headers stream error rather than an initial-fetch throw.
      // We write the prefix in a couple of chunks so the client side can
      // return from fetch() and hand the body stream to the importer
      // before we tear the socket down.
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Transfer-Encoding": "chunked",
      });
      const half = Math.floor(truncatedPrefix.byteLength / 2);
      res.write(truncatedPrefix.slice(0, half), () => {
        // Give the runtime a chance to deliver the first chunk to the
        // consumer and enter the streaming import pipeline, then rip
        // the socket out so the body stream surfaces an abort error.
        setTimeout(() => {
          res.socket?.destroy();
        }, 100);
      });
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
    } finally {
      await fixture.close();
    }
  }, 15_000);
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
