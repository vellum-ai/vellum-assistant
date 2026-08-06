/**
 * Tests for A2A invite redemption handler (receiver side).
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
import { getA2AConfig, redeemA2AInvite } from "../config-a2a.js";

await initializeDb();

function resetTables(): void {
  const sqlite = getSqlite();
  sqlite.run("DELETE FROM assistant_contact_metadata");
  sqlite.run("DELETE FROM contact_channels");
  sqlite.run("DELETE FROM contacts");
}

function setConfig(opts: { a2aEnabled?: boolean }): void {
  const raw = loadRawConfig();
  if (opts.a2aEnabled !== undefined) {
    setNestedValue(raw, "a2a.enabled", opts.a2aEnabled);
  }
  saveRawConfig(raw);
  invalidateConfigCache();
}

const SENDER = {
  assistantId: "sender-assistant-123",
  displayName: "Sender Bot",
  gatewayUrl: "https://sender.example.com",
};

describe("redeemA2AInvite", () => {
  beforeEach(() => {
    resetTables();
    setConfig({ a2aEnabled: false });
  });

  test("happy path: creates local contact with sender identity", () => {
    const result = redeemA2AInvite({ sender: SENDER });

    expect(result.success).toBe(true);
    expect(result.contactId).toBeDefined();
    expect(result.alreadyConnected).toBeUndefined();
    expect(result.error).toBeUndefined();

    const contact = getContact(result.contactId!);
    expect(contact).not.toBeNull();
    expect(contact!.displayName).toBe("Sender Bot");
    expect(contact!.channels).toHaveLength(1);
    expect(contact!.channels[0]!.type).toBe("a2a");
  });

  test("idempotency: already-connected sender returns alreadyConnected", () => {
    const first = redeemA2AInvite({ sender: SENDER });
    expect(first.success).toBe(true);

    const second = redeemA2AInvite({ sender: SENDER });
    expect(second.success).toBe(true);
    expect(second.alreadyConnected).toBe(true);
    expect(second.contactId).toBe(first.contactId);
  });

  test("auto-enables A2A if disabled", () => {
    setConfig({ a2aEnabled: false });

    const result = redeemA2AInvite({ sender: SENDER });
    expect(result.success).toBe(true);

    // Verify A2A was auto-enabled by checking config
    const config = getA2AConfig();
    expect(config.enabled).toBe(true);
  });

  test("assistantContactMetadata has correct assistantId and gatewayUrl", () => {
    const result = redeemA2AInvite({ sender: SENDER });
    expect(result.success).toBe(true);

    const metadata = getAssistantContactMetadata(result.contactId!);
    expect(metadata).not.toBeNull();
    expect(metadata!.species).toBe("vellum");
    expect(metadata!.metadata).toEqual({
      assistantId: "sender-assistant-123",
      gatewayUrl: "https://sender.example.com",
    });
  });

  test("channel address uses sender.assistantId.toLowerCase()", () => {
    const senderWithUppercase = {
      ...SENDER,
      assistantId: "UPPER-Case-SENDER-ID",
    };

    const result = redeemA2AInvite({ sender: senderWithUppercase });
    expect(result.success).toBe(true);

    const contact = getContact(result.contactId!);
    expect(contact!.channels[0]!.address).toBe("upper-case-sender-id");
  });

  test("does not make outbound fetch calls", () => {
    // This test verifies that redeemA2AInvite is purely local — no fetch mock
    // is installed. If it tried to fetch, the call would fail and the test
    // would throw.
    const result = redeemA2AInvite({ sender: SENDER });
    expect(result.success).toBe(true);
  });

  test("activeConnections counts a2a channel existence", () => {
    const result = redeemA2AInvite({ sender: SENDER });
    expect(result.success).toBe(true);

    // Readiness is existence-based: the presence of the a2a channel is what
    // counts. (Channel ACL status is gateway-owned and not stored locally.)
    expect(getA2AConfig().activeConnections).toBe(1);
    invalidateConfigCache();
    expect(getA2AConfig().activeConnections).toBe(1);
  });

  test("already-connected guard fires based on channel existence", () => {
    const first = redeemA2AInvite({ sender: SENDER });
    expect(first.success).toBe(true);

    // The guard keys off the existing a2a channel, not any stored status.
    const second = redeemA2AInvite({ sender: SENDER });
    expect(second.alreadyConnected).toBe(true);
    expect(second.contactId).toBe(first.contactId);
  });
});
