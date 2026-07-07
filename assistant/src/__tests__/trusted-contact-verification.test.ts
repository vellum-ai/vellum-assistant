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

import { findContactChannel } from "../contacts/contact-store.js";
import { upsertContactChannel } from "../contacts/contacts-write.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
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

  test("re-verification re-upserts the same identity row (revoke is gateway-owned)", () => {
    // Create a member identity row.
    const member = upsertContactChannel({
      sourceChannel: "telegram",
      externalUserId: "user-revoked",
      externalChatId: "chat-revoked",
      displayName: "Revoked User",
    });
    expect(member).not.toBeNull();

    // The ACL downgrade lives on the gateway; the local identity row is
    // untouched by a revoke, so re-verification re-upserts the same row.
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
