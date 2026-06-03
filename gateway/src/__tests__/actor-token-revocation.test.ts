/**
 * Tests for the hot-path actor-token revocation check: a revoked actor token
 * is rejected on live requests, with fail-open semantics for non-actor,
 * unrecorded, and DB-error cases.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initSigningKey, mintToken } from "../auth/token-service.js";
import { CURRENT_POLICY_EPOCH } from "../auth/policy.js";
import type { TokenClaims } from "../auth/types.js";

initSigningKey(Buffer.from("test-signing-key-at-least-32-bytes-long-xx"));

const { initGatewayDb, resetGatewayDb, getGatewayDb } =
  await import("../db/connection.js");
const { actorTokenRecords } = await import("../db/schema.js");
const { hashToken } = await import("../auth/guardian-bootstrap.js");
const { isActorTokenRevoked } =
  await import("../auth/actor-token-revocation.js");
const { createRuntimeProxyHandler } =
  await import("../http/routes/runtime-proxy.js");

const ACTOR_SUB = "actor:self:guardian-001";
const actorClaims = { sub: ACTOR_SUB } as TokenClaims;

let testRoot: string;

function insertTokenRecord(rawToken: string, status: "active" | "revoked") {
  const now = Date.now();
  getGatewayDb()
    .insert(actorTokenRecords)
    .values({
      id: `id-${rawToken}`,
      tokenHash: hashToken(rawToken),
      guardianPrincipalId: "guardian-001",
      hashedDeviceId: hashToken("device-A"),
      platform: "web",
      status,
      issuedAt: now,
      expiresAt: now + 86_400_000,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

beforeEach(async () => {
  testRoot = mkdtempSync(join(tmpdir(), "revocation-test-"));
  const securityDir = join(testRoot, "protected");
  mkdirSync(securityDir, { recursive: true });
  process.env.GATEWAY_SECURITY_DIR = securityDir;
  await initGatewayDb();
});

afterEach(() => {
  resetGatewayDb();
  delete process.env.GATEWAY_SECURITY_DIR;
  try {
    rmSync(testRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("isActorTokenRevoked", () => {
  test("returns true for an actor token whose record is revoked", () => {
    insertTokenRecord("token-revoked", "revoked");
    expect(isActorTokenRevoked("token-revoked", actorClaims)).toBe(true);
  });

  test("returns false for an actor token whose record is active", () => {
    insertTokenRecord("token-active", "active");
    expect(isActorTokenRevoked("token-active", actorClaims)).toBe(false);
  });

  test("returns false (fail-open) for an actor token with no record", () => {
    expect(isActorTokenRevoked("token-unknown", actorClaims)).toBe(false);
  });

  test("never checks non-actor tokens (svc)", () => {
    // Even if a row with this hash were revoked, a svc sub must be ignored.
    insertTokenRecord("svc-token", "revoked");
    const svcClaims = { sub: "svc:gateway:self" } as TokenClaims;
    expect(isActorTokenRevoked("svc-token", svcClaims)).toBe(false);
  });

  test("returns false (fail-open) when the gateway DB is unavailable", () => {
    resetGatewayDb();
    expect(isActorTokenRevoked("token-anything", actorClaims)).toBe(false);
  });
});

describe("runtime proxy enforcement", () => {
  function makeConfig() {
    return {
      assistantRuntimeBaseUrl: "http://localhost:7821",
      routingEntries: [],
      defaultAssistantId: undefined,
      unmappedPolicy: "reject" as const,
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
    };
  }

  function mintActorJwt(): string {
    return mintToken({
      aud: "vellum-gateway",
      sub: ACTOR_SUB,
      scope_profile: "actor_client_v1",
      policy_epoch: CURRENT_POLICY_EPOCH,
      ttlSeconds: 3600,
    });
  }

  test("rejects a revoked actor token with 401 on the chat path", async () => {
    const jwt = mintActorJwt();
    insertTokenRecord(jwt, "revoked");

    const handler = createRuntimeProxyHandler(makeConfig());
    const res = await handler(
      new Request("http://127.0.0.1:7830/v1/assistants/self/messages", {
        method: "POST",
        headers: {
          authorization: `Bearer ${jwt}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ content: "hi" }),
      }),
      "127.0.0.1",
    );

    expect(res.status).toBe(401);
  });
});

describe("m0004 token-hash index migration", () => {
  function rawDb() {
    return (
      getGatewayDb() as unknown as { $client: import("bun:sqlite").Database }
    ).$client;
  }
  function indexSql(): string {
    const row = rawDb()
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_actor_tokens_hash'",
      )
      .get() as { sql: string } | null;
    return row?.sql ?? "";
  }

  test("recreates a pre-existing partial index as unfiltered", async () => {
    // Simulate an upgraded gateway: replace the index with the OLD partial form.
    rawDb().exec("DROP INDEX IF EXISTS idx_actor_tokens_hash");
    rawDb().exec(
      "CREATE INDEX idx_actor_tokens_hash ON actor_token_records (token_hash) WHERE status = 'active'",
    );
    expect(indexSql().toLowerCase()).toContain("where");

    const m0004 =
      await import("../db/data-migrations/m0004-actor-token-hash-index-unfiltered.js");
    expect(m0004.up()).toBe("done");

    // The index now exists and no longer filters on status.
    expect(indexSql()).not.toBe("");
    expect(indexSql().toLowerCase()).not.toContain("where");
  });
});
