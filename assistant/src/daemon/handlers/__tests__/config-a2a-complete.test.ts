/**
 * Tests for A2A invite completion handler (sender side).
 *
 * Uses the real DB (via `initializeDb()`) and the test preload which sets
 * `VELLUM_WORKSPACE_DIR` to a per-file temp directory.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import {
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
} from "../../../config/loader.js";
import {
  getAssistantContactMetadata,
  getContact,
} from "../../../contacts/contact-store.js";
import { getSqlite } from "../../../persistence/db-connection.js";
import { initializeDb } from "../../../persistence/db-init.js";
import { completeA2AInvite, createA2AInvite } from "../config-a2a.js";

await initializeDb();

function resetTables(): void {
  const sqlite = getSqlite();
  sqlite.run("DELETE FROM a2a_invites");
  sqlite.run("DELETE FROM assistant_contact_metadata");
  sqlite.run("DELETE FROM contact_channels");
  sqlite.run("DELETE FROM contacts");
}

interface A2aInviteRow {
  id: string;
  contact_id: string;
  status: string;
  use_count: number;
}

function getInviteRow(id: string): A2aInviteRow | null {
  return getSqlite()
    .prepare("SELECT * FROM a2a_invites WHERE id = ?")
    .get(id) as A2aInviteRow | null;
}

function setConfig(opts: {
  a2aEnabled?: boolean;
  publicBaseUrl?: string;
  ingressEnabled?: boolean;
}): void {
  const raw = loadRawConfig();
  if (opts.a2aEnabled !== undefined) {
    setNestedValue(raw, "a2a.enabled", opts.a2aEnabled);
  }
  if (opts.publicBaseUrl !== undefined) {
    setNestedValue(raw, "ingress.publicBaseUrl", opts.publicBaseUrl);
  }
  if (opts.ingressEnabled !== undefined) {
    setNestedValue(raw, "ingress.enabled", opts.ingressEnabled);
  }
  saveRawConfig(raw);
  invalidateConfigCache();
}

const ACCEPTOR = {
  assistantId: "acceptor-assistant-123",
  displayName: "Acceptor Bot",
  gatewayUrl: "https://acceptor.example.com",
};

describe("completeA2AInvite", () => {
  beforeEach(() => {
    resetTables();
    setConfig({
      a2aEnabled: false,
      publicBaseUrl: "https://sender.example.com",
      ingressEnabled: true,
    });
  });

  test("happy path: promotes placeholder contact and returns sender identity", () => {
    const created = createA2AInvite({});
    expect(created.success).toBe(true);

    const result = completeA2AInvite({
      token: created.token!,
      senderAssistantId: "sender-platform-id-789",
      acceptor: ACCEPTOR,
    });

    expect(result.success).toBe(true);
    expect(result.sender).toBeDefined();
    expect(result.sender!.assistantId).toBe("sender-platform-id-789");
    expect(result.sender!.gatewayUrl).toBe("https://sender.example.com");
    expect(result.sender!.displayName).toBeDefined();
    expect(result.error).toBeUndefined();

    // Verify the placeholder contact was promoted
    const invite = getInviteRow(created.inviteId!);
    expect(invite).not.toBeNull();

    const contact = getContact(invite!.contact_id);
    expect(contact).not.toBeNull();
    expect(contact!.displayName).toBe("Acceptor Bot");
    expect(contact!.channels).toHaveLength(1);
    expect(contact!.channels[0]!.type).toBe("a2a");
  });

  test("contact channel address is acceptor.assistantId.toLowerCase()", () => {
    const created = createA2AInvite({});
    const acceptorWithUppercase = {
      ...ACCEPTOR,
      assistantId: "UPPER-Case-ID-123",
    };

    const result = completeA2AInvite({
      token: created.token!,
      senderAssistantId: "sender-platform-id-789",
      acceptor: acceptorWithUppercase,
    });
    expect(result.success).toBe(true);

    const invite = getInviteRow(created.inviteId!);
    const contact = getContact(invite!.contact_id);
    expect(contact!.channels[0]!.address).toBe("upper-case-id-123");
  });

  test("assistantContactMetadata has correct assistantId and gatewayUrl", () => {
    const created = createA2AInvite({});
    const result = completeA2AInvite({
      token: created.token!,
      senderAssistantId: "sender-platform-id-789",
      acceptor: ACCEPTOR,
    });
    expect(result.success).toBe(true);

    const invite = getInviteRow(created.inviteId!);
    const metadata = getAssistantContactMetadata(invite!.contact_id);
    expect(metadata).not.toBeNull();
    expect(metadata!.species).toBe("vellum");
    expect(metadata!.metadata).toEqual({
      assistantId: "acceptor-assistant-123",
      gatewayUrl: "https://acceptor.example.com",
    });
  });

  test("invalid token returns not_found error", () => {
    const result = completeA2AInvite({
      token: "invalid-token-that-does-not-exist",
      senderAssistantId: "sender-platform-id-789",
      acceptor: ACCEPTOR,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("not_found");
  });

  test("expired invite returns expired error", () => {
    // Create an invite that expires immediately
    const created = createA2AInvite({ expiresInHours: 0 });
    expect(created.success).toBe(true);

    // The invite was just created with 0 hours expiry, so expiresAt ~= now
    // Manually expire it by updating the DB
    const sqlite = getSqlite();
    sqlite.run("UPDATE a2a_invites SET expires_at = ? WHERE id = ?", [
      Date.now() - 1000,
      created.inviteId!,
    ]);

    const result = completeA2AInvite({
      token: created.token!,
      senderAssistantId: "sender-platform-id-789",
      acceptor: ACCEPTOR,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("expired");
  });

  test("already-redeemed by same acceptor returns idempotent success", () => {
    const created = createA2AInvite({});
    expect(created.success).toBe(true);

    // First completion
    const first = completeA2AInvite({
      token: created.token!,
      senderAssistantId: "sender-platform-id-789",
      acceptor: ACCEPTOR,
    });
    expect(first.success).toBe(true);

    // Second completion with same acceptor
    const second = completeA2AInvite({
      token: created.token!,
      senderAssistantId: "sender-platform-id-789",
      acceptor: ACCEPTOR,
    });
    expect(second.success).toBe(true);
  });

  test("already-redeemed by different acceptor returns error", () => {
    const created = createA2AInvite({});
    expect(created.success).toBe(true);

    // First completion
    const first = completeA2AInvite({
      token: created.token!,
      senderAssistantId: "sender-platform-id-789",
      acceptor: ACCEPTOR,
    });
    expect(first.success).toBe(true);

    // Second completion with different acceptor
    const second = completeA2AInvite({
      token: created.token!,
      senderAssistantId: "sender-platform-id-789",
      acceptor: {
        assistantId: "different-assistant-456",
        displayName: "Different Bot",
        gatewayUrl: "https://different.example.com",
      },
    });

    expect(second.success).toBe(false);
    expect(second.error).toBe("already_redeemed_by_other");
  });

  test("fails before claiming token when public base URL is not configured", () => {
    const created = createA2AInvite({});
    expect(created.success).toBe(true);

    setConfig({ publicBaseUrl: "", ingressEnabled: true });

    const result = completeA2AInvite({
      token: created.token!,
      senderAssistantId: "sender-platform-id-789",
      acceptor: ACCEPTOR,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("public base URL");

    // Verify the invite was NOT consumed
    const invite = getInviteRow(created.inviteId!);
    expect(invite!.status).toBe("active");
    expect(invite!.use_count).toBe(0);
  });
});
