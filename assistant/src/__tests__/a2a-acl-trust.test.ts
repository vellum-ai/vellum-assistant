/**
 * Tests for A2A ACL enforcement and trust classification.
 *
 * Verifies that:
 * - Paired assistant contacts resolve as trusted_contact with actorKind: "assistant"
 * - Human contacts resolve as trusted_contact with actorKind: "human"
 * - Unknown actors have actorKind: undefined
 * - Revoked/blocked assistant contacts are denied (classified as unknown)
 * - Assistant trust classification does not interfere with human contact classification
 * - Existing test fixtures compile without modification (actorKind is optional)
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Test isolation: in-memory SQLite via temp directory
// ---------------------------------------------------------------------------

const testDir = mkdtempSync(join(tmpdir(), "a2a-acl-trust-test-"));

mock.module("../util/platform.js", () => ({
  getRootDir: () => testDir,
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { upsertContact } from "../contacts/contact-store.js";
import type { TrustContext } from "../daemon/conversation-runtime-assembly.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import {
  resolveActorTrust,
  toTrustContext,
} from "../runtime/actor-trust-resolver.js";

initializeDb();

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM contact_channels");
  db.run("DELETE FROM contacts");
}

function createAssistantContact(assistantId: string): void {
  upsertContact({
    displayName: `Assistant ${assistantId}`,
    contactType: "assistant",
    channels: [
      {
        type: "vellum",
        address: assistantId,
        externalUserId: assistantId,
        externalChatId: null,
        status: "active",
        policy: "allow",
      },
    ],
  });
}

function createHumanContact(externalUserId: string): void {
  upsertContact({
    displayName: `Human ${externalUserId}`,
    contactType: "human",
    channels: [
      {
        type: "vellum",
        address: externalUserId,
        externalUserId,
        externalChatId: null,
        status: "active",
        policy: "allow",
      },
    ],
  });
}

function resolveTrust(actorExternalId: string): {
  trustContext: TrustContext;
  actorTrust: ReturnType<typeof resolveActorTrust>;
} {
  const actorTrust = resolveActorTrust({
    assistantId: "self",
    sourceChannel: "vellum",
    conversationExternalId: "test-conv-1",
    actorExternalId,
  });
  const trustContext = toTrustContext(actorTrust, "test-conv-1");
  return { trustContext, actorTrust };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("A2A ACL enforcement and trust classification", () => {
  beforeEach(() => {
    resetTables();
  });

  test("paired assistant contact resolves as trusted_contact with actorKind: assistant", () => {
    createAssistantContact("remote-assistant-001");

    const { trustContext, actorTrust } = resolveTrust("remote-assistant-001");

    expect(actorTrust.trustClass).toBe("trusted_contact");
    expect(trustContext.trustClass).toBe("trusted_contact");
    expect(trustContext.actorKind).toBe("assistant");
  });

  test("human vellum contact resolves as trusted_contact with actorKind: human", () => {
    createHumanContact("human-user-001");

    const { trustContext, actorTrust } = resolveTrust("human-user-001");

    expect(actorTrust.trustClass).toBe("trusted_contact");
    expect(trustContext.trustClass).toBe("trusted_contact");
    expect(trustContext.actorKind).toBe("human");
  });

  test("unknown actor has actorKind: undefined", () => {
    const { trustContext, actorTrust } = resolveTrust("unknown-actor-xyz");

    expect(actorTrust.trustClass).toBe("unknown");
    expect(trustContext.trustClass).toBe("unknown");
    expect(trustContext.actorKind).toBeUndefined();
  });

  test("authenticated message from unknown assistant ID (no contact) is rejected", () => {
    // No contact exists for this assistant ID — should classify as unknown (fail closed)
    const { actorTrust } = resolveTrust("non-existent-assistant-999");

    expect(actorTrust.trustClass).toBe("unknown");
    expect(actorTrust.memberRecord).toBeNull();
  });

  test("revoked assistant contact is denied", () => {
    // Create active then update to revoked
    createAssistantContact("revoked-assistant-001");
    upsertContact({
      displayName: "Revoked Assistant",
      contactType: "assistant",
      channels: [
        {
          type: "vellum",
          address: "revoked-assistant-001",
          externalUserId: "revoked-assistant-001",
          externalChatId: null,
          status: "revoked",
          policy: "deny",
        },
      ],
    });

    const { trustContext, actorTrust } = resolveTrust("revoked-assistant-001");

    // Revoked contacts should classify as unknown (not trusted_contact)
    expect(actorTrust.trustClass).toBe("unknown");
    expect(trustContext.trustClass).toBe("unknown");
  });

  test("blocked assistant contact is denied", () => {
    createAssistantContact("blocked-assistant-001");
    upsertContact({
      displayName: "Blocked Assistant",
      contactType: "assistant",
      channels: [
        {
          type: "vellum",
          address: "blocked-assistant-001",
          externalUserId: "blocked-assistant-001",
          externalChatId: null,
          status: "blocked",
          policy: "deny",
        },
      ],
    });

    const { trustContext, actorTrust } = resolveTrust("blocked-assistant-001");

    expect(actorTrust.trustClass).toBe("unknown");
    expect(trustContext.trustClass).toBe("unknown");
  });

  test("assistant trust classification does not interfere with human contact classification", () => {
    // Create both an assistant and a human contact
    createAssistantContact("assistant-peer-001");
    createHumanContact("human-user-002");

    // Resolve assistant
    const assistantResult = resolveTrust("assistant-peer-001");
    expect(assistantResult.trustContext.trustClass).toBe("trusted_contact");
    expect(assistantResult.trustContext.actorKind).toBe("assistant");

    // Resolve human — should be unaffected
    const humanResult = resolveTrust("human-user-002");
    expect(humanResult.trustContext.trustClass).toBe("trusted_contact");
    expect(humanResult.trustContext.actorKind).toBe("human");
  });

  test("existing TrustContext fixtures compile without modification (actorKind is optional)", () => {
    // Verify that a TrustContext without actorKind is valid
    const legacyContext: TrustContext = {
      sourceChannel: "telegram",
      trustClass: "trusted_contact",
    };
    expect(legacyContext.actorKind).toBeUndefined();

    // Verify that a TrustContext with actorKind is also valid
    const newContext: TrustContext = {
      sourceChannel: "vellum",
      trustClass: "trusted_contact",
      actorKind: "assistant",
    };
    expect(newContext.actorKind).toBe("assistant");
  });
});
