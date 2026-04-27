/**
 * Tests for guardian bootstrap, vellum migration, and local identity
 * resolution.
 *
 * Legacy actor-token HMAC middleware tests have been removed --
 * that middleware is replaced by the JWT auth middleware in
 * runtime/auth/middleware.test.ts.
 *
 * Pairing flow tests have moved to the gateway (pairing is now
 * gateway-native).
 *
 * The gateway owns credential minting; these tests cover only
 * guardian bootstrap, vellum migration, and local identity resolution.
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

import { findGuardianForChannel } from "../contacts/contact-store.js";
import { createGuardianBinding } from "../contacts/contacts-write.js";
import { initializeDb, resetDb } from "../memory/db.js";
import { resetExternalAssistantIdCache } from "../runtime/auth/external-assistant-id.js";
import { initAuthSigningKey } from "../runtime/auth/token-service.js";
import { ensureVellumGuardianBinding } from "../runtime/guardian-vellum-migration.js";
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
// Guardian vellum migration
// ---------------------------------------------------------------------------

describe("guardian vellum migration", () => {
  test("ensureVellumGuardianBinding creates binding when missing", () => {
    const principalId = ensureVellumGuardianBinding("self");
    expect(principalId).toMatch(/^vellum-principal-/);

    const guardianResult = findGuardianForChannel("vellum");
    expect(guardianResult).not.toBeNull();
    expect(guardianResult!.contact.principalId).toBe(principalId);
    expect(guardianResult!.channel.verifiedVia).toBe("startup-migration");
  });

  test("ensureVellumGuardianBinding is idempotent", () => {
    const first = ensureVellumGuardianBinding("self");
    const second = ensureVellumGuardianBinding("self");
    expect(first).toBe(second);
  });

  test("ensureVellumGuardianBinding preserves existing bindings for other channels", () => {
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "tg-user-123",
      guardianDeliveryChatId: "tg-chat-456",
      guardianPrincipalId: "tg-user-123",
      verifiedVia: "challenge",
    });

    ensureVellumGuardianBinding("self");

    const tgGuardian = findGuardianForChannel("telegram");
    expect(tgGuardian).not.toBeNull();
    expect(tgGuardian!.channel.externalUserId).toBe("tg-user-123");

    const vGuardian = findGuardianForChannel("vellum");
    expect(vGuardian).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Local identity resolution
// ---------------------------------------------------------------------------

describe("resolveLocalTrustContext", () => {
  test("returns guardian context when vellum binding exists", () => {
    ensureVellumGuardianBinding("self");

    const ctx = resolveLocalTrustContext();
    expect(ctx.trustClass).toBe("guardian");
    expect(ctx.sourceChannel).toBe("vellum");
  });

  test("returns guardian context with principal when no vellum binding exists (pre-bootstrap self-heal)", () => {
    const ctx = resolveLocalTrustContext();
    expect(ctx.trustClass).toBe("guardian");
    expect(ctx.sourceChannel).toBe("vellum");
    expect(ctx.guardianPrincipalId).toBeDefined();
  });

  test("respects custom sourceChannel parameter", () => {
    ensureVellumGuardianBinding("self");
    const ctx = resolveLocalTrustContext("vellum");
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

  test("enriches actorPrincipalId from vellum guardian binding when present", () => {
    ensureVellumGuardianBinding("self");
    const guardianResult = findGuardianForChannel("vellum");
    expect(guardianResult).toBeTruthy();

    const ctx = resolveLocalAuthContext("session-123");
    expect(ctx.actorPrincipalId).toBe(
      guardianResult!.contact.principalId ?? undefined,
    );
  });

  test("actorPrincipalId is auto-created via self-heal when no vellum binding exists", () => {
    // Reset DB to ensure no binding
    resetDb();
    initializeDb();

    const ctx = resolveLocalAuthContext("session-123");
    // Self-heal creates a vellum guardian binding automatically
    expect(ctx.actorPrincipalId).toBeDefined();
    expect(ctx.actorPrincipalId).toMatch(/^vellum-principal-/);
  });

  test("conversationId matches the provided argument", () => {
    const ctx = resolveLocalAuthContext("my-session");
    expect(ctx.conversationId).toBe("my-session");
  });
});
