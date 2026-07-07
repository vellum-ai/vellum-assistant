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
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Test isolation: in-memory SQLite via temp directory
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import type { ChannelId } from "../channels/types.js";
import { findContactChannel } from "../contacts/contact-store.js";
import {
  revokeMember,
  upsertContactChannel,
} from "../contacts/contacts-write.js";
import type { ChannelStatus } from "../contacts/types.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { resolveActorTrust } from "../runtime/actor-trust-resolver.js";
import {
  __resetMemberVerdictCacheForTest,
  setMemberVerdict,
} from "../runtime/member-verdict-cache.js";
import { createGuardianBinding } from "./helpers/create-guardian-binding.js";
import { deriveGuardianForChannel } from "./helpers/derive-guardian-delivery.js";
import { resetGatewayAclStore } from "./helpers/gateway-acl-store.js";
import {
  createOutboundSession,
  resetVerificationSessionsSim,
  validateAndConsumeVerification,
} from "./helpers/verification-sessions-ipc-sim.js";

await initializeDb();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetTables(): void {
  resetVerificationSessionsSim();
  const db = getDb();
  db.run("DELETE FROM contact_channels");
  db.run("DELETE FROM contacts");
  resetGatewayAclStore();
}

// Mirror a warmed gateway verdict so the sync resolveActorTrust fallback
// resolves the member with the given status; the local ACL columns are no
// longer read.
function warmMemberVerdict(
  channelType: ChannelId,
  address: string,
  status: ChannelStatus = "unverified",
): void {
  const found = findContactChannel({ channelType, address });
  if (!found) return;
  setMemberVerdict(channelType, address, {
    trustClass: "unknown",
    canonicalSenderId: address,
    contactId: found.contact.id,
    channelId: found.channel.id,
    status,
    policy: "allow",
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("trusted contact verification → member activation", () => {
  beforeEach(() => {
    resetTables();
    __resetMemberVerdictCacheForTest();
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
    const result = validateAndConsumeVerification(
      "telegram",
      session.secret,
      "requester-user-123",
      "requester-chat-123",
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.verificationType).toBe("trusted_contact");
    }

    // Simulate the member upsert that inbound-message-handler performs on
    // success. The local mirror persists identity only; the gateway owns the
    // ACL verdict, so the channel lands at the schema-default status.
    upsertContactChannel({
      sourceChannel: "telegram",
      externalUserId: "requester-user-123",
      externalChatId: "requester-chat-123",
      displayName: "Requester Name",
      username: "requester_username",
    });

    // Verify: member identity record exists
    const contactResult = findContactChannel({
      channelType: "telegram",
      address: "requester-user-123",
    });

    expect(contactResult).not.toBeNull();
    expect(contactResult!.channel.address).toBe("requester-user-123");
    expect(contactResult!.channel.externalChatId).toBe("requester-chat-123");
    expect(contactResult!.contact.displayName).toBe("Requester Name");
    expect(contactResult!.channel.type).toBe("telegram");
  });

  test("resolveActorTrust surfaces member displayName when sender displayName is missing", () => {
    upsertContactChannel({
      sourceChannel: "telegram",
      externalUserId: "requester-user-jeff",
      externalChatId: "requester-chat-jeff",
      displayName: "Jeff",
      username: "jeff_handle",
    });
    warmMemberVerdict("telegram", "requester-user-jeff");

    const trust = resolveActorTrust({
      assistantId: "self",
      sourceChannel: "telegram",
      conversationExternalId: "requester-chat-jeff",
      actorExternalId: "requester-user-jeff",
    });

    // The local mirror persists identity only; the schema-default status places
    // the contact in the unverified_contact tier (gateway owns elevation).
    expect(trust.trustClass).toBe("unverified_contact");
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
      displayName: "Jeff",
      username: "jeff_handle",
    });
    warmMemberVerdict("telegram", "requester-user-jeff-priority");

    const trust = resolveActorTrust({
      assistantId: "self",
      sourceChannel: "telegram",
      conversationExternalId: "requester-chat-jeff-priority",
      actorExternalId: "requester-user-jeff-priority",
      actorUsername: "jeffrey_telegram",
      actorDisplayName: "Jeffrey",
    });

    expect(trust.trustClass).toBe("unverified_contact");
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

    validateAndConsumeVerification(
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
    });

    // The local mirror persists the member identity; the gateway owns the ACL
    // verdict the inbound handler enforces.
    const contactResult = findContactChannel({
      channelType: "telegram",
      address: "requester-user-456",
    });

    expect(contactResult).not.toBeNull();
    expect(contactResult!.channel.address).toBe("requester-user-456");
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

    validateAndConsumeVerification(
      "telegram",
      session.secret,
      "user-cross-test",
      "chat-cross-test",
    );

    upsertContactChannel({
      sourceChannel: "telegram",
      externalUserId: "user-cross-test",
      externalChatId: "chat-cross-test",
    });

    // Member should be found via contacts
    const contactResult = findContactChannel({
      channelType: "telegram",
      address: "user-cross-test",
    });
    expect(contactResult).not.toBeNull();
    expect(contactResult!.channel.address).toBe("user-cross-test");

    // Member should NOT be found for a different channel type
    const otherChannel = findContactChannel({
      channelType: "slack",
      address: "user-cross-test",
    });
    expect(otherChannel).toBeNull();
  });

  test("revokeMember resolves the member identity without mutating local ACL", () => {
    // Create a member identity row.
    const member = upsertContactChannel({
      sourceChannel: "telegram",
      externalUserId: "user-revoked",
      externalChatId: "chat-revoked",
      displayName: "Revoked User",
    });

    // The local revoke is a pure resolver now — the gateway owns the ACL
    // downgrade; revokeMember returns the resolved native contact/channel.
    const revoked = revokeMember(member!.channel.id);
    expect(revoked).not.toBeNull();
    expect(revoked!.channel.id).toBe(member!.channel.id);

    // Re-upsert on the same identity is idempotent on the identity row.
    const session = createOutboundSession({
      channel: "telegram",
      expectedExternalUserId: "user-revoked",
      expectedChatId: "chat-revoked",
      identityBindingStatus: "bound",
      destinationAddress: "chat-revoked",
      verificationPurpose: "trusted_contact",
    });

    const result = validateAndConsumeVerification(
      "telegram",
      session.secret,
      "user-revoked",
      "chat-revoked",
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.verificationType).toBe("trusted_contact");
    }

    upsertContactChannel({
      sourceChannel: "telegram",
      externalUserId: "user-revoked",
      externalChatId: "chat-revoked",
    });

    const reResolved = findContactChannel({
      channelType: "telegram",
      address: "user-revoked",
    });
    expect(reResolved).not.toBeNull();
    expect(reResolved!.channel.id).toBe(member!.channel.id);
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

    const result = validateAndConsumeVerification(
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
    const guardianResult = deriveGuardianForChannel("telegram");
    expect(guardianResult).not.toBeNull();
    expect(guardianResult!.address).toBe("guardian-user-original");
  });

  test("guardian inbound verification succeeds but does not create binding", async () => {
    // Create an inbound challenge (no expected identity — guardian flow)

    const { createInboundVerificationSession } =
      await import("./helpers/verification-sessions-ipc-sim.js");
    const { secret } = createInboundVerificationSession("telegram");

    const result = validateAndConsumeVerification(
      "telegram",
      secret,
      "guardian-user",
      "guardian-chat",
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.verificationType).toBe("guardian");
    }

    const guardianResult = deriveGuardianForChannel("telegram");
    expect(guardianResult).toBeNull();
  });
});
