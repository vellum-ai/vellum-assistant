/**
 * Integration tests for POST /v1/migrations/import-from-gcs.
 *
 * The endpoint kicks off an async import job that fetches a .vbundle from
 * a signed GCS URL and streams it through the importer. The handler returns
 * 202 with a `job_id`; the test then polls the in-process
 * `migrationJobs` registry directly (no separate status endpoint yet — PR 4
 * adds that) to assert the job progresses through `pending`/`running` to a
 * terminal `complete` or `failed` state with the expected result / error
 * mapping.
 *
 * Covered cases:
 * - Happy path: 202 → poll → `complete` with `result.report.summary`.
 * - Upstream fetch failure (HTTP 500): job ends `failed` with
 *   `error.code === "fetch_failed"` and `error.upstreamStatus === 500`.
 * - Validation failure (corrupt bundle): job ends `failed` with
 *   `error.code === "validation_failed"`.
 * - Concurrency: second import while the first is in flight → 409 with
 *   `error.code === "import_in_progress"`.
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
// The streaming importer renames the workspace dir itself, so each test
// needs a fresh tmp dir that the importer can swap into place.
// ---------------------------------------------------------------------------

const originalWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;

function freshWorkspaceRoot(): string {
  const parent = realpathSync(
    mkdtempSync(join(tmpdir(), "migration-import-from-gcs-")),
  );
  const workspaceDir = join(parent, "workspace");
  mkdirSync(workspaceDir, { recursive: true });
  return workspaceDir;
}

function setWorkspaceDir(dir: string): void {
  process.env.VELLUM_WORKSPACE_DIR = dir;
}

// ---------------------------------------------------------------------------
// Mocks (mirrors migration-import-from-url.test.ts)
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

import { defaultV1Options } from "../runtime/migrations/__tests__/v1-test-helpers.js";
import {
  type MigrationJob,
  migrationJobs,
} from "../runtime/migrations/job-registry.js";
import { buildVBundle } from "../runtime/migrations/vbundle-builder.js";
import {
  _setUrlImportValidatorOptionsForTests,
  handleMigrationImportFromGcs,
} from "../runtime/routes/migration-routes.js";
import { callHandler } from "./helpers/call-route-handler.js";
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
  // Track every connection so `close()` can forcibly tear them down. Tests
  // that intentionally hang the response body (to simulate an in-flight
  // upstream fetch) would otherwise deadlock `server.close()`, which waits
  // for clients to disconnect on their own.
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
  });
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
      for (const sock of sockets) {
        try {
          sock.destroy();
        } catch {
          /* best effort */
        }
      }
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
    ...defaultV1Options(),
  });
  const bundlePath = join(parent, "fixture-small.vbundle");
  writeFileSync(bundlePath, archive);
  return bundlePath;
}

function makeCorruptBundlePath(parent: string): string {
  // Random bytes — not a gzip stream, not a tar, nothing the importer can
  // parse. Drives `validation_failed` inside `streamCommitImport`.
  const payload = new Uint8Array(4096);
  for (let i = 0; i < payload.length; i += 1) {
    payload[i] = Math.floor(Math.random() * 256);
  }
  const bundlePath = join(parent, "fixture-corrupt.vbundle");
  writeFileSync(bundlePath, payload);
  return bundlePath;
}

// ---------------------------------------------------------------------------
// Poll helpers — the registry is in-process so we peek at `getJob` directly
// until the job leaves the pending/running states.
// ---------------------------------------------------------------------------

async function pollJobUntilDone(
  jobId: string,
  timeoutMs = 30_000,
): Promise<MigrationJob> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const job = migrationJobs.getJob(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} disappeared from the registry`);
    }
    if (job.status === "complete" || job.status === "failed") {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Job ${jobId} did not finish within ${timeoutMs}ms`);
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

interface AcceptedResponse {
  job_id: string;
  status: "pending";
  type: "import";
}

interface ConflictResponse {
  error: { code: "import_in_progress"; message: string };
}

interface BadRequestResponse {
  error: { code: string; message: string };
}

interface InvalidBundleUrlResponse {
  error: { code: "invalid_bundle_url"; message: string };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /v1/migrations/import-from-gcs", () => {
  test("happy path: 202 → job completes with flat result.summary", async () => {
    const bundlePath = makeSmallValidBundlePath(testParent);

    const fixture = await startFixtureServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      createReadStream(bundlePath).pipe(res);
    });

    try {
      const req = new Request(
        "http://localhost/v1/migrations/import-from-gcs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bundle_url: makeFakeSignedUrl(fixture.port) }),
        },
      );

      const res = await callHandler(
        handleMigrationImportFromGcs,
        req,
        undefined,
        202,
      );
      expect(res.status).toBe(202);
      const body = (await res.json()) as AcceptedResponse;
      expect(body.type).toBe("import");
      expect(body.status).toBe("pending");
      expect(typeof body.job_id).toBe("string");
      expect(body.job_id.length).toBeGreaterThan(0);

      const finalJob = await pollJobUntilDone(body.job_id);
      expect(finalJob.status).toBe("complete");

      // The job result must match the wire shape the CLI expects when it
      // casts `terminal.result` to `ImportResponse`: `success` and `summary`
      // live at the top level, NOT under a nested `report` field. Asserting
      // here is what locks in the fix for the async-vs-sync shape drift
      // that was misreporting successful imports as failed.
      const result = finalJob.result as {
        success: boolean;
        summary: {
          total_files: number;
          files_created: number;
        };
      };
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.summary).toBeDefined();
      expect(result.summary.total_files).toBeGreaterThan(0);
      expect(result.summary.files_created).toBeGreaterThan(0);

      // Workspace was swapped into place.
      expect(
        existsSync(join(testWorkspaceRoot, "data", "db", "assistant.db")),
      ).toBe(true);
      expect(existsSync(join(testWorkspaceRoot, "config.json"))).toBe(true);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  test("upstream 500: job ends failed with fetch_failed + upstreamStatus 500", async () => {
    const fixture = await startFixtureServer((_req, res) => {
      res.writeHead(500);
      res.end("oh no");
    });

    try {
      const req = new Request(
        "http://localhost/v1/migrations/import-from-gcs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bundle_url: makeFakeSignedUrl(fixture.port) }),
        },
      );

      const res = await callHandler(
        handleMigrationImportFromGcs,
        req,
        undefined,
        202,
      );
      expect(res.status).toBe(202);
      const body = (await res.json()) as AcceptedResponse;

      const finalJob = await pollJobUntilDone(body.job_id);
      expect(finalJob.status).toBe("failed");
      expect(finalJob.error?.code).toBe("fetch_failed");
      expect(finalJob.error?.upstreamStatus).toBe(500);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  test("corrupt bundle: job ends failed with validation_failed", async () => {
    const bundlePath = makeCorruptBundlePath(testParent);

    const fixture = await startFixtureServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      createReadStream(bundlePath).pipe(res);
    });

    try {
      const req = new Request(
        "http://localhost/v1/migrations/import-from-gcs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bundle_url: makeFakeSignedUrl(fixture.port) }),
        },
      );

      const res = await callHandler(
        handleMigrationImportFromGcs,
        req,
        undefined,
        202,
      );
      expect(res.status).toBe(202);
      const body = (await res.json()) as AcceptedResponse;

      const finalJob = await pollJobUntilDone(body.job_id);
      expect(finalJob.status).toBe("failed");
      // The streaming importer maps a mangled archive to
      // `extraction_failed` (gunzip throws on the random payload before the
      // tar layer even sees it). Parity with the URL-body path: that path
      // returns 500 `{ reason: "extraction_failed" }` for the same input,
      // and `runGcsImport` re-throws it as a `GcsImportError` carrying the
      // same code.
      expect(finalJob.error?.code).toBe("extraction_failed");
    } finally {
      await fixture.close();
    }
  }, 30_000);

  test("second import while first is in flight returns 409", async () => {
    // A fixture that never responds keeps the first job stuck in `pending`
    // (the runner is scheduled on a microtask, but the handler's `fetch`
    // hangs on the open socket). Even `pending` counts as in-flight for
    // the concurrency check, so the 409 is deterministic regardless of
    // event-loop timing.
    const fixture = await startFixtureServer((_req, _res) => {
      // Intentionally no response — hold the socket open.
    });

    let firstJobId: string | undefined;
    try {
      const firstReq = new Request(
        "http://localhost/v1/migrations/import-from-gcs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bundle_url: makeFakeSignedUrl(fixture.port) }),
        },
      );
      const firstRes = await callHandler(
        handleMigrationImportFromGcs,
        firstReq,
        undefined,
        202,
      );
      expect(firstRes.status).toBe(202);
      const firstBody = (await firstRes.json()) as AcceptedResponse;
      firstJobId = firstBody.job_id;

      const secondReq = new Request(
        "http://localhost/v1/migrations/import-from-gcs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bundle_url: makeFakeSignedUrl(fixture.port) }),
        },
      );
      const secondRes = await callHandler(
        handleMigrationImportFromGcs,
        secondReq,
        undefined,
        202,
      );
      expect(secondRes.status).toBe(409);
      const secondBody = (await secondRes.json()) as ConflictResponse;
      expect(secondBody.error.code).toBe("import_in_progress");
      expect(secondBody.error.message).toContain(firstBody.job_id);
    } finally {
      // Close the server — this destroys every tracked socket, which
      // unblocks the first job's `fetch` and lets the runner settle into
      // `failed`. Wait for that before returning so subsequent tests can
      // start their own `"import"` job without tripping the registry's
      // single-in-flight invariant.
      await fixture.close();
      if (firstJobId !== undefined) {
        await pollJobUntilDone(firstJobId);
      }
    }
  }, 30_000);

  test("invalid bundle_url (disallowed host) returns 400 without consuming the in-flight slot", async () => {
    // Disallowed host — syntactically a valid URL (passes zod), but
    // `validateGcsSignedUrl` must reject it synchronously so the single
    // in-flight import slot is NOT taken. Without the preflight, this
    // would return 202 + job_id and then only fail inside the async
    // runner, blocking a correct retry until the doomed job cleared.
    const badReq = new Request(
      "http://localhost/v1/migrations/import-from-gcs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bundle_url: "http://evil.example.com/bundle?X-Goog-Signature=fake",
        }),
      },
    );
    const badRes = await callHandler(
      handleMigrationImportFromGcs,
      badReq,
      undefined,
      202,
    );
    expect(badRes.status).toBe(400);
    const badBody = (await badRes.json()) as InvalidBundleUrlResponse;
    expect(badBody.error.code).toBe("invalid_bundle_url");
    expect(typeof badBody.error.message).toBe("string");
    expect(badBody.error.message.length).toBeGreaterThan(0);

    // A follow-up valid request must still be able to start a job — proving
    // the doomed request did not occupy the concurrency slot.
    const bundlePath = makeSmallValidBundlePath(testParent);
    const fixture = await startFixtureServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      createReadStream(bundlePath).pipe(res);
    });
    try {
      const goodReq = new Request(
        "http://localhost/v1/migrations/import-from-gcs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bundle_url: makeFakeSignedUrl(fixture.port) }),
        },
      );
      const goodRes = await callHandler(
        handleMigrationImportFromGcs,
        goodReq,
        undefined,
        202,
      );
      expect(goodRes.status).toBe(202);
      const goodBody = (await goodRes.json()) as AcceptedResponse;
      expect(goodBody.type).toBe("import");

      // Drain the job so subsequent tests start from a clean registry.
      await pollJobUntilDone(goodBody.job_id);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  test("malformed body (missing bundle_url) returns 400", async () => {
    const req = new Request("http://localhost/v1/migrations/import-from-gcs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await callHandler(
      handleMigrationImportFromGcs,
      req,
      undefined,
      202,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as BadRequestResponse;
    expect(body.error.code).toBe("BAD_REQUEST");
  });
});
