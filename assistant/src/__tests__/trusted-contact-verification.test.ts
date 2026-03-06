/**
 * Tests for M4: Verification success → trusted contact activation.
 *
 * When a requester successfully verifies their identity (enters the correct
 * 6-digit code from an identity-bound outbound session), the system should:
 * 1. Upsert an active member record (contact + contact_channel)
 * 2. Allow subsequent messages through the ACL check
 * 3. Scope the member correctly (no cross-assistant leakage)
 * 4. Reactivate previously revoked members on re-verification
 * 5. NOT create a guardian binding (trusted contacts are not guardians)
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Test isolation: in-memory SQLite via temp directory
// ---------------------------------------------------------------------------

const testDir = mkdtempSync(join(tmpdir(), "trusted-contact-verify-test-"));

mock.module("../util/platform.js", () => ({
  getRootDir: () => testDir,
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getSocketPath: () => join(testDir, "test.sock"),
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

import {
  findContactChannel,
  findGuardianForChannel,
} from "../contacts/contact-store.js";
import {
  createGuardianBinding,
  revokeMember,
  upsertContactChannel,
} from "../contacts/contacts-write.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { resolveActorTrust } from "../runtime/actor-trust-resolver.js";
import {
  createOutboundSession,
  validateAndConsumeChallenge,
} from "../runtime/channel-guardian-service.js";

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
  db.run("DELETE FROM channel_guardian_verification_challenges");
  db.run("DELETE FROM channel_guardian_rate_limits");
  db.run("DELETE FROM contact_channels");
  db.run("DELETE FROM contacts");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("trusted contact verification → member activation", () => {
  beforeEach(() => {
    resetTables();
  });

  test("successful verification creates active member with allow policy", () => {
    // Simulate M3: guardian approves, outbound session created for the requester
    const session = createOutboundSession({
      channel: "telegram",
      expectedExternalUserId: "requester-user-123",
      expectedChatId: "requester-chat-123",
      identityBindingStatus: "bound",
      destinationAddress: "requester-chat-123",
      verificationPurpose: "trusted_contact",
    });

    // Requester enters the 6-digit code
    const result = validateAndConsumeChallenge(
      "telegram",
      session.secret,
      "requester-user-123",
      "requester-chat-123",
      "requester_username",
      "Requester Name",
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.verificationType).toBe("trusted_contact");
    }

    // Simulate the member upsert that inbound-message-handler performs on success
    upsertContactChannel({
      sourceChannel: "telegram",
      externalUserId: "requester-user-123",
      externalChatId: "requester-chat-123",
      status: "active",
      policy: "allow",
      displayName: "Requester Name",
      username: "requester_username",
    });

    // Verify: active member record exists
    const contactResult = findContactChannel({
      channelType: "telegram",
      externalUserId: "requester-user-123",
    });

    expect(contactResult).not.toBeNull();
    expect(contactResult!.channel.status).toBe("active");
    expect(contactResult!.channel.policy).toBe("allow");
    expect(contactResult!.channel.externalUserId).toBe("requester-user-123");
    expect(contactResult!.channel.externalChatId).toBe("requester-chat-123");
    expect(contactResult!.contact.displayName).toBe("Requester Name");
    expect(contactResult!.channel.type).toBe("telegram");
  });

  test("resolveActorTrust surfaces member displayName when sender displayName is missing", () => {
    upsertContactChannel({
      sourceChannel: "telegram",
      externalUserId: "requester-user-jeff",
      externalChatId: "requester-chat-jeff",
      status: "active",
      policy: "allow",
      displayName: "Jeff",
      username: "jeff_handle",
    });

    const trust = resolveActorTrust({
      assistantId: "self",
      sourceChannel: "telegram",
      conversationExternalId: "requester-chat-jeff",
      actorExternalId: "requester-user-jeff",
    });

    expect(trust.trustClass).toBe("trusted_contact");
    expect(trust.actorMetadata.displayName).toBe("Jeff");
    expect(trust.actorMetadata.senderDisplayName).toBeUndefined();
    expect(trust.actorMetadata.memberDisplayName).toBe("Jeff");
    // Contacts-first path does not carry username from the contact channel,
    // so identifier falls back to canonicalSenderId when no actorUsername
    // is provided.
    expect(trust.actorMetadata.identifier).toBe("requester-user-jeff");
  });

  test("resolveActorTrust prioritizes member displayName over sender displayName", () => {
    upsertContactChannel({
      sourceChannel: "telegram",
      externalUserId: "requester-user-jeff-priority",
      externalChatId: "requester-chat-jeff-priority",
      status: "active",
      policy: "allow",
      displayName: "Jeff",
      username: "jeff_handle",
    });

    const trust = resolveActorTrust({
      assistantId: "self",
      sourceChannel: "telegram",
      conversationExternalId: "requester-chat-jeff-priority",
      actorExternalId: "requester-user-jeff-priority",
      actorUsername: "jeffrey_telegram",
      actorDisplayName: "Jeffrey",
    });

    expect(trust.trustClass).toBe("trusted_contact");
    expect(trust.actorMetadata.displayName).toBe("Jeff");
    expect(trust.actorMetadata.senderDisplayName).toBe("Jeffrey");
    expect(trust.actorMetadata.memberDisplayName).toBe("Jeff");
    // Contacts-first path does not carry username from the contact channel,
    // so the sender's username takes precedence via the fallback chain.
    expect(trust.actorMetadata.username).toBe("jeffrey_telegram");
    expect(trust.actorMetadata.identifier).toBe("@jeffrey_telegram");
  });

  test("resolveActorTrust falls back to sender metadata when member record matches chat but not sender (group chat)", () => {
    // Simulate a group chat: member record exists for a different user who
    // shares the same externalChatId (e.g., Telegram group).
    upsertContactChannel({
      sourceChannel: "telegram",
      externalUserId: "other-user-in-group",
      externalChatId: "shared-group-chat",
      status: "active",
      policy: "allow",
      displayName: "Other User",
      username: "other_handle",
    });

    // A different sender sends a message in the same group chat
    const trust = resolveActorTrust({
      assistantId: "self",
      sourceChannel: "telegram",
      conversationExternalId: "shared-group-chat",
      actorExternalId: "actual-sender-in-group",
      actorUsername: "actual_sender_handle",
      actorDisplayName: "Actual Sender",
    });

    // The member record returned by findMember matched on chatId but belongs
    // to a different user, so member metadata should NOT be used and trust
    // should NOT be elevated to trusted_contact.
    expect(trust.trustClass).toBe("unknown");
    expect(trust.actorMetadata.displayName).toBe("Actual Sender");
    expect(trust.actorMetadata.senderDisplayName).toBe("Actual Sender");
    expect(trust.actorMetadata.memberDisplayName).toBeUndefined();
    expect(trust.actorMetadata.username).toBe("actual_sender_handle");
    expect(trust.actorMetadata.identifier).toBe("@actual_sender_handle");
  });

  test("post-verify message is accepted (ACL check passes)", () => {
    // Create and verify a trusted contact
    const session = createOutboundSession({
      channel: "telegram",
      expectedExternalUserId: "requester-user-456",
      expectedChatId: "requester-chat-456",
      identityBindingStatus: "bound",
      destinationAddress: "requester-chat-456",
      verificationPurpose: "trusted_contact",
    });

    validateAndConsumeChallenge(
      "telegram",
      session.secret,
      "requester-user-456",
      "requester-chat-456",
    );

    // Simulate member upsert on verification success
    upsertContactChannel({
      sourceChannel: "telegram",
      externalUserId: "requester-user-456",
      externalChatId: "requester-chat-456",
      status: "active",
      policy: "allow",
    });

    // Simulate the ACL check that inbound-message-handler performs
    const contactResult = findContactChannel({
      channelType: "telegram",
      externalUserId: "requester-user-456",
    });

    expect(contactResult).not.toBeNull();
    expect(contactResult!.channel.status).toBe("active");
    expect(contactResult!.channel.policy).toBe("allow");
    // ACL check passes: member exists, is active, and has allow policy
  });

  test("member lookup is scoped by channel type", () => {
    // Create member on the telegram channel
    const session = createOutboundSession({
      channel: "telegram",
      expectedExternalUserId: "user-cross-test",
      expectedChatId: "chat-cross-test",
      identityBindingStatus: "bound",
      destinationAddress: "chat-cross-test",
      verificationPurpose: "trusted_contact",
    });

    validateAndConsumeChallenge(
      "telegram",
      session.secret,
      "user-cross-test",
      "chat-cross-test",
    );

    upsertContactChannel({
      sourceChannel: "telegram",
      externalUserId: "user-cross-test",
      externalChatId: "chat-cross-test",
      status: "active",
      policy: "allow",
    });

    // Member should be found via contacts
    const contactResult = findContactChannel({
      channelType: "telegram",
      externalUserId: "user-cross-test",
    });
    expect(contactResult).not.toBeNull();
    expect(contactResult!.channel.status).toBe("active");

    // Member should NOT be found for a different channel type
    const otherChannel = findContactChannel({
      channelType: "slack",
      externalUserId: "user-cross-test",
    });
    expect(otherChannel).toBeNull();
  });

  test("re-verification of previously revoked member reactivates them", () => {
    // Create and activate a member
    const member = upsertContactChannel({
      sourceChannel: "telegram",
      externalUserId: "user-revoked",
      externalChatId: "chat-revoked",
      status: "active",
      policy: "allow",
      displayName: "Revoked User",
    });

    // Revoke the member
    const revoked = revokeMember(member!.channel.id, "testing revocation");
    expect(revoked).not.toBeNull();
    expect(revoked!.channel.status).toBe("revoked");

    // Verify the member is indeed revoked (ACL would reject)
    const revokedResult = findContactChannel({
      channelType: "telegram",
      externalUserId: "user-revoked",
    });
    expect(revokedResult).not.toBeNull();
    expect(revokedResult!.channel.status).toBe("revoked");

    // Guardian re-approves, new outbound session created
    const session = createOutboundSession({
      channel: "telegram",
      expectedExternalUserId: "user-revoked",
      expectedChatId: "chat-revoked",
      identityBindingStatus: "bound",
      destinationAddress: "chat-revoked",
      verificationPurpose: "trusted_contact",
    });

    // Requester enters the new code
    const result = validateAndConsumeChallenge(
      "telegram",
      session.secret,
      "user-revoked",
      "chat-revoked",
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.verificationType).toBe("trusted_contact");
    }

    // upsertContactChannel reactivates the existing record
    upsertContactChannel({
      sourceChannel: "telegram",
      externalUserId: "user-revoked",
      externalChatId: "chat-revoked",
      status: "active",
      policy: "allow",
    });

    // Verify: member is now active again
    const reactivatedResult = findContactChannel({
      channelType: "telegram",
      externalUserId: "user-revoked",
    });
    expect(reactivatedResult).not.toBeNull();
    expect(reactivatedResult!.channel.status).toBe("active");
    expect(reactivatedResult!.channel.policy).toBe("allow");
  });

  test("trusted contact verification does NOT create a guardian binding", () => {
    // Ensure there's an existing guardian binding we want to preserve
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "guardian-user-original",
      guardianDeliveryChatId: "guardian-chat-original",
      guardianPrincipalId: "guardian-user-original",
      verifiedVia: "challenge",
      metadataJson: null,
    });

    // Create an outbound session for a requester (different user than guardian)
    const session = createOutboundSession({
      channel: "telegram",
      expectedExternalUserId: "requester-user-789",
      expectedChatId: "requester-chat-789",
      identityBindingStatus: "bound",
      destinationAddress: "requester-chat-789",
      verificationPurpose: "trusted_contact",
    });

    const result = validateAndConsumeChallenge(
      "telegram",
      session.secret,
      "requester-user-789",
      "requester-chat-789",
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.verificationType).toBe("trusted_contact");
      // Should NOT have a bindingId — no guardian binding created
      expect("bindingId" in result).toBe(false);
    }

    // The original guardian binding should remain intact
    const guardianResult = findGuardianForChannel("telegram");
    expect(guardianResult).not.toBeNull();
    expect(guardianResult!.channel.externalUserId).toBe(
      "guardian-user-original",
    );
  });

  test("guardian inbound verification succeeds but does not create binding", async () => {
    // Create an inbound challenge (no expected identity — guardian flow)

    const { createVerificationChallenge } =
      await import("../runtime/channel-guardian-service.js");
    const { secret } = createVerificationChallenge("telegram");

    const result = validateAndConsumeChallenge(
      "telegram",
      secret,
      "guardian-user",
      "guardian-chat",
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.verificationType).toBe("guardian");
    }

    const guardianResult = findGuardianForChannel("telegram");
    expect(guardianResult).toBeNull();
  });
});
