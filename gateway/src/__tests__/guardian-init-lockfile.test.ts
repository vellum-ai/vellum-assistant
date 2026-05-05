import { describe, test, expect, mock, afterEach, beforeEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { GatewayConfig } from "../config.js";
import { initSigningKey } from "../auth/token-service.js";
import { initGatewayDb, resetGatewayDb } from "../db/connection.js";

const TEST_SIGNING_KEY = Buffer.from("test-signing-key-at-least-32-bytes-long");
initSigningKey(TEST_SIGNING_KEY);

// fetchMock retained for proxyToRuntime calls (verification, etc.)
type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
let fetchMock: ReturnType<typeof mock<FetchFn>> = mock(
  async () => new Response(),
);

mock.module("../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

// Mock the IPC proxy so guardian-bootstrap reads/writes the local test DB
let testAssistantDb: Database | null = null;

mock.module("../db/assistant-db-proxy.js", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async assistantDbQuery(sql: string, bind?: any[]) {
    if (!testAssistantDb) throw new Error("test assistant DB not initialized");
    const stmt = testAssistantDb.prepare(sql);
    return bind ? stmt.all(...bind) : stmt.all();
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async assistantDbRun(sql: string, bind?: any[]) {
    if (!testAssistantDb) throw new Error("test assistant DB not initialized");
    const stmt = testAssistantDb.prepare(sql);
    const result = bind ? stmt.run(...bind) : stmt.run();
    return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
  },
  async assistantDbExec(sql: string) {
    if (!testAssistantDb) throw new Error("test assistant DB not initialized");
    testAssistantDb.exec(sql);
  },
}));

const { createChannelVerificationSessionProxyHandler } =
  await import("../http/routes/channel-verification-session-proxy.js");

// ---------------------------------------------------------------------------
// Test directory setup
// ---------------------------------------------------------------------------

let testRoot: string;
let securityDir: string;

/** Lock-file and consumed-file paths under the test security dir. */
function lockPath(): string {
  return join(securityDir, "guardian-init.lock");
}
function consumedPath(): string {
  return join(securityDir, "guardian-init-consumed.json");
}

async function setupTestDirs(): Promise<void> {
  testRoot = mkdtempSync(join(tmpdir(), "guardian-bootstrap-test-"));
  securityDir = join(testRoot, "protected");
  mkdirSync(securityDir, { recursive: true });

  const dbDir = join(testRoot, "data", "db");
  mkdirSync(dbDir, { recursive: true });

  const db = new Database(join(dbDir, "assistant.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      notes TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'contact',
      principal_id TEXT,
      user_file TEXT,
      contact_type TEXT NOT NULL DEFAULT 'human'
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS contact_channels (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      address TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0,
      external_user_id TEXT,
      external_chat_id TEXT,
      status TEXT NOT NULL DEFAULT 'unverified',
      policy TEXT NOT NULL DEFAULT 'allow',
      verified_at INTEGER,
      verified_via TEXT,
      invite_id TEXT,
      revoked_reason TEXT,
      blocked_reason TEXT,
      last_seen_at INTEGER,
      interaction_count INTEGER NOT NULL DEFAULT 0,
      last_interaction INTEGER,
      updated_at INTEGER,
      created_at INTEGER NOT NULL
    )
  `);

  // Keep the DB open for the IPC proxy mock
  testAssistantDb = db;

  // Point gateway at temp dirs
  process.env.VELLUM_WORKSPACE_DIR = testRoot;
  process.env.GATEWAY_SECURITY_DIR = securityDir;

  // Initialize gateway DB so token operations can write to it
  await initGatewayDb();
}

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    routingEntries: [],
    defaultAssistantId: undefined,
    unmappedPolicy: "reject",
    port: 7830,
    runtimeProxyRequireAuth: true,
    shutdownDrainMs: 5000,
    runtimeTimeoutMs: 30000,
    runtimeMaxRetries: 2,
    runtimeInitialBackoffMs: 500,
    maxWebhookPayloadBytes: 1048576,
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: {
      telegram: 50 * 1024 * 1024,
      slack: 100 * 1024 * 1024,
      whatsapp: 16 * 1024 * 1024,
      default: 50 * 1024 * 1024,
    },
    maxAttachmentConcurrency: 3,
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    trustProxy: false,
    ...overrides,
  };
}

beforeEach(async () => {
  await setupTestDirs();
});

afterEach(() => {
  resetGatewayDb();
  fetchMock = mock(async () => new Response());
  delete process.env.GUARDIAN_BOOTSTRAP_SECRET;
  if (testAssistantDb) {
    try { testAssistantDb.close(); } catch { /* best effort */ }
    testAssistantDb = null;
  }
  try {
    rmSync(testRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lockFileExists(): boolean {
  return existsSync(lockPath());
}

function consumedSecrets(): number[] {
  try {
    return JSON.parse(readFileSync(consumedPath(), "utf-8")) as number[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("guardian/init bootstrap secret", () => {
  test("rejects requests without secret when GUARDIAN_BOOTSTRAP_SECRET is set", async () => {
    process.env.GUARDIAN_BOOTSTRAP_SECRET = "test-secret-abc123";
    const handler = createChannelVerificationSessionProxyHandler(makeConfig());
    const res = await handler.handleGuardianInit(
      new Request("http://localhost:7830/v1/guardian/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: "cli", deviceId: "test-device" }),
      }),
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Invalid bootstrap secret");
  });

  test("rejects requests with wrong secret", async () => {
    process.env.GUARDIAN_BOOTSTRAP_SECRET = "test-secret-abc123";
    const handler = createChannelVerificationSessionProxyHandler(makeConfig());
    const res = await handler.handleGuardianInit(
      new Request("http://localhost:7830/v1/guardian/init", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-bootstrap-secret": "wrong-secret",
        },
        body: JSON.stringify({ platform: "cli", deviceId: "test-device" }),
      }),
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Invalid bootstrap secret");
  });

  test("accepts requests with correct secret and writes lock for single secret", async () => {
    process.env.GUARDIAN_BOOTSTRAP_SECRET = "test-secret-abc123";
    const handler = createChannelVerificationSessionProxyHandler(makeConfig());
    const res = await handler.handleGuardianInit(
      new Request("http://localhost:7830/v1/guardian/init", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-bootstrap-secret": "test-secret-abc123",
        },
        body: JSON.stringify({ platform: "cli", deviceId: "test-device" }),
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.guardianPrincipalId).toMatch(/^vellum-principal-/);
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
    expect(body.isNew).toBe(true);
    // Single secret: consumed file written and lock file created immediately
    expect(consumedSecrets()).toContain(0);
    expect(lockFileExists()).toBe(true);
  });

  test("skips secret check when GUARDIAN_BOOTSTRAP_SECRET is not set", async () => {
    delete process.env.GUARDIAN_BOOTSTRAP_SECRET;
    const handler = createChannelVerificationSessionProxyHandler(makeConfig());
    const res = await handler.handleGuardianInit(
      new Request("http://localhost:7830/v1/guardian/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: "cli", deviceId: "test-device" }),
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accessToken).toBeTruthy();
  });
});

describe("guardian/init one-time-use lockfile", () => {
  test("first call succeeds and creates lock file", async () => {
    const handler = createChannelVerificationSessionProxyHandler(makeConfig());
    const res = await handler.handleGuardianInit(
      new Request("http://localhost:7830/v1/guardian/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: "cli", deviceId: "test-device" }),
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.guardianPrincipalId).toMatch(/^vellum-principal-/);
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
    expect(lockFileExists()).toBe(true);
  });

  test("second call is rejected by lockfile", async () => {
    const handler = createChannelVerificationSessionProxyHandler(makeConfig());

    // First call succeeds
    const res1 = await handler.handleGuardianInit(
      new Request("http://localhost:7830/v1/guardian/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: "cli", deviceId: "test-device" }),
      }),
    );
    expect(res1.status).toBe(200);

    // Second call rejected by lockfile
    const res2 = await handler.handleGuardianInit(
      new Request("http://localhost:7830/v1/guardian/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: "cli", deviceId: "test-device" }),
      }),
    );
    expect(res2.status).toBe(403);
    const body = await res2.json();
    expect(body.error).toBe("Bootstrap already completed");
  });

  test("concurrent requests are rejected by in-memory guard", async () => {
    const handler = createChannelVerificationSessionProxyHandler(makeConfig());

    const makeReq = () =>
      new Request("http://localhost:7830/v1/guardian/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: "cli", deviceId: "test-device" }),
      });

    // Fire two requests concurrently
    const p1 = handler.handleGuardianInit(makeReq());
    const p2 = handler.handleGuardianInit(makeReq());

    // Second request should be rejected immediately by in-memory guard
    const res2 = await p2;
    expect(res2.status).toBe(403);

    const res1 = await p1;
    expect(res1.status).toBe(200);

    // Lock file should be written exactly once
    expect(lockFileExists()).toBe(true);
  });

  test("bootstrap creates contact and token records in the DB", async () => {
    const handler = createChannelVerificationSessionProxyHandler(makeConfig());
    const res = await handler.handleGuardianInit(
      new Request("http://localhost:7830/v1/guardian/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: "cli", deviceId: "my-device" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    // Verify contact records were written to the assistant DB
    const assistantDb = new Database(
      join(testRoot, "data", "db", "assistant.db"),
      {
        readonly: true,
      },
    );

    const contact = assistantDb
      .query<
        { role: string; principal_id: string },
        []
      >("SELECT role, principal_id FROM contacts WHERE role = 'guardian'")
      .get();
    expect(contact).toBeTruthy();
    expect(contact!.principal_id).toBe(body.guardianPrincipalId);

    const channel = assistantDb
      .query<
        { type: string; status: string },
        []
      >("SELECT type, status FROM contact_channels WHERE type = 'vellum'")
      .get();
    expect(channel).toBeTruthy();
    expect(channel!.status).toBe("active");

    assistantDb.close();

    // Verify token records were written to the gateway DB
    const gwDb = new Database(join(securityDir, "gateway.sqlite"), {
      readonly: true,
    });

    const tokenCount = gwDb
      .query<
        { cnt: number },
        []
      >("SELECT COUNT(*) as cnt FROM actor_token_records WHERE status = 'active'")
      .get();
    expect(tokenCount!.cnt).toBe(1);

    const refreshCount = gwDb
      .query<
        { cnt: number },
        []
      >("SELECT COUNT(*) as cnt FROM actor_refresh_token_records WHERE status = 'active'")
      .get();
    expect(refreshCount!.cnt).toBe(1);

    gwDb.close();
  });
});

describe("guardian/init multi-secret consumption tracking", () => {
  const SECRET_A = "secret-laptop-aaa";
  const SECRET_B = "secret-remote-bbb";

  function makeInitRequest(secret?: string): Request {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (secret) {
      headers["x-bootstrap-secret"] = secret;
    }
    return new Request("http://localhost:7830/v1/guardian/init", {
      method: "POST",
      headers,
      body: JSON.stringify({
        platform: "cli",
        deviceId: `device-${secret ?? "none"}`,
      }),
    });
  }

  test("first secret is consumed but lock is deferred until all secrets used", async () => {
    process.env.GUARDIAN_BOOTSTRAP_SECRET = `${SECRET_A},${SECRET_B}`;
    const handler = createChannelVerificationSessionProxyHandler(makeConfig());
    const res = await handler.handleGuardianInit(makeInitRequest(SECRET_A));

    expect(res.status).toBe(200);
    expect(consumedSecrets()).toEqual([0]);
    expect(lockFileExists()).toBe(false);
  });

  test("lock file written after all secrets consumed", async () => {
    process.env.GUARDIAN_BOOTSTRAP_SECRET = `${SECRET_A},${SECRET_B}`;
    const handler = createChannelVerificationSessionProxyHandler(makeConfig());

    const res1 = await handler.handleGuardianInit(makeInitRequest(SECRET_A));
    expect(res1.status).toBe(200);
    expect(lockFileExists()).toBe(false);

    const res2 = await handler.handleGuardianInit(makeInitRequest(SECRET_B));
    expect(res2.status).toBe(200);
    expect(lockFileExists()).toBe(true);
  });

  test("reusing a consumed secret is rejected", async () => {
    process.env.GUARDIAN_BOOTSTRAP_SECRET = `${SECRET_A},${SECRET_B}`;
    const handler = createChannelVerificationSessionProxyHandler(makeConfig());

    const res1 = await handler.handleGuardianInit(makeInitRequest(SECRET_A));
    expect(res1.status).toBe(200);

    const res2 = await handler.handleGuardianInit(makeInitRequest(SECRET_A));
    expect(res2.status).toBe(403);
    const body = await res2.json();
    expect(body.error).toBe("Bootstrap secret already used");
  });

  test("all secrets rejected after full consumption and lock", async () => {
    process.env.GUARDIAN_BOOTSTRAP_SECRET = `${SECRET_A},${SECRET_B}`;
    const handler = createChannelVerificationSessionProxyHandler(makeConfig());

    await handler.handleGuardianInit(makeInitRequest(SECRET_A));
    await handler.handleGuardianInit(makeInitRequest(SECRET_B));
    expect(lockFileExists()).toBe(true);

    const res = await handler.handleGuardianInit(makeInitRequest(SECRET_A));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("already");
  });

  test("concurrent requests with same secret rejected by in-flight guard", async () => {
    process.env.GUARDIAN_BOOTSTRAP_SECRET = `${SECRET_A},${SECRET_B}`;
    const handler = createChannelVerificationSessionProxyHandler(makeConfig());

    const p1 = handler.handleGuardianInit(makeInitRequest(SECRET_A));
    const res2 = await handler.handleGuardianInit(makeInitRequest(SECRET_A));

    expect(res2.status).toBe(403);
    const body = await res2.json();
    expect(body.error).toBe("Bootstrap secret already used");

    const res1 = await p1;
    expect(res1.status).toBe(200);
  });
});

describe("guardian/reset-bootstrap", () => {
  test("removes lock file and allows re-init on bare-metal", async () => {
    // Pre-create a lock file
    writeFileSync(lockPath(), new Date().toISOString(), { mode: 0o600 });
    expect(lockFileExists()).toBe(true);

    const handler = createChannelVerificationSessionProxyHandler(makeConfig());
    const res = await handler.handleResetBootstrap("127.0.0.1");
    expect(res.status).toBe(200);
    expect(lockFileExists()).toBe(false);
  });

  test("succeeds idempotently when lock file does not exist", async () => {
    expect(lockFileExists()).toBe(false);
    const handler = createChannelVerificationSessionProxyHandler(makeConfig());

    const res = await handler.handleResetBootstrap("127.0.0.1");
    expect(res.status).toBe(200);
  });

  test("rejects non-loopback clients", async () => {
    const handler = createChannelVerificationSessionProxyHandler(makeConfig());

    const res = await handler.handleResetBootstrap("192.168.1.100");
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Loopback-only endpoint");
  });

  test("rejects in Docker mode (bootstrap secret set)", async () => {
    process.env.GUARDIAN_BOOTSTRAP_SECRET = "some-secret";
    const handler = createChannelVerificationSessionProxyHandler(makeConfig());

    const res = await handler.handleResetBootstrap("127.0.0.1");
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Reset not available in containerized mode");
  });

  test("resets in-flight flag so init can proceed", async () => {
    const handler = createChannelVerificationSessionProxyHandler(makeConfig());

    // First init succeeds and writes lock
    const res1 = await handler.handleGuardianInit(
      new Request("http://localhost:7830/v1/guardian/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: "cli", deviceId: "d" }),
      }),
      "127.0.0.1",
    );
    expect(res1.status).toBe(200);
    expect(lockFileExists()).toBe(true);

    // Second init is rejected
    const blocked = await handler.handleGuardianInit(
      new Request("http://localhost:7830/v1/guardian/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: "cli", deviceId: "d2" }),
      }),
      "127.0.0.1",
    );
    expect(blocked.status).toBe(403);

    // Reset clears the lock
    const resetRes = await handler.handleResetBootstrap("127.0.0.1");
    expect(resetRes.status).toBe(200);
    expect(lockFileExists()).toBe(false);

    // Third init succeeds again
    const res3 = await handler.handleGuardianInit(
      new Request("http://localhost:7830/v1/guardian/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: "cli", deviceId: "d3" }),
      }),
      "127.0.0.1",
    );
    expect(res3.status).toBe(200);
  });
});

describe("guardian/init bare-metal loopback gating", () => {
  test("rejects non-loopback clients in bare-metal mode", async () => {
    delete process.env.GUARDIAN_BOOTSTRAP_SECRET;
    delete process.env.IS_PLATFORM;
    const handler = createChannelVerificationSessionProxyHandler(makeConfig());
    const res = await handler.handleGuardianInit(
      new Request("http://localhost:7830/v1/guardian/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: "cli", deviceId: "test-device" }),
      }),
      "192.168.1.100",
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Bootstrap endpoint is local-only");
  });

  test("allows loopback clients in bare-metal mode", async () => {
    delete process.env.GUARDIAN_BOOTSTRAP_SECRET;
    delete process.env.IS_PLATFORM;
    const handler = createChannelVerificationSessionProxyHandler(makeConfig());
    const res = await handler.handleGuardianInit(
      new Request("http://localhost:7830/v1/guardian/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: "cli", deviceId: "test-device" }),
      }),
      "127.0.0.1",
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accessToken).toBeTruthy();
  });

  test("skips loopback check in Docker mode (secret-based)", async () => {
    process.env.GUARDIAN_BOOTSTRAP_SECRET = "docker-secret-123";
    const handler = createChannelVerificationSessionProxyHandler(makeConfig());
    const res = await handler.handleGuardianInit(
      new Request("http://localhost:7830/v1/guardian/init", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-bootstrap-secret": "docker-secret-123",
        },
        body: JSON.stringify({ platform: "cli", deviceId: "test-device" }),
      }),
      "10.0.2.15",
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accessToken).toBeTruthy();
  });

  test("skips loopback check in platform-managed mode (IS_PLATFORM=true)", async () => {
    delete process.env.GUARDIAN_BOOTSTRAP_SECRET;
    process.env.IS_PLATFORM = "true";
    try {
      const handler = createChannelVerificationSessionProxyHandler(makeConfig());
      const res = await handler.handleGuardianInit(
        new Request("http://localhost:7830/v1/guardian/init", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ platform: "web", deviceId: "platform-abc123" }),
        }),
        "::ffff:10.112.1.68",
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.accessToken).toBeTruthy();
    } finally {
      delete process.env.IS_PLATFORM;
    }
  });
});

describe("guardian/init request validation", () => {
  test("rejects missing platform", async () => {
    const handler = createChannelVerificationSessionProxyHandler(makeConfig());
    const res = await handler.handleGuardianInit(
      new Request("http://localhost:7830/v1/guardian/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: "test-device" }),
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Missing required fields");
  });

  test("rejects invalid platform", async () => {
    const handler = createChannelVerificationSessionProxyHandler(makeConfig());
    const res = await handler.handleGuardianInit(
      new Request("http://localhost:7830/v1/guardian/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: "ios", deviceId: "test-device" }),
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid platform");
  });

  test("rejects invalid JSON body", async () => {
    const handler = createChannelVerificationSessionProxyHandler(makeConfig());
    const res = await handler.handleGuardianInit(
      new Request("http://localhost:7830/v1/guardian/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid JSON body");
  });
});
