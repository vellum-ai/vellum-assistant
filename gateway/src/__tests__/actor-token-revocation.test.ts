/**
 * Tests for hot-path actor-token admission: a revoked actor token is rejected
 * on live requests and stamps nothing, an admitted one records its device's
 * activity off the same lookup, with fail-open semantics for non-actor,
 * unrecorded, and DB-error cases.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";

import { initSigningKey, mintToken } from "../auth/token-service.js";
import { CURRENT_POLICY_EPOCH } from "../auth/policy.js";
import type { TokenClaims } from "../auth/types.js";

initSigningKey(Buffer.from("test-signing-key-at-least-32-bytes-long-xx"));

const { initGatewayDb, resetGatewayDb, getGatewayDb } =
  await import("../db/connection.js");
const { actorTokenRecords, contacts } = await import("../db/schema.js");
const { hashToken } = await import("../auth/guardian-bootstrap.js");
const {
  admitActorToken,
  actorTokenRecordHash,
  __resetLastUsedDebounceForTests,
} = await import("../auth/actor-token-revocation.js");
const { createRuntimeProxyHandler } =
  await import("../http/routes/runtime-proxy.js");
const { bustGuardianIntegrityCache } =
  await import("../auth/guardian-integrity.js");
const {
  resetGuardianIntegrityReporterForTesting,
  setGuardianIntegrityReporterOverridesForTesting,
} = await import("../guardian-integrity-reporter.js");

const ACTOR_SUB = "actor:self:guardian-001";
const actorClaims = { sub: ACTOR_SUB } as TokenClaims;

let testRoot: string;
let savedSecurityDir: string | undefined;

function insertTokenRecord(
  rawToken: string,
  status: "active" | "revoked" | "derived",
  deviceLabel = "device-A",
) {
  const now = Date.now();
  getGatewayDb()
    .insert(actorTokenRecords)
    .values({
      id: `id-${rawToken}`,
      tokenHash: hashToken(rawToken),
      guardianPrincipalId: "guardian-001",
      hashedDeviceId: hashToken(deviceLabel),
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
    .where(eq(actorTokenRecords.tokenHash, hashToken(rawToken)))
    .get();
}

/** Records the SQL drizzle prepares while `fn` runs. */
function captureSql(fn: () => void): string[] {
  type PreparingClient = {
    prepare: (sql: string, ...rest: unknown[]) => unknown;
  };
  const client = (getGatewayDb() as unknown as { $client: PreparingClient })
    .$client;
  const original = client.prepare;
  const seen: string[] = [];
  client.prepare = (sql, ...rest) => {
    seen.push(sql);
    return original.call(client, sql, ...rest);
  };
  try {
    fn();
  } finally {
    client.prepare = original;
  }
  return seen;
}

function statementsOn(sql: string[], verb: "select" | "update"): string[] {
  return sql.filter(
    (stmt) =>
      stmt.trim().toLowerCase().startsWith(verb) &&
      stmt.includes("actor_token_records"),
  );
}

function insertGuardianContact() {
  const now = Date.now();
  getGatewayDb()
    .insert(contacts)
    .values({
      id: "contact-guardian",
      displayName: "guardian",
      role: "guardian",
      principalId: "guardian-001",
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

beforeEach(async () => {
  savedSecurityDir = process.env.GATEWAY_SECURITY_DIR;
  testRoot = mkdtempSync(join(tmpdir(), "revocation-test-"));
  const securityDir = join(testRoot, "protected");
  mkdirSync(securityDir, { recursive: true });
  process.env.GATEWAY_SECURITY_DIR = securityDir;
  await initGatewayDb();
  __resetLastUsedDebounceForTests();
  // The integrity state is module-cached across tests; token rows seeded here
  // are integrity evidence, so keep the reporter silenced and the cache cold.
  bustGuardianIntegrityCache();
  resetGuardianIntegrityReporterForTesting();
  setGuardianIntegrityReporterOverridesForTesting({
    fetchImpl: async () => new Response("{}"),
    mintToken: () => "svc-token",
    baseUrl: "http://127.0.0.1:7821",
    log: { error: () => {}, warn: () => {} },
  });
});

afterEach(() => {
  resetGatewayDb();
  resetGuardianIntegrityReporterForTesting();
  bustGuardianIntegrityCache();
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

describe("admitActorToken: revocation verdict", () => {
  test("rejects an actor token whose record is revoked", () => {
    insertTokenRecord("token-revoked", "revoked");
    expect(admitActorToken("token-revoked", actorClaims)).toBe(false);
  });

  test("admits an actor token whose record is active", () => {
    insertTokenRecord("token-active", "active");
    expect(admitActorToken("token-active", actorClaims)).toBe(true);
  });

  test("admits (fail-open) an actor token with no record", () => {
    expect(admitActorToken("token-unknown", actorClaims)).toBe(true);
  });

  test("never checks non-actor tokens (svc)", () => {
    // Even if a row with this hash were revoked, a svc sub must be ignored.
    insertTokenRecord("svc-token", "revoked");
    const svcClaims = { sub: "svc:gateway:self" } as TokenClaims;
    expect(admitActorToken("svc-token", svcClaims)).toBe(true);
  });

  test("admits (fail-open) when the gateway DB is unavailable", () => {
    resetGatewayDb();
    expect(admitActorToken("token-anything", actorClaims)).toBe(true);
  });

  test("still detects revocation when the token has surrounding whitespace", () => {
    // The record is stored under the canonical (trimmed) token hash; a token
    // supplied with trailing whitespace (e.g. a `?token=<jwt>%20` WS param)
    // must still resolve to the revoked record.
    insertTokenRecord("token-revoked", "revoked");
    expect(admitActorToken("token-revoked ", actorClaims)).toBe(false);
    expect(admitActorToken(" token-revoked\n", actorClaims)).toBe(false);
  });

  test("a revoked token is rejected without stamping any row", () => {
    // A re-paired device: the revoked row and a fresh active row share a
    // hashed device id, so a misordered stamp would land on the active one.
    insertTokenRecord("token-stale", "revoked");
    insertTokenRecord("token-fresh", "active");

    expect(admitActorToken("token-stale", actorClaims)).toBe(false);

    expect(readRow("token-stale")?.lastUsedAt).toBeNull();
    expect(readRow("token-fresh")?.lastUsedAt).toBeNull();
  });
});

describe("signature-encoding canonicalization (revocation bypass)", () => {
  function mintActorJwt(): string {
    return mintToken({
      aud: "vellum-gateway",
      sub: ACTOR_SUB,
      scope_profile: "actor_client_v1",
      policy_epoch: CURRENT_POLICY_EPOCH,
      ttlSeconds: 3600,
    });
  }

  // Append base64 padding to the signature segment. Buffer.from(.., "base64url")
  // decodes it to the SAME bytes, so the JWT still verifies — but the raw string
  // differs, which (pre-fix) made the revocation hash miss the stored record.
  function padSignature(jwt: string): string {
    const [h, p, sig] = jwt.split(".");
    return `${h}.${p}.${sig}=`;
  }

  test("detects a revoked token whose signature segment is re-encoded with padding", () => {
    const jwt = mintActorJwt();
    insertTokenRecord(jwt, "revoked"); // stored under the canonical token hash

    // Baseline: the canonical token is detected as revoked.
    expect(admitActorToken(jwt, actorClaims)).toBe(false);

    // Bypass attempt: same token, signature re-encoded (different string, same
    // bytes). Must still resolve to the revoked record.
    const padded = padSignature(jwt);
    expect(padded).not.toBe(jwt);
    expect(admitActorToken(padded, actorClaims)).toBe(false);
  });

  test("does not falsely revoke an active token re-encoded with padding", () => {
    const jwt = mintActorJwt();
    insertTokenRecord(jwt, "active");
    expect(admitActorToken(padSignature(jwt), actorClaims)).toBe(true);
  });
});

describe("runtime proxy enforcement", () => {
  function makeConfig() {
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

describe("/auth/token revocation", () => {
  function makeLoopbackServer() {
    return {
      requestIP: () => ({ address: "127.0.0.1", family: "IPv4", port: 5000 }),
    } as unknown as import("bun").Server<unknown>;
  }

  test("rejects re-minting a token from a revoked source token", async () => {
    const { handleCreateToken } = await import("../http/routes/auth-token.js");
    const jwt = mintToken({
      aud: "vellum-gateway",
      sub: ACTOR_SUB,
      scope_profile: "actor_client_v1",
      policy_epoch: CURRENT_POLICY_EPOCH,
      ttlSeconds: 3600,
    });
    insertTokenRecord(jwt, "revoked");

    const res = await handleCreateToken(
      new Request("http://127.0.0.1:7830/auth/token", {
        method: "POST",
        headers: {
          authorization: `Bearer ${jwt}`,
          origin: "http://localhost:3000",
        },
      }),
      makeLoopbackServer(),
    );

    expect(res.status).toBe(401);
  });

  test("records a derived token so device revocation invalidates it", async () => {
    const { handleCreateToken } = await import("../http/routes/auth-token.js");
    const { revokeActorTokensByDevice } =
      await import("../auth/guardian-bootstrap.js");
    const sourceJwt = mintToken({
      aud: "vellum-gateway",
      sub: ACTOR_SUB,
      scope_profile: "actor_client_v1",
      policy_epoch: CURRENT_POLICY_EPOCH,
      ttlSeconds: 3600,
    });
    insertTokenRecord(sourceJwt, "active");
    insertGuardianContact();

    const res = await handleCreateToken(
      new Request("http://127.0.0.1:7830/auth/token", {
        method: "POST",
        headers: {
          authorization: `Bearer ${sourceJwt}`,
          origin: "http://localhost:3000",
        },
      }),
      makeLoopbackServer(),
    );

    expect(res.status).toBe(200);
    const { token: derivedJwt } = (await res.json()) as { token: string };
    const derivedRecord = getGatewayDb()
      .select({ status: actorTokenRecords.status })
      .from(actorTokenRecords)
      .where(eq(actorTokenRecords.tokenHash, actorTokenRecordHash(derivedJwt)))
      .get();

    expect(derivedRecord?.status).toBe("derived");
    expect(admitActorToken(derivedJwt, actorClaims)).toBe(true);

    revokeActorTokensByDevice("guardian-001", hashToken("device-A"));

    expect(admitActorToken(sourceJwt, actorClaims)).toBe(false);
    expect(admitActorToken(derivedJwt, actorClaims)).toBe(false);
  });

  test("fails closed with a repairable 401 when guardian rows are lost over evidence (no divergent mint)", async () => {
    const { handleCreateToken } = await import("../http/routes/auth-token.js");

    // Unrecorded (compatibility) source token: the handler falls back to
    // ensureVellumGuardianBinding. A residual actor-token row for another
    // device is evidence of prior onboarding with no guardian contact row,
    // so the fallback mint must refuse rather than diverge.
    insertTokenRecord("residual-evidence-token", "active");
    const jwt = mintToken({
      aud: "vellum-gateway",
      sub: ACTOR_SUB,
      scope_profile: "actor_client_v1",
      policy_epoch: CURRENT_POLICY_EPOCH,
      ttlSeconds: 3600,
    });

    const res = await handleCreateToken(
      new Request("http://127.0.0.1:7830/auth/token", {
        method: "POST",
        headers: {
          authorization: `Bearer ${jwt}`,
          origin: "http://localhost:3000",
        },
      }),
      makeLoopbackServer(),
    );

    // 401 is the status clients already treat as guardian-repairable.
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "guardian_repair_required" });
    // No divergent principal row was minted.
    expect(getGatewayDb().select().from(contacts).all()).toHaveLength(0);
    // No token minted or recorded beyond the seeded evidence row.
    expect(getGatewayDb().select().from(actorTokenRecords).all()).toHaveLength(
      1,
    );
  });
});

describe("/auth/token recorded-refresh guardian integrity gate", () => {
  function makeLoopbackServer() {
    return {
      requestIP: () => ({ address: "127.0.0.1", family: "IPv4", port: 5000 }),
    } as unknown as import("bun").Server<unknown>;
  }

  function mintRecordedSourceJwt(): string {
    const jwt = mintToken({
      aud: "vellum-gateway",
      sub: ACTOR_SUB,
      scope_profile: "actor_client_v1",
      policy_epoch: CURRENT_POLICY_EPOCH,
      ttlSeconds: 3600,
    });
    insertTokenRecord(jwt, "active");
    return jwt;
  }

  async function refresh(sourceJwt: string): Promise<Response> {
    const { handleCreateToken } = await import("../http/routes/auth-token.js");
    return handleCreateToken(
      new Request("http://127.0.0.1:7830/auth/token", {
        method: "POST",
        headers: {
          authorization: `Bearer ${sourceJwt}`,
          origin: "http://localhost:3000",
        },
      }),
      makeLoopbackServer(),
    );
  }

  test("refuses a recorded-token refresh with the repairable 401 when guardian rows are missing", async () => {
    // The recorded source token is itself evidence of prior onboarding; with
    // zero guardian contact rows the refresh must engage repair, not re-mint.
    const sourceJwt = mintRecordedSourceJwt();

    const res = await refresh(sourceJwt);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "guardian_repair_required" });
    // No derived token was minted or recorded.
    expect(getGatewayDb().select().from(actorTokenRecords).all()).toHaveLength(
      1,
    );
  });

  test("refreshes normally once the guardian is re-seeded and the cache busted", async () => {
    const sourceJwt = mintRecordedSourceJwt();

    expect((await refresh(sourceJwt)).status).toBe(401);

    insertGuardianContact();
    bustGuardianIntegrityCache();

    const res = await refresh(sourceJwt);
    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    expect(token).toBeTruthy();
  });

  test("a thrown integrity check does not block a healthy recorded refresh", async () => {
    const sourceJwt = mintRecordedSourceJwt();

    // Make guardianIntegrityState() throw while the token lookup and derived
    // record insert (actor_token_records) keep working.
    (
      getGatewayDb() as unknown as { $client: import("bun:sqlite").Database }
    ).$client.exec("DROP TABLE contacts");
    bustGuardianIntegrityCache();

    const res = await refresh(sourceJwt);
    expect(res.status).toBe(200);
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

describe("admitActorToken: device last-used stamping", () => {
  test("stamps last_used_at on the active row for a recorded actor token", () => {
    insertTokenRecord("token-used", "active");
    const before = readRow("token-used");
    expect(before?.lastUsedAt).toBeNull();

    expect(admitActorToken("token-used", actorClaims)).toBe(true);

    const after = readRow("token-used");
    expect(after?.lastUsedAt).toBeGreaterThan(0);
    // updatedAt tracks row lifecycle, not activity, so it must not move.
    expect(after?.updatedAt).toBe(before?.updatedAt ?? 0);
  });

  test("admitting a recorded token costs exactly one row lookup", () => {
    insertTokenRecord("token-counted", "active");

    const sql = captureSql(() => {
      expect(admitActorToken("token-counted", actorClaims)).toBe(true);
    });

    // The verdict and the stamp share one SELECT; the stamp adds the UPDATE.
    expect(statementsOn(sql, "select")).toHaveLength(1);
    expect(statementsOn(sql, "update")).toHaveLength(1);
  });

  test("does not write again inside the debounce window", () => {
    insertTokenRecord("token-debounced", "active");
    admitActorToken("token-debounced", actorClaims);

    const sentinel = 12_345;
    getGatewayDb()
      .update(actorTokenRecords)
      .set({ lastUsedAt: sentinel })
      .where(eq(actorTokenRecords.tokenHash, hashToken("token-debounced")))
      .run();

    const sql = captureSql(() => {
      expect(admitActorToken("token-debounced", actorClaims)).toBe(true);
    });

    expect(readRow("token-debounced")?.lastUsedAt).toBe(sentinel);
    // The verdict still costs its lookup: revocation is never debounced.
    expect(statementsOn(sql, "select")).toHaveLength(1);
    expect(statementsOn(sql, "update")).toHaveLength(0);
  });

  test("a derived token stamps the sibling active row for the same device", () => {
    insertTokenRecord("token-source", "active");
    insertTokenRecord("token-derived", "derived");

    admitActorToken("token-derived", actorClaims);

    expect(readRow("token-source")?.lastUsedAt).toBeGreaterThan(0);
    expect(readRow("token-derived")?.lastUsedAt).toBeNull();
  });

  test("leaves other devices' rows untouched", () => {
    insertTokenRecord("token-device-a", "active");
    insertTokenRecord("token-device-b", "active", "device-B");

    admitActorToken("token-device-a", actorClaims);

    expect(readRow("token-device-b")?.lastUsedAt).toBeNull();
  });

  test("is a no-op for non-actor tokens (svc)", () => {
    insertTokenRecord("svc-token", "active");
    const svcClaims = { sub: "svc:gateway:self" } as TokenClaims;

    const sql = captureSql(() => {
      expect(admitActorToken("svc-token", svcClaims)).toBe(true);
    });

    expect(readRow("svc-token")?.lastUsedAt).toBeNull();
    // Not even a lookup: a non-actor sub short-circuits before any DB work.
    expect(sql).toHaveLength(0);
  });

  test("is a no-op for an unrecorded token hash", () => {
    insertTokenRecord("token-recorded", "active");

    expect(admitActorToken("token-unrecorded", actorClaims)).toBe(true);
    expect(readRow("token-recorded")?.lastUsedAt).toBeNull();
  });

  test("swallows a DB failure (fail-open)", () => {
    resetGatewayDb();
    expect(() => admitActorToken("token-anything", actorClaims)).not.toThrow();
  });

  test("a failed stamp leaves the next attempt free to retry", () => {
    insertTokenRecord("token-retry", "active");
    const rawDb = (
      getGatewayDb() as unknown as { $client: import("bun:sqlite").Database }
    ).$client;
    // Make the stamp UPDATE throw while the record lookup keeps working.
    rawDb.exec(
      "CREATE TRIGGER fail_last_used BEFORE UPDATE ON actor_token_records BEGIN SELECT RAISE(ABORT, 'stamp failed'); END",
    );

    expect(admitActorToken("token-retry", actorClaims)).toBe(true);
    expect(readRow("token-retry")?.lastUsedAt).toBeNull();

    rawDb.exec("DROP TRIGGER fail_last_used");
    // Inside the debounce window: only a completed stamp may suppress a retry.
    admitActorToken("token-retry", actorClaims);

    expect(readRow("token-retry")?.lastUsedAt).toBeGreaterThan(0);
  });

  test("an unrecorded token hash does not stamp until the window lapses", () => {
    // Nothing to find: the definitive "no record" answer arms the debounce.
    admitActorToken("token-late", actorClaims);

    // Seed the row the first call missed. A second call inside the window
    // finds it (the verdict lookup always runs) but must not stamp it.
    insertTokenRecord("token-late", "active");
    admitActorToken("token-late", actorClaims);
    expect(readRow("token-late")?.lastUsedAt).toBeNull();

    // Once the window lapses the stamp runs.
    __resetLastUsedDebounceForTests();
    admitActorToken("token-late", actorClaims);
    expect(readRow("token-late")?.lastUsedAt).toBeGreaterThan(0);
  });

  test("a lookup that throws is retried on the next request", () => {
    // Distinguishes a transient failure from a stable miss: the DB-error path
    // arms nothing, so the very next call re-queries.
    const rawDb = (
      getGatewayDb() as unknown as { $client: import("bun:sqlite").Database }
    ).$client;
    rawDb.exec("ALTER TABLE actor_token_records RENAME TO actor_token_stash");

    expect(admitActorToken("token-transient", actorClaims)).toBe(true);

    rawDb.exec("ALTER TABLE actor_token_stash RENAME TO actor_token_records");
    insertTokenRecord("token-transient", "active");
    admitActorToken("token-transient", actorClaims);

    expect(readRow("token-transient")?.lastUsedAt).toBeGreaterThan(0);
  });
});
