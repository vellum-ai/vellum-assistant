/**
 * Tests for address-based member resolution in resolveActorTrust.
 *
 * All member lookups use the canonical (type, address) path — the address
 * column is the sole identity for all channel types. Phone channels
 * registered by the inbound name-capture flow have `address` set (E.164)
 * and are discovered through the same path as every other channel.
 *
 * This suite verifies that address-based lookup returns the correct
 * `memberRecord` with the right ACL status so relay-setup-router
 * can emit the appropriate outcome (e.g. `unverified_caller`).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  ChannelPolicy,
  ChannelStatus,
  ContactRole,
} from "../contacts/types.js";

// ── Logger mock (suppress output) ───────────────────────────────────────────
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

// ── Contact store stubs — filled in per test ─────────────────────────────────
let _byAddress: ReturnType<
  (typeof import("../contacts/contact-store.js"))["findContactByAddress"]
> = null;
// ACL view is carried on memberRecord, sourced from the member-verdict cache.
// Seed it per test instead of seeding the DB.
let _acl: { status: ChannelStatus; policy: ChannelPolicy; role: ContactRole } =
  { status: "unverified", policy: "allow", role: "contact" };

mock.module("../contacts/contact-store.js", () => ({
  findContactByAddress: (_type: string, _addr: string) => _byAddress,
}));

// Guardian resolution reads the gateway delivery cache; these suites only
// exercise the member/address path, so the cache peek stays empty.
mock.module("../contacts/guardian-delivery-reader.js", () => ({
  peekCachedGuardianDelivery: () => undefined,
  guardianForChannel: () => undefined,
}));

// ── Real import after mocks ───────────────────────────────────────────────────
import type { ContactWithChannels } from "../contacts/types.js";
import { resolveActorTrust } from "../runtime/actor-trust-resolver.js";
import {
  __resetMemberVerdictCacheForTest,
  setMemberVerdict,
} from "../runtime/member-verdict-cache.js";

const CHANNEL_ID = "ch-test";
const CONTACT_ID = "contact-test";

// Seed the member-verdict cache so the sync fallback resolves the member with
// the configured ACL view (mirrors a warmed gateway verdict).
function seedAcl(): void {
  setMemberVerdict("phone", PHONE, {
    trustClass: _acl.role === "guardian" ? "guardian" : "unknown",
    canonicalSenderId: PHONE,
    contactId: CONTACT_ID,
    channelId: CHANNEL_ID,
    status: _acl.status,
    policy: _acl.policy,
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const PHONE = "+15559871234";

function makeContact(
  role: "guardian" | "contact" = "contact",
  status: "unverified" | "active" = "unverified",
): ContactWithChannels {
  // ACL lives on memberRecord (carrier), sourced from the member-verdict cache —
  // record the intended view so seedAcl() warms it before resolution.
  _acl = { status, policy: "allow", role };
  return {
    id: CONTACT_ID,
    displayName: "Patrick Test",
    notes: null,
    role,
    contactType: "human" as const,
    userFile: null,
    createdAt: 0,
    updatedAt: 0,
    channels: [
      {
        id: CHANNEL_ID,
        contactId: CONTACT_ID,
        type: "phone",
        address: PHONE,
        externalChatId: null,
        isPrimary: true,
        createdAt: 0,
        updatedAt: 0,
      },
    ],
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("resolveActorTrust — address fallback", () => {
  beforeEach(() => {
    _byAddress = null;
    _acl = { status: "unverified", policy: "allow", role: "contact" };
    __resetMemberVerdictCacheForTest();
  });

  test("finds unverified channel via address when externalUserId is null", () => {
    // Simulate a contact registered by name-capture: address set, externalUserId null.
    _byAddress = makeContact("contact", "unverified");
    seedAcl();

    const result = resolveActorTrust({
      assistantId: "asst-1",
      sourceChannel: "phone",
      conversationExternalId: PHONE,
      actorExternalId: PHONE,
    });

    expect(result.memberRecord).not.toBeNull();
    expect(result.memberRecord?.contact.displayName).toBe("Patrick Test");
    expect(result.memberRecord?.status).toBe("unverified");
    // trustClass is 'unverified_contact' for a member whose channel is
    // pending or unverified — known to the guardian but not yet verified.
    expect(result.trustClass).toBe("unverified_contact");
  });

  test("address lookup is the sole member resolution path", () => {
    _byAddress = makeContact("contact", "active");
    seedAcl();

    const result = resolveActorTrust({
      assistantId: "asst-1",
      sourceChannel: "phone",
      conversationExternalId: PHONE,
      actorExternalId: PHONE,
    });

    expect(result.memberRecord?.status).toBe("active");
    expect(result.memberRecord?.channel.address).toBe(PHONE);
  });

  test("returns null memberRecord when neither lookup finds the number", () => {
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

  test("fail-closed: contact found but verdict cache miss → unknown", () => {
    // The sync fallback runs only when there is no live verdict; with no cached
    // verdict either, the member stays unresolved and trust is fail-closed.
    _byAddress = makeContact("contact", "active");
    // No seedAcl() — the cache is a miss for this sender.

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
    _byAddress = makeContact("contact", "active");
    seedAcl();

    const result = resolveActorTrust({
      assistantId: "asst-1",
      sourceChannel: "phone",
      conversationExternalId: PHONE,
      actorExternalId: PHONE,
    });

    expect(result.memberRecord).not.toBeNull();
    expect(result.memberRecord?.status).toBe("active");
    expect(result.trustClass).toBe("trusted_contact");
  });

  test("pending-status member is classified as unverified_contact", () => {
    // Mirrors the unverified branch but for `pending` status (e.g. a phone
    // contact registered by name-capture awaiting the DTMF challenge).
    const contact = makeContact("contact", "unverified");
    // Override ACL status to "pending" — makeContact only accepts unverified/active.
    _acl = { ..._acl, status: "pending" };
    _byAddress = contact;
    seedAcl();

    const result = resolveActorTrust({
      assistantId: "asst-1",
      sourceChannel: "phone",
      conversationExternalId: PHONE,
      actorExternalId: PHONE,
    });

    expect(result.memberRecord?.status).toBe("pending");
    expect(result.trustClass).toBe("unverified_contact");
  });

  test("blocked-status member is classified as unknown (not unverified_contact)", () => {
    // Hard-deny statuses (blocked, revoked) stay `unknown` — admission-layer
    // re-checks channel status and emits the hard-deny reasons.
    const contact = makeContact("contact", "unverified");
    _acl = { ..._acl, status: "blocked" };
    _byAddress = contact;
    seedAcl();

    const result = resolveActorTrust({
      assistantId: "asst-1",
      sourceChannel: "phone",
      conversationExternalId: PHONE,
      actorExternalId: PHONE,
    });

    expect(result.memberRecord?.status).toBe("blocked");
    expect(result.trustClass).toBe("unknown");
  });

  test("revoked-status member is classified as unknown", () => {
    const contact = makeContact("contact", "unverified");
    _acl = { ..._acl, status: "revoked" };
    _byAddress = contact;
    seedAcl();

    const result = resolveActorTrust({
      assistantId: "asst-1",
      sourceChannel: "phone",
      conversationExternalId: PHONE,
      actorExternalId: PHONE,
    });

    expect(result.memberRecord?.status).toBe("revoked");
    expect(result.trustClass).toBe("unknown");
  });
});
