/**
 * Tests for the address-fallback path in resolveActorTrust.
 *
 * Phone channels registered by the inbound name-capture flow have `address`
 * set (E.164) but `externalUserId` = NULL until DTMF verification completes.
 * The primary `findContactByChannelExternalId` lookup misses these channels,
 * which historically caused the relay router to fall into the name-capture
 * ("I don't recognize this number") path instead of the unverified-caller
 * guidance path.
 *
 * This suite verifies that the address-based fallback fires correctly and
 * that the returned `memberRecord` carries the right channel/status so
 * relay-setup-router can emit the `unverified_caller` outcome.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Logger mock (suppress output) ───────────────────────────────────────────
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

// ── Contact store stubs — filled in per test ─────────────────────────────────
let _byExternalId: ReturnType<
  typeof import("../contacts/contact-store.js")["findContactByChannelExternalId"]
> = null;
let _byAddress: ReturnType<
  typeof import("../contacts/contact-store.js")["findContactByAddress"]
> = null;
let _guardian: ReturnType<
  typeof import("../contacts/contact-store.js")["findGuardianForChannel"]
> = null;

mock.module("../contacts/contact-store.js", () => ({
  findContactByChannelExternalId: (_type: string, _id: string) => _byExternalId,
  findContactByAddress: (_type: string, _addr: string) => _byAddress,
  findGuardianForChannel: (_channel: string) => _guardian,
}));

// ── Real import after mocks ───────────────────────────────────────────────────
import type { ContactWithChannels } from "../contacts/types.js";
import { resolveActorTrust } from "../runtime/actor-trust-resolver.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const PHONE = "+15559871234";

function makeContact(
  role: "guardian" | "contact" = "contact",
  status: "unverified" | "active" = "unverified",
  externalUserId: string | null = null,
): ContactWithChannels {
  const channelId = "ch-test";
  return {
    id: "contact-test",
    displayName: "Patrick Test",
    role,
    principalId: null,
    notes: null,
    lastInteraction: null,
    interactionCount: 0,
    contactType: "human" as const,
    userFile: null,
    createdAt: 0,
    updatedAt: 0,
    channels: [
      {
        id: channelId,
        contactId: "contact-test",
        type: "phone",
        address: PHONE.toLowerCase(),
        externalUserId,
        externalChatId: null,
        isPrimary: true,
        status,
        policy: "allow",
        verifiedAt: null,
        verifiedVia: null,
        revokedReason: null,
        blockedReason: null,
        interactionCount: 0,
        lastInteraction: null,
        lastSeenAt: null,
        inviteId: null,
        createdAt: 0,
        updatedAt: 0,
      },
    ],
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("resolveActorTrust — address fallback", () => {
  beforeEach(() => {
    _byExternalId = null;
    _byAddress = null;
    _guardian = null;
  });

  test("finds unverified channel via address when externalUserId is null", () => {
    // Simulate a contact registered by name-capture: address set, externalUserId null.
    _byAddress = makeContact("contact", "unverified", null);

    const result = resolveActorTrust({
      assistantId: "asst-1",
      sourceChannel: "phone",
      conversationExternalId: PHONE,
      actorExternalId: PHONE,
    });

    expect(result.memberRecord).not.toBeNull();
    expect(result.memberRecord?.contact.displayName).toBe("Patrick Test");
    expect(result.memberRecord?.channel.status).toBe("unverified");
    // trustClass is 'unverified_contact' for a member whose channel is
    // pending or unverified — known to the guardian but not yet verified.
    expect(result.trustClass).toBe("unverified_contact");
  });

  test("externalUserId path takes priority over address path", () => {
    // Both lookups return a contact; the externalUserId one should win.
    const primaryContact = makeContact("contact", "active", PHONE);
    const addressContact = makeContact("contact", "unverified", null);
    _byExternalId = primaryContact;
    _byAddress = addressContact;

    const result = resolveActorTrust({
      assistantId: "asst-1",
      sourceChannel: "phone",
      conversationExternalId: PHONE,
      actorExternalId: PHONE,
    });

    expect(result.memberRecord?.channel.status).toBe("active");
    expect(result.memberRecord?.channel.externalUserId).toBe(PHONE);
  });

  test("returns null memberRecord when neither lookup finds the number", () => {
    _byExternalId = null;
    _byAddress = null;

    const result = resolveActorTrust({
      assistantId: "asst-1",
      sourceChannel: "phone",
      conversationExternalId: PHONE,
      actorExternalId: PHONE,
    });

    expect(result.memberRecord).toBeNull();
    expect(result.trustClass).toBe("unknown");
  });

  test("address-found active channel elevates trust to trusted_contact", () => {
    // An active channel found via address (e.g. after manual verify without externalUserId set)
    // should still yield trusted_contact trust class.
    _byAddress = makeContact("contact", "active", null);

    const result = resolveActorTrust({
      assistantId: "asst-1",
      sourceChannel: "phone",
      conversationExternalId: PHONE,
      actorExternalId: PHONE,
    });

    expect(result.memberRecord).not.toBeNull();
    expect(result.memberRecord?.channel.status).toBe("active");
    expect(result.trustClass).toBe("trusted_contact");
  });

  test("pending-status member is classified as unverified_contact", () => {
    // Mirrors the unverified branch but for `pending` status (e.g. a phone
    // contact registered by name-capture awaiting the DTMF challenge).
    const contact = makeContact("contact", "unverified", PHONE);
    // Override status to "pending" — makeContact only accepts unverified/active
    contact.channels[0]!.status = "pending";
    _byExternalId = contact;

    const result = resolveActorTrust({
      assistantId: "asst-1",
      sourceChannel: "phone",
      conversationExternalId: PHONE,
      actorExternalId: PHONE,
    });

    expect(result.memberRecord?.channel.status).toBe("pending");
    expect(result.trustClass).toBe("unverified_contact");
  });

  test("blocked-status member is classified as unknown (not unverified_contact)", () => {
    // Hard-deny statuses (blocked, revoked) stay `unknown` — admission-layer
    // re-checks channel.status and emits the hard-deny reasons.
    const contact = makeContact("contact", "unverified", PHONE);
    contact.channels[0]!.status = "blocked";
    _byExternalId = contact;

    const result = resolveActorTrust({
      assistantId: "asst-1",
      sourceChannel: "phone",
      conversationExternalId: PHONE,
      actorExternalId: PHONE,
    });

    expect(result.memberRecord?.channel.status).toBe("blocked");
    expect(result.trustClass).toBe("unknown");
  });

  test("revoked-status member is classified as unknown", () => {
    const contact = makeContact("contact", "unverified", PHONE);
    contact.channels[0]!.status = "revoked";
    _byExternalId = contact;

    const result = resolveActorTrust({
      assistantId: "asst-1",
      sourceChannel: "phone",
      conversationExternalId: PHONE,
      actorExternalId: PHONE,
    });

    expect(result.memberRecord?.channel.status).toBe("revoked");
    expect(result.trustClass).toBe("unknown");
  });
});
