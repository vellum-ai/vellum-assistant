/**
 * Tests for Slack guardian trust resolution (M10).
 *
 * Verifies that when a Slack DM arrives from the bound guardian:
 * 1. Trust class is `guardian` (not `trusted_contact`)
 * 2. `guardianPrincipalId` is populated from the cross-channel principal
 * 3. `guardianDeliveryChatId` is set to the DM channel ID for reply delivery
 *
 * Also verifies the full verification → trust resolution round-trip for Slack,
 * including that createGuardianBindingContactsFirst stores the DM channel ID
 * as the delivery chat ID.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Test isolation: in-memory SQLite via temp directory
// ---------------------------------------------------------------------------

const testDir = mkdtempSync(
  join(tmpdir(), "slack-guardian-trust-resolution-test-"),
);

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
  readHttpToken: () => "test-bearer-token",
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { findGuardianForChannel } from "../contacts/contact-store.js";
import {
  createGuardianBindingContactsFirst,
  upsertMemberContactsFirst,
} from "../contacts/contacts-write.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import {
  resolveActorTrust,
  toTrustContext,
} from "../runtime/actor-trust-resolver.js";
import {
  createOutboundSession,
  getGuardianBinding,
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

describe("Slack guardian trust resolution", () => {
  beforeEach(() => {
    resetTables();
  });

  test("Slack guardian binding stores DM channel ID as delivery chat ID", () => {
    const binding = createGuardianBindingContactsFirst({
      assistantId: "self",
      channel: "slack",
      guardianExternalUserId: "U_GUARDIAN_1",
      guardianDeliveryChatId: "D_DM_CHANNEL_1",
      guardianPrincipalId: "principal-abc",
      verifiedVia: "challenge",
    });

    expect(binding.guardianDeliveryChatId).toBe("D_DM_CHANNEL_1");
    expect(binding.guardianExternalUserId).toBe("U_GUARDIAN_1");
    expect(binding.guardianPrincipalId).toBe("principal-abc");

    // Verify the stored contact channel also has the correct externalChatId
    const stored = findGuardianForChannel("slack", "self");
    expect(stored).not.toBeNull();
    expect(stored!.channel.externalChatId).toBe("D_DM_CHANNEL_1");
    expect(stored!.channel.externalUserId).toBe("U_GUARDIAN_1");
    expect(stored!.contact.principalId).toBe("principal-abc");
  });

  test("Slack DM from bound guardian resolves trust class as guardian", () => {
    createGuardianBindingContactsFirst({
      assistantId: "self",
      channel: "slack",
      guardianExternalUserId: "U_GUARDIAN_1",
      guardianDeliveryChatId: "D_DM_CHANNEL_1",
      guardianPrincipalId: "principal-abc",
      verifiedVia: "challenge",
    });

    const trust = resolveActorTrust({
      assistantId: "self",
      sourceChannel: "slack",
      conversationExternalId: "D_DM_CHANNEL_1",
      actorExternalId: "U_GUARDIAN_1",
      actorUsername: "guardian_user",
      actorDisplayName: "Guardian User",
    });

    expect(trust.trustClass).toBe("guardian");
    expect(trust.canonicalSenderId).toBe("U_GUARDIAN_1");
    expect(trust.guardianPrincipalId).toBe("principal-abc");
    expect(trust.guardianBindingMatch).not.toBeNull();
    expect(trust.guardianBindingMatch!.guardianDeliveryChatId).toBe(
      "D_DM_CHANNEL_1",
    );
    expect(trust.guardianBindingMatch!.guardianExternalUserId).toBe(
      "U_GUARDIAN_1",
    );
  });

  test("toTrustContext populates guardianChatId with delivery chat ID for Slack guardian", () => {
    createGuardianBindingContactsFirst({
      assistantId: "self",
      channel: "slack",
      guardianExternalUserId: "U_GUARDIAN_1",
      guardianDeliveryChatId: "D_DM_CHANNEL_1",
      guardianPrincipalId: "principal-abc",
      verifiedVia: "challenge",
    });

    const trust = resolveActorTrust({
      assistantId: "self",
      sourceChannel: "slack",
      conversationExternalId: "D_DM_CHANNEL_1",
      actorExternalId: "U_GUARDIAN_1",
    });

    const ctx = toTrustContext(trust, "D_DM_CHANNEL_1");

    expect(ctx.trustClass).toBe("guardian");
    expect(ctx.guardianChatId).toBe("D_DM_CHANNEL_1");
    expect(ctx.guardianExternalUserId).toBe("U_GUARDIAN_1");
    expect(ctx.guardianPrincipalId).toBe("principal-abc");
    expect(ctx.requesterExternalUserId).toBe("U_GUARDIAN_1");
    expect(ctx.requesterChatId).toBe("D_DM_CHANNEL_1");
    expect(ctx.sourceChannel).toBe("slack");
  });

  test("guardianPrincipalId is populated from cross-channel principal (vellum binding)", () => {
    // Simulate: vellum guardian binding exists with principal-from-vellum
    createGuardianBindingContactsFirst({
      assistantId: "self",
      channel: "vellum",
      guardianExternalUserId: "vellum-user-1",
      guardianDeliveryChatId: "vellum-chat-1",
      guardianPrincipalId: "principal-from-vellum",
      verifiedVia: "auto",
    });

    // Slack guardian binding shares the same principal
    createGuardianBindingContactsFirst({
      assistantId: "self",
      channel: "slack",
      guardianExternalUserId: "U_GUARDIAN_1",
      guardianDeliveryChatId: "D_DM_CHANNEL_1",
      guardianPrincipalId: "principal-from-vellum",
      verifiedVia: "challenge",
    });

    const trust = resolveActorTrust({
      assistantId: "self",
      sourceChannel: "slack",
      conversationExternalId: "D_DM_CHANNEL_1",
      actorExternalId: "U_GUARDIAN_1",
    });

    expect(trust.trustClass).toBe("guardian");
    expect(trust.guardianPrincipalId).toBe("principal-from-vellum");

    const ctx = toTrustContext(trust, "D_DM_CHANNEL_1");
    expect(ctx.guardianPrincipalId).toBe("principal-from-vellum");
  });

  test("Slack DM from non-guardian user resolves as unknown (not guardian)", () => {
    createGuardianBindingContactsFirst({
      assistantId: "self",
      channel: "slack",
      guardianExternalUserId: "U_GUARDIAN_1",
      guardianDeliveryChatId: "D_DM_CHANNEL_1",
      guardianPrincipalId: "principal-abc",
      verifiedVia: "challenge",
    });

    const trust = resolveActorTrust({
      assistantId: "self",
      sourceChannel: "slack",
      conversationExternalId: "D_OTHER_DM_CHANNEL",
      actorExternalId: "U_OTHER_USER",
    });

    expect(trust.trustClass).toBe("unknown");
    expect(trust.guardianPrincipalId).toBe("principal-abc");
    expect(trust.guardianBindingMatch).not.toBeNull();
    // Guardian binding info is still available even for non-guardian actors
    expect(trust.guardianBindingMatch!.guardianExternalUserId).toBe(
      "U_GUARDIAN_1",
    );
  });

  test("Slack DM from trusted contact resolves as trusted_contact (not guardian)", () => {
    createGuardianBindingContactsFirst({
      assistantId: "self",
      channel: "slack",
      guardianExternalUserId: "U_GUARDIAN_1",
      guardianDeliveryChatId: "D_DM_CHANNEL_1",
      guardianPrincipalId: "principal-abc",
      verifiedVia: "challenge",
    });

    // Add a trusted contact member
    upsertMemberContactsFirst({
      sourceChannel: "slack",
      externalUserId: "U_CONTACT_1",
      externalChatId: "D_CONTACT_DM",
      status: "active",
      policy: "allow",
      displayName: "Trusted Contact",
    });

    const trust = resolveActorTrust({
      assistantId: "self",
      sourceChannel: "slack",
      conversationExternalId: "D_CONTACT_DM",
      actorExternalId: "U_CONTACT_1",
    });

    expect(trust.trustClass).toBe("trusted_contact");
    // Guardian context is still available for routing
    expect(trust.guardianPrincipalId).toBe("principal-abc");
  });

  test("full Slack outbound verification → guardian binding → trust resolution round-trip", () => {
    // Step 1: Create outbound verification session targeting a Slack user
    const session = createOutboundSession({
      assistantId: "self",
      channel: "slack",
      expectedExternalUserId: "U_GUARDIAN_1",
      expectedChatId: "U_GUARDIAN_1",
      identityBindingStatus: "bound",
      destinationAddress: "U_GUARDIAN_1",
    });

    expect(session.secret).toBeTruthy();

    // Step 2: Simulate the Slack user entering the verification code in their DM
    // Note: actorChatId is the DM channel ID, not the user ID
    const verifyResult = validateAndConsumeChallenge(
      "self",
      "slack",
      session.secret,
      "U_GUARDIAN_1", // actorExternalUserId
      "D_DM_CHANNEL_1", // actorChatId (DM channel ID from Slack)
      "guardian_user",
      "Guardian User",
    );

    expect(verifyResult.success).toBe(true);
    if (verifyResult.success) {
      expect(verifyResult.verificationType).toBe("guardian");
    }

    // Step 3: Verify the guardian binding was created with correct DM channel ID
    const binding = getGuardianBinding("self", "slack");
    expect(binding).not.toBeNull();
    expect(binding!.guardianExternalUserId).toBe("U_GUARDIAN_1");
    expect(binding!.guardianDeliveryChatId).toBe("D_DM_CHANNEL_1");

    // Step 4: Simulate an inbound Slack DM from the guardian
    const trust = resolveActorTrust({
      assistantId: "self",
      sourceChannel: "slack",
      conversationExternalId: "D_DM_CHANNEL_1",
      actorExternalId: "U_GUARDIAN_1",
      actorUsername: "guardian_user",
      actorDisplayName: "Guardian User",
    });

    expect(trust.trustClass).toBe("guardian");
    expect(trust.guardianPrincipalId).toBeDefined();
    expect(trust.guardianBindingMatch!.guardianDeliveryChatId).toBe(
      "D_DM_CHANNEL_1",
    );

    // Step 5: Verify TrustContext has correct fields for reply delivery
    const ctx = toTrustContext(trust, "D_DM_CHANNEL_1");
    expect(ctx.trustClass).toBe("guardian");
    expect(ctx.guardianChatId).toBe("D_DM_CHANNEL_1");
    expect(ctx.guardianExternalUserId).toBe("U_GUARDIAN_1");
    expect(ctx.guardianPrincipalId).toBeDefined();
    expect(ctx.sourceChannel).toBe("slack");
  });

  test("Slack guardian from different DM channel still resolves as guardian", () => {
    // Guardian was verified in DM channel D_DM_CHANNEL_1
    createGuardianBindingContactsFirst({
      assistantId: "self",
      channel: "slack",
      guardianExternalUserId: "U_GUARDIAN_1",
      guardianDeliveryChatId: "D_DM_CHANNEL_1",
      guardianPrincipalId: "principal-abc",
      verifiedVia: "challenge",
    });

    // Guardian sends a message from a different channel (e.g., a Slack channel
    // where the bot is mentioned). The user ID still matches.
    const trust = resolveActorTrust({
      assistantId: "self",
      sourceChannel: "slack",
      conversationExternalId: "C_SOME_CHANNEL",
      actorExternalId: "U_GUARDIAN_1",
    });

    expect(trust.trustClass).toBe("guardian");

    // guardianChatId should be the stored DM channel ID (from the binding),
    // not the current conversationExternalId
    const ctx = toTrustContext(trust, "C_SOME_CHANNEL");
    expect(ctx.guardianChatId).toBe("D_DM_CHANNEL_1");
    expect(ctx.requesterChatId).toBe("C_SOME_CHANNEL");
  });

  test("no guardian binding → unknown trust class for Slack DM", () => {
    const trust = resolveActorTrust({
      assistantId: "self",
      sourceChannel: "slack",
      conversationExternalId: "D_DM_CHANNEL_1",
      actorExternalId: "U_SOME_USER",
    });

    expect(trust.trustClass).toBe("unknown");
    expect(trust.guardianBindingMatch).toBeNull();
    expect(trust.guardianPrincipalId).toBeUndefined();
    expect(trust.denialReason).toBe("no_binding");
  });

  test("Slack guardian metadata flows through trust resolution", () => {
    createGuardianBindingContactsFirst({
      assistantId: "self",
      channel: "slack",
      guardianExternalUserId: "U_GUARDIAN_1",
      guardianDeliveryChatId: "D_DM_CHANNEL_1",
      guardianPrincipalId: "principal-abc",
      verifiedVia: "challenge",
      metadataJson: JSON.stringify({ displayName: "Guardian User" }),
    });

    const trust = resolveActorTrust({
      assistantId: "self",
      sourceChannel: "slack",
      conversationExternalId: "D_DM_CHANNEL_1",
      actorExternalId: "U_GUARDIAN_1",
      actorUsername: "guardian_slack_handle",
      actorDisplayName: "Guardian Slack Name",
    });

    expect(trust.trustClass).toBe("guardian");
    expect(trust.actorMetadata.channel).toBe("slack");
    expect(trust.actorMetadata.trustStatus).toBe("guardian");
    // Member metadata (from contact) takes priority over sender metadata
    expect(trust.actorMetadata.memberDisplayName).toBe("Guardian User");
  });
});
