/**
 * Integration tests for POST /v1/migrations/export-to-gcs.
 *
 * Covered:
 * - Happy path: the handler returns 202 + job_id, the background job
 *   PUTs a valid .vbundle to the fixture server, and the final job
 *   record carries a matching result payload.
 * - Concurrency: a second export-to-gcs while the first is still
 *   pending/running returns 409 `export_in_progress`.
 * - Upload failure: when the PUT server responds 500, the job ends
 *   `failed` with `error.code === "upload_failed"` and
 *   `upstreamStatus: 500`.
 * - Invalid URL: non-https, wrong host, and path-traversal URLs are
 *   rejected at the handler (400) with the validator's reason code
 *   in `error.reason`.
 *
 * The .vbundle bytes observed by the fixture server are cross-checked
 * against `validateVBundle` to prove the upload body matches what
 * `streamExportVBundle()` would produce.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

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
  invalidateConfigCache: () => {},
}));

// Force the credential collector onto the unreachable branch so the
// handler treats it as "export without credentials" (fast, no CES).
mock.module("../security/secure-keys.js", () => ({
  listSecureKeysAsync: async () => ({ accounts: [], unreachable: true }),
  getSecureKeyAsync: async () => undefined,
  getSecureKeyResultAsync: async () => ({
    value: undefined,
    unreachable: true,
  }),
  bulkSetSecureKeysAsync: async () => [],
}));

// ---------------------------------------------------------------------------
// Imports (after mocks so module-level code picks up the stubs)
// ---------------------------------------------------------------------------

import { migrationJobs } from "../runtime/migrations/job-registry.js";
import { validateVBundle } from "../runtime/migrations/vbundle-validator.js";
import {
  _setUrlImportValidatorOptionsForTests,
  handleMigrationExportToGcs,
} from "../runtime/routes/migration-routes.js";

// ---------------------------------------------------------------------------
// Fixture workspace: write a minimal SQLite file + config so the exporter
// has real data to walk.
// ---------------------------------------------------------------------------

const SQLITE_HEADER = new Uint8Array([
  0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74,
  0x20, 0x33, 0x00,
]);
const TEST_CONFIG = { provider: "anthropic", model: "test-model" };

beforeAll(() => {
  mkdirSync(testDbDir, { recursive: true });
  writeFileSync(testDbPath, SQLITE_HEADER);
  writeFileSync(testConfigPath, JSON.stringify(TEST_CONFIG, null, 2));

  // Widen the URL validator allowlist so the handler accepts a URL
  // pointing at the local fixture server.
  _setUrlImportValidatorOptionsForTests({
    allowedHosts: ["127.0.0.1", "storage.googleapis.com"],
  });
});

afterAll(() => {
  _setUrlImportValidatorOptionsForTests(undefined);
});

// Drop stale job records between tests so concurrency assertions are
// deterministic (a `failed` job from a previous test must not collide
// with the next test's `startJob("export", …)` call — the registry only
// rejects while the prior job is still pending/running, but evicting the
// entry defensively keeps log output clean too).
afterEach(async () => {
  // Wait a tick so any in-flight runners can finalize their state.
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Force-evict any remaining terminal records by tightening the TTL.
  const savedTtl = migrationJobs.completedJobTtlMs;
  migrationJobs.completedJobTtlMs = 0;
  migrationJobs.sweep();
  migrationJobs.completedJobTtlMs = savedTtl;
});

// ---------------------------------------------------------------------------
// Local http fixture server that captures PUT bodies
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
  return {
    server,
    port: address.port,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function makeFakeSignedUploadUrl(port: number): string {
  // `validateGcsSignedUrl` requires a signature query param; pin a dummy.
  return `http://127.0.0.1:${port}/upload/bundle?X-Goog-Signature=fake`;
}

/** Read the full body of an incoming request into a Buffer. */
function collectBody(
  req: import("node:http").IncomingMessage,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Poll `migrationJobs.getJob(id)` until the job reaches a terminal state. */
async function waitForJobTerminal(
  id: string,
  { timeoutMs = 10_000 }: { timeoutMs?: number } = {},
): Promise<NonNullable<ReturnType<typeof migrationJobs.getJob>>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = migrationJobs.getJob(id);
    if (job && (job.status === "complete" || job.status === "failed")) {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Job ${id} did not reach a terminal state in time`);
}

// ---------------------------------------------------------------------------
// Response shape types
// ---------------------------------------------------------------------------

interface AcceptedResponse {
  job_id: string;
  status: "pending";
  type: "export";
}

interface ErrorEnvelope {
  error: {
    code: string;
    reason?: string;
    job_id?: string;
    message?: string;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleMigrationExportToGcs — happy path", () => {
  test("202 + job completes with a valid .vbundle PUT to the upload URL", async () => {
    let capturedBody: Buffer | undefined;
    let capturedContentType: string | undefined;

    const fixture = await startFixtureServer(async (req, res) => {
      if (req.method !== "PUT") {
        res.writeHead(405);
        res.end();
        return;
      }
      capturedContentType = req.headers["content-type"];
      capturedBody = await collectBody(req);
      res.writeHead(200);
      res.end();
    });

    try {
      const req = new Request("http://localhost/v1/migrations/export-to-gcs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          upload_url: makeFakeSignedUploadUrl(fixture.port),
          description: "happy-path export",
        }),
      });

      const res = await handleMigrationExportToGcs(req);
      expect(res.status).toBe(202);

      const body = (await res.json()) as AcceptedResponse;
      expect(body.status).toBe("pending");
      expect(body.type).toBe("export");
      expect(body.job_id).toBeDefined();
      expect(typeof body.job_id).toBe("string");

      const terminal = await waitForJobTerminal(body.job_id);
      expect(terminal.status).toBe("complete");
      expect(terminal.error).toBeUndefined();

      const result = terminal.result as {
        size: number;
        sha256: string;
        schemaVersion: string;
        credentialsIncluded: number;
      };
      expect(result.size).toBeGreaterThan(0);
      expect(typeof result.sha256).toBe("string");
      expect(result.sha256.length).toBeGreaterThan(0);
      expect(result.schemaVersion).toBeDefined();
      expect(result.credentialsIncluded).toBe(0);

      expect(capturedContentType).toBe("application/octet-stream");
      expect(capturedBody).toBeDefined();
      expect(capturedBody!.byteLength).toBe(result.size);

      // The uploaded body is a real .vbundle — validate it.
      const validation = validateVBundle(new Uint8Array(capturedBody!));
      expect(validation.is_valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
      expect(validation.manifest?.manifest_sha256).toBe(result.sha256);
    } finally {
      await fixture.close();
    }
  }, 15_000);
});

describe("handleMigrationExportToGcs — concurrency", () => {
  test("second export while first is running returns 409 export_in_progress", async () => {
    // First fixture: deliberately slow so the first job stays pending long
    // enough for the second request to collide with it.
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });

    const slow = await startFixtureServer(async (req, res) => {
      if (req.method !== "PUT") {
        res.writeHead(405);
        res.end();
        return;
      }
      // Consume the body but defer the response until the test says so.
      await collectBody(req);
      await released;
      res.writeHead(200);
      res.end();
    });

    // Second fixture: never hit in this test — but we still need a valid
    // URL shape so the handler gets past URL validation on the second
    // call. We point the second request at the same fixture URL; the
    // handler rejects before the URL is fetched.
    try {
      const firstReq = new Request(
        "http://localhost/v1/migrations/export-to-gcs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            upload_url: makeFakeSignedUploadUrl(slow.port),
          }),
        },
      );
      const firstRes = await handleMigrationExportToGcs(firstReq);
      expect(firstRes.status).toBe(202);
      const firstBody = (await firstRes.json()) as AcceptedResponse;

      // Yield to the microtask queue so the first job's runner actually
      // transitions from pending → running before we try to start a
      // second one.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const secondReq = new Request(
        "http://localhost/v1/migrations/export-to-gcs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            upload_url: makeFakeSignedUploadUrl(slow.port),
          }),
        },
      );
      const secondRes = await handleMigrationExportToGcs(secondReq);
      expect(secondRes.status).toBe(409);
      const secondBody = (await secondRes.json()) as ErrorEnvelope;
      expect(secondBody.error.code).toBe("export_in_progress");
      expect(secondBody.error.job_id).toBe(firstBody.job_id);

      // Unblock the first fixture so the first job can finalize and the
      // afterEach cleanup sweeps it out.
      release();
      await waitForJobTerminal(firstBody.job_id);
    } finally {
      release();
      await slow.close();
    }
  }, 20_000);
});

describe("handleMigrationExportToGcs — upload failure", () => {
  test("PUT server responds 500 → job failed with upload_failed + upstreamStatus", async () => {
    const fixture = await startFixtureServer(async (req, res) => {
      // Drain the body so the client side completes its write before we
      // send the 500 response. Without this, fetch may surface the 500 as
      // a transport-level error instead of a non-2xx response.
      await collectBody(req);
      res.writeHead(500);
      res.end("upload rejected");
    });

    try {
      const req = new Request("http://localhost/v1/migrations/export-to-gcs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          upload_url: makeFakeSignedUploadUrl(fixture.port),
        }),
      });

      const res = await handleMigrationExportToGcs(req);
      expect(res.status).toBe(202);
      const body = (await res.json()) as AcceptedResponse;

      const terminal = await waitForJobTerminal(body.job_id);
      expect(terminal.status).toBe("failed");
      expect(terminal.error).toBeDefined();
      expect(terminal.error?.code).toBe("upload_failed");
      expect(terminal.error?.upstreamStatus).toBe(500);
    } finally {
      await fixture.close();
    }
  }, 15_000);
});

describe("handleMigrationExportToGcs — redirect handling", () => {
  test("PUT server responds with a 302 redirect → job failed (no SSRF follow)", async () => {
    // If the upstream "storage.googleapis.com" responded with a 3xx to an
    // attacker-controlled host, default fetch would follow and PUT bytes
    // there. `redirect: "error"` on the fetch must surface the redirect
    // as a transport failure instead — the job must end `failed` rather
    // than `complete`, and no bytes must reach the redirect target.
    let redirectTargetHit = false;
    const redirectTarget = await startFixtureServer(async (_req, res) => {
      redirectTargetHit = true;
      res.writeHead(200);
      res.end();
    });
    const fixture = await startFixtureServer(async (_req, res) => {
      res.writeHead(302, {
        Location: `http://127.0.0.1:${redirectTarget.port}/attacker`,
      });
      res.end();
    });

    try {
      const req = new Request("http://localhost/v1/migrations/export-to-gcs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          upload_url: makeFakeSignedUploadUrl(fixture.port),
        }),
      });

      const res = await handleMigrationExportToGcs(req);
      expect(res.status).toBe(202);
      const body = (await res.json()) as AcceptedResponse;

      const terminal = await waitForJobTerminal(body.job_id);
      expect(terminal.status).toBe("failed");
      expect(redirectTargetHit).toBe(false);
    } finally {
      await fixture.close();
      await redirectTarget.close();
    }
  }, 15_000);
});

describe("handleMigrationExportToGcs — URL validation", () => {
  test("rejects non-https scheme when allowlist is default (400)", async () => {
    // Temporarily reset the validator to production defaults so this
    // assertion exercises the strict scheme check.
    _setUrlImportValidatorOptionsForTests(undefined);
    try {
      const req = new Request("http://localhost/v1/migrations/export-to-gcs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          upload_url: "http://storage.googleapis.com/b/o?X-Goog-Signature=fake",
        }),
      });
      const res = await handleMigrationExportToGcs(req);
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorEnvelope;
      expect(body.error.code).toBe("invalid_upload_url");
      expect(body.error.reason).toBe("scheme");
    } finally {
      _setUrlImportValidatorOptionsForTests({
        allowedHosts: ["127.0.0.1", "storage.googleapis.com"],
      });
    }
  });

  test("rejects wrong host (400)", async () => {
    const req = new Request("http://localhost/v1/migrations/export-to-gcs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        upload_url: "https://evil.example.com/bucket/obj?X-Goog-Signature=fake",
      }),
    });
    const res = await handleMigrationExportToGcs(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.code).toBe("invalid_upload_url");
    expect(body.error.reason).toBe("host");
  });

  test("rejects path traversal (400)", async () => {
    const req = new Request("http://localhost/v1/migrations/export-to-gcs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        upload_url:
          "https://storage.googleapis.com/bucket/..%2Fother?X-Goog-Signature=fake",
      }),
    });
    const res = await handleMigrationExportToGcs(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.code).toBe("invalid_upload_url");
    expect(body.error.reason).toBe("path_traversal");
  });
});
