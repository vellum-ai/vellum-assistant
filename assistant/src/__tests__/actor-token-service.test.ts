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

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => false,
  getInternalGatewayTarget: () => "http://localhost:7822",
  getGatewayBaseUrl: () => "http://localhost:7822",
  getRuntimeGatewayOriginSecret: () => undefined,
  isHttpAuthDisabledWithoutSafetyGate: () => false,
  checkUnrecognizedEnvVars: () => {},
}));

import { getDb, resetDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { resetExternalAssistantIdCache } from "../runtime/auth/external-assistant-id.js";
import { initAuthSigningKey } from "../runtime/auth/token-service.js";
import {
  resolveLocalAuthContext,
  resolveLocalTrustContext,
} from "../runtime/local-actor-identity.js";

// ---------------------------------------------------------------------------
// Test signing key
// ---------------------------------------------------------------------------

const TEST_KEY = Buffer.from("test-signing-key-32-bytes-long!!");

// ---------------------------------------------------------------------------
initializeDb();

beforeEach(() => {
  initAuthSigningKey(TEST_KEY);
  resetExternalAssistantIdCache();
  resetDb();
  initializeDb();
});

// ---------------------------------------------------------------------------
// Local identity resolution
// ---------------------------------------------------------------------------

describe("resolveLocalTrustContext", () => {
  test("falls back to minimal trust context when no vellum binding exists", () => {
    const ctx = resolveLocalTrustContext();
    expect(ctx.sourceChannel).toBe("vellum");
  });
});

// ---------------------------------------------------------------------------
// Local AuthContext resolution
// ---------------------------------------------------------------------------

describe("resolveLocalAuthContext", () => {
  test("returns AuthContext with local principal type", () => {
    const ctx = resolveLocalAuthContext("session-123");
    expect(ctx.principalType).toBe("local");
  });

  test("subject follows local:self:<conversationId> pattern", () => {
    const ctx = resolveLocalAuthContext("session-abc");
    expect(ctx.subject).toBe("local:self:session-abc");
  });

  test("assistantId is always self", () => {
    const ctx = resolveLocalAuthContext("session-123");
    expect(ctx.assistantId).toBe("self");
  });

  test("uses local_v1 scope profile with local.all scope", () => {
    const ctx = resolveLocalAuthContext("session-123");
    expect(ctx.scopeProfile).toBe("local_v1");
    expect(ctx.scopes.has("local.all")).toBe(true);
  });

  test("actorPrincipalId is undefined when no vellum binding exists", () => {
    const db = getDb();
    db.run("DELETE FROM contact_channels");
    db.run("DELETE FROM contacts");

    const ctx = resolveLocalAuthContext("session-123");
    expect(ctx.actorPrincipalId).toBeUndefined();
  });

  test("conversationId matches the provided argument", () => {
    const ctx = resolveLocalAuthContext("my-session");
    expect(ctx.conversationId).toBe("my-session");
  });
});
