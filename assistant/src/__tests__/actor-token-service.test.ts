/**
 * Tests for local identity resolution.
 *
 * Legacy actor-token HMAC middleware tests have been removed --
 * that middleware is replaced by the JWT auth middleware in
 * runtime/auth/middleware.test.ts.
 *
 * Pairing flow tests have moved to the gateway (pairing is now
 * gateway-native).
 *
 * The gateway owns credential minting and guardian binding creation;
 * these tests cover only local identity resolution.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => false,
  getInternalGatewayTarget: () => "http://localhost:7822",
  getGatewayBaseUrl: () => "http://localhost:7822",
  getRuntimeGatewayOriginSecret: () => undefined,
  isHttpAuthDisabledWithoutSafetyGate: () => false,
  checkUnrecognizedEnvVars: () => {},
}));

// No gateway in tests: force the reader to miss so resolution exercises the
// local-store bootstrap fallback deterministically.
let fakeGuardianDelivery: { principalId?: string | null } | null = null;
mock.module("../contacts/guardian-delivery-reader.js", () => ({
  getGuardianDelivery: async () =>
    fakeGuardianDelivery ? [fakeGuardianDelivery] : null,
  guardianForChannel: (list: { principalId?: string | null }[]) => list[0],
  invalidateGuardianDeliveryCache: () => {},
}));

import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { resetExternalAssistantIdCache } from "../runtime/auth/external-assistant-id.js";
import { initAuthSigningKey } from "../runtime/auth/token-service.js";
import { resolveLocalAuthContext } from "../runtime/local-actor-identity.js";
import { resetDbForTesting } from "./db-test-helpers.js";

// ---------------------------------------------------------------------------
// Test signing key
// ---------------------------------------------------------------------------

const TEST_KEY = Buffer.from("test-signing-key-32-bytes-long!!");

// ---------------------------------------------------------------------------
await initializeDb();

beforeEach(async () => {
  initAuthSigningKey(TEST_KEY);
  resetExternalAssistantIdCache();
  fakeGuardianDelivery = null;
  resetDbForTesting();
  await initializeDb();
});

// ---------------------------------------------------------------------------
// Local AuthContext resolution
// ---------------------------------------------------------------------------

describe("resolveLocalAuthContext", () => {
  test("returns AuthContext with local principal type", async () => {
    const ctx = await resolveLocalAuthContext("session-123");
    expect(ctx.principalType).toBe("local");
  });

  test("subject follows local:self:<conversationId> pattern", async () => {
    const ctx = await resolveLocalAuthContext("session-abc");
    expect(ctx.subject).toBe("local:self:session-abc");
  });

  test("assistantId is always self", async () => {
    const ctx = await resolveLocalAuthContext("session-123");
    expect(ctx.assistantId).toBe("self");
  });

  test("uses local_v1 scope profile with local.all scope", async () => {
    const ctx = await resolveLocalAuthContext("session-123");
    expect(ctx.scopeProfile).toBe("local_v1");
    expect(ctx.scopes.has("local.all")).toBe(true);
  });

  test("actorPrincipalId is undefined when no vellum binding exists", async () => {
    const db = getDb();
    db.run("DELETE FROM contact_channels");
    db.run("DELETE FROM contacts");

    const ctx = await resolveLocalAuthContext("session-123");
    expect(ctx.actorPrincipalId).toBeUndefined();
  });

  test("resolves the guardian principal from the gateway when available", async () => {
    const db = getDb();
    db.run("DELETE FROM contact_channels");
    db.run("DELETE FROM contacts");
    fakeGuardianDelivery = { principalId: "gateway-guardian-id" };

    const ctx = await resolveLocalAuthContext("session-123");
    expect(ctx.actorPrincipalId).toBe("gateway-guardian-id");
  });

  test("conversationId matches the provided argument", async () => {
    const ctx = await resolveLocalAuthContext("my-session");
    expect(ctx.conversationId).toBe("my-session");
  });
});
