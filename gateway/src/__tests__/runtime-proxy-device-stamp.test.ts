/**
 * Device last-used stamping on the paths a paired browser's traffic actually
 * takes.
 *
 * `POST /v1/messages` is not in the gateway route table, so it never reaches
 * the `auth: "edge"` middleware: it falls through to the runtime-proxy
 * catch-all, or to the IPC fast path when the client sends
 * `X-Vellum-Proxy-Server: ipc`. Both validate the edge JWT inline and stamp on
 * their own, so both need their own coverage.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";

import { CURRENT_POLICY_EPOCH } from "../auth/policy.js";
import { initSigningKey, mintToken } from "../auth/token-service.js";
import type { ScopeProfile } from "../auth/types.js";
import type { GatewayConfig } from "../config.js";

initSigningKey(Buffer.from("test-signing-key-at-least-32-bytes-long-xx"));

// --- Upstream daemon stubs (registered before the modules under test) ------

function okJson(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

let upstreamFetch: ReturnType<typeof mock<FetchFn>> = mock(async () =>
  okJson(),
);

mock.module("../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => upstreamFetch(...args),
}));

/** Matches `POST /v1/messages` so the IPC path can serve the chat route. */
const ROUTE_SCHEMA = [
  {
    operationId: "messages_create",
    endpoint: "messages",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ["actor"],
    },
  },
];

type IpcCallFn = (
  method: string,
  params?: Record<string, unknown>,
) => Promise<unknown>;

const defaultIpcImpl: IpcCallFn = async (method) => {
  if (method === "get_route_schema") {
    return ROUTE_SCHEMA;
  }
  return { ok: true };
};

let ipcCall: ReturnType<typeof mock<IpcCallFn>> = mock(defaultIpcImpl);

// Spread the actual module so IpcHandlerError / IpcTransportError and the
// other exports stay importable by the proxy under test.
const actualAssistantClient = await import("../ipc/assistant-client.js");
mock.module("../ipc/assistant-client.js", () => ({
  ...actualAssistantClient,
  ipcCallAssistant: (...args: Parameters<IpcCallFn>) => ipcCall(...args),
}));

// --- Modules under test ---------------------------------------------------

const { initGatewayDb, resetGatewayDb, getGatewayDb } =
  await import("../db/connection.js");
const { actorTokenRecords } = await import("../db/schema.js");
const { actorTokenRecordHash, __resetLastUsedDebounceForTests } =
  await import("../auth/actor-token-revocation.js");
const { refreshRouteSchema } = await import("../ipc/route-schema-cache.js");
const { createRuntimeProxyHandler } =
  await import("../http/routes/runtime-proxy.js");

await refreshRouteSchema();

// --- Helpers --------------------------------------------------------------

const GUARDIAN_ID = "guardian-001";
const ACTOR_SUB = `actor:self:${GUARDIAN_ID}`;
const DEVICE_LABEL = "device-browser";
const CLIENT_IP = "203.0.113.5";

let testRoot: string;
let savedSecurityDir: string | undefined;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function mintEdge(
  sub: string,
  ttlSeconds = 3600,
  scopeProfile: ScopeProfile = "actor_client_v1",
): string {
  return mintToken({
    aud: "vellum-gateway",
    sub,
    scope_profile: scopeProfile,
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds,
  });
}

function insertTokenRecord(
  rawToken: string,
  status: "active" | "revoked" | "derived",
  deviceLabel = DEVICE_LABEL,
): void {
  const now = Date.now();
  getGatewayDb()
    .insert(actorTokenRecords)
    .values({
      id: `id-${status}-${sha256(rawToken).slice(0, 12)}`,
      tokenHash: actorTokenRecordHash(rawToken),
      guardianPrincipalId: GUARDIAN_ID,
      hashedDeviceId: sha256(deviceLabel),
      platform: "web",
      status,
      issuedAt: now,
      expiresAt: now + 86_400_000,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function readRow(rawToken: string) {
  return getGatewayDb()
    .select({
      lastUsedAt: actorTokenRecords.lastUsedAt,
      updatedAt: actorTokenRecords.updatedAt,
    })
    .from(actorTokenRecords)
    .where(eq(actorTokenRecords.tokenHash, actorTokenRecordHash(rawToken)))
    .get();
}

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    routingEntries: [],
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

function messageRequest(token?: string, opts: { ipc?: boolean } = {}): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  if (opts.ipc) {
    headers["x-vellum-proxy-server"] = "ipc";
  }
  return new Request("http://127.0.0.1:7830/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify({ content: "hi" }),
  });
}

beforeEach(async () => {
  savedSecurityDir = process.env.GATEWAY_SECURITY_DIR;
  testRoot = mkdtempSync(join(tmpdir(), "device-stamp-test-"));
  const securityDir = join(testRoot, "protected");
  mkdirSync(securityDir, { recursive: true });
  process.env.GATEWAY_SECURITY_DIR = securityDir;
  await initGatewayDb();
  __resetLastUsedDebounceForTests();
  upstreamFetch = mock(async () => okJson());
  ipcCall = mock(defaultIpcImpl);
});

afterEach(() => {
  resetGatewayDb();
  if (savedSecurityDir === undefined) {
    delete process.env.GATEWAY_SECURITY_DIR;
  } else {
    process.env.GATEWAY_SECURITY_DIR = savedSecurityDir;
  }
  try {
    rmSync(testRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ---------------------------------------------------------------------------
// HTTP runtime proxy
// ---------------------------------------------------------------------------

describe("runtime proxy (HTTP) device stamping", () => {
  test("stamps the presenting device's active row", async () => {
    const jwt = mintEdge(ACTOR_SUB);
    insertTokenRecord(jwt, "active");
    const before = Date.now();

    const handler = createRuntimeProxyHandler(makeConfig());
    const res = await handler(messageRequest(jwt), CLIENT_IP);

    expect(res.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    const row = readRow(jwt);
    expect(row?.lastUsedAt).toBeGreaterThanOrEqual(before);
  });

  test("a derived token stamps the device's active row, not its own", async () => {
    const activeJwt = mintEdge(ACTOR_SUB, 3600);
    const derivedJwt = mintEdge(ACTOR_SUB, 1800);
    insertTokenRecord(activeJwt, "active");
    insertTokenRecord(derivedJwt, "derived");
    const before = Date.now();

    const handler = createRuntimeProxyHandler(makeConfig());
    const res = await handler(messageRequest(derivedJwt), CLIENT_IP);

    expect(res.status).toBe(200);
    expect(readRow(activeJwt)?.lastUsedAt).toBeGreaterThanOrEqual(before);
    expect(readRow(derivedJwt)?.lastUsedAt).toBeNull();
  });

  test("leaves updatedAt alone so the row's lifecycle signal survives", async () => {
    const jwt = mintEdge(ACTOR_SUB);
    insertTokenRecord(jwt, "active");
    const seeded = Date.now() - 60_000;
    getGatewayDb()
      .update(actorTokenRecords)
      .set({ updatedAt: seeded })
      .where(eq(actorTokenRecords.tokenHash, actorTokenRecordHash(jwt)))
      .run();

    const handler = createRuntimeProxyHandler(makeConfig());
    await handler(messageRequest(jwt), CLIENT_IP);

    const row = readRow(jwt);
    expect(row?.lastUsedAt).toBeGreaterThan(seeded);
    expect(row?.updatedAt).toBe(seeded);
  });

  test("a revoked token is rejected and stamps nothing", async () => {
    // A re-paired device: the old token is revoked, a fresh active row shares
    // its hashed device id. Rejecting must not touch either row.
    const revokedJwt = mintEdge(ACTOR_SUB, 3600);
    const activeJwt = mintEdge(ACTOR_SUB, 1800);
    insertTokenRecord(revokedJwt, "revoked");
    insertTokenRecord(activeJwt, "active");

    const handler = createRuntimeProxyHandler(makeConfig());
    const res = await handler(messageRequest(revokedJwt), CLIENT_IP);

    expect(res.status).toBe(401);
    expect(upstreamFetch).not.toHaveBeenCalled();
    expect(readRow(revokedJwt)?.lastUsedAt).toBeNull();
    expect(readRow(activeJwt)?.lastUsedAt).toBeNull();
  });

  test("an expired token is rejected and stamps nothing", async () => {
    const expiredJwt = mintEdge(ACTOR_SUB, -60);
    insertTokenRecord(expiredJwt, "active");

    const handler = createRuntimeProxyHandler(makeConfig());
    const res = await handler(messageRequest(expiredJwt), CLIENT_IP);

    expect(res.status).toBe(401);
    expect(upstreamFetch).not.toHaveBeenCalled();
    expect(readRow(expiredJwt)?.lastUsedAt).toBeNull();
  });

  test("a service token stamps nothing", async () => {
    const svcJwt = mintEdge("svc:gateway:self", 3600, "gateway_service_v1");
    insertTokenRecord(svcJwt, "active");

    const handler = createRuntimeProxyHandler(makeConfig());
    const res = await handler(messageRequest(svcJwt), CLIENT_IP);

    expect(res.status).toBe(200);
    expect(readRow(svcJwt)?.lastUsedAt).toBeNull();
  });

  test("stamps nothing when client auth is disabled", async () => {
    const jwt = mintEdge(ACTOR_SUB);
    insertTokenRecord(jwt, "active");

    const handler = createRuntimeProxyHandler(
      makeConfig({ runtimeProxyRequireAuth: false }),
    );
    const res = await handler(messageRequest(jwt), CLIENT_IP);

    expect(res.status).toBe(200);
    expect(readRow(jwt)?.lastUsedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// IPC fast path
// ---------------------------------------------------------------------------

describe("runtime proxy (IPC) device stamping", () => {
  test("stamps the presenting device's active row", async () => {
    const jwt = mintEdge(ACTOR_SUB);
    insertTokenRecord(jwt, "active");
    const before = Date.now();

    const handler = createRuntimeProxyHandler(makeConfig());
    const res = await handler(messageRequest(jwt, { ipc: true }), CLIENT_IP);

    expect(res.status).toBe(200);
    expect(ipcCall).toHaveBeenCalledTimes(1);
    expect(upstreamFetch).not.toHaveBeenCalled();
    expect(readRow(jwt)?.lastUsedAt).toBeGreaterThanOrEqual(before);
  });

  test("a revoked token is rejected and stamps nothing", async () => {
    const revokedJwt = mintEdge(ACTOR_SUB, 3600);
    const activeJwt = mintEdge(ACTOR_SUB, 1800);
    insertTokenRecord(revokedJwt, "revoked");
    insertTokenRecord(activeJwt, "active");

    const handler = createRuntimeProxyHandler(makeConfig());
    const res = await handler(
      messageRequest(revokedJwt, { ipc: true }),
      CLIENT_IP,
    );

    expect(res.status).toBe(401);
    expect(ipcCall).not.toHaveBeenCalled();
    expect(upstreamFetch).not.toHaveBeenCalled();
    expect(readRow(revokedJwt)?.lastUsedAt).toBeNull();
    expect(readRow(activeJwt)?.lastUsedAt).toBeNull();
  });
});
