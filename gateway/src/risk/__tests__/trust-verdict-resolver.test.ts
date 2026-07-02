/**
 * Tests for the gateway-side per-actor trust verdict resolver.
 *
 * Seeds the gateway ACL DB directly (contacts + contact_channels) and asserts
 * the resolved {@link TrustVerdict} for guardian / trusted / unverified /
 * unknown / blocked actors, plus id-divergence and case-insensitive address
 * matching.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

await import("../../__tests__/test-preload.js");
const { initGatewayDb, resetGatewayDb, getGatewayDb } =
  await import("../../db/connection.js");
const { contacts: gwContacts, contactChannels: gwContactChannels } =
  await import("../../db/schema.js");
const { resolveTrustVerdict } = await import("../trust-verdict-resolver.js");

const CHANNEL = "telegram";

function insertContact(args: {
  id: string;
  displayName: string;
  role?: string;
  principalId?: string;
}): void {
  const now = Date.now();
  getGatewayDb()
    .insert(gwContacts)
    .values({
      id: args.id,
      displayName: args.displayName,
      role: args.role ?? "contact",
      principalId: args.principalId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function insertChannel(args: {
  id: string;
  contactId: string;
  type?: string;
  address: string;
  externalChatId?: string | null;
  status?: string;
  policy?: string;
  verifiedAt?: number | null;
  verifiedVia?: string | null;
}): void {
  const now = Date.now();
  getGatewayDb()
    .insert(gwContactChannels)
    .values({
      id: args.id,
      contactId: args.contactId,
      type: args.type ?? CHANNEL,
      address: args.address,
      externalChatId: args.externalChatId ?? null,
      status: args.status ?? "active",
      policy: args.policy ?? "allow",
      verifiedAt: args.verifiedAt ?? now,
      verifiedVia: args.verifiedVia ?? "challenge",
      interactionCount: 0,
      createdAt: now,
    })
    .run();
}

beforeEach(async () => {
  resetGatewayDb();
  await initGatewayDb();
  // initGatewayDb reconnects to the same on-disk DB, so clear any rows a
  // prior test left behind (channels first — FK cascade from contacts).
  getGatewayDb().delete(gwContactChannels).run();
  getGatewayDb().delete(gwContacts).run();
});

afterEach(() => {
  resetGatewayDb();
});

describe("resolveTrustVerdict", () => {
  test("guardian actor → trustClass guardian, guardian fields populated", async () => {
    insertContact({
      id: "c-guardian",
      displayName: "The Guardian",
      role: "guardian",
      principalId: "principal-1",
    });
    insertChannel({
      id: "ch-guardian",
      contactId: "c-guardian",
      address: "U_GUARDIAN",
      externalChatId: "chat-guardian",
      status: "active",
    });

    const verdict = await resolveTrustVerdict({
      channelType: CHANNEL,
      actorExternalId: "U_GUARDIAN",
    });

    expect(verdict.trustClass).toBe("guardian");
    expect(verdict.canonicalSenderId).toBe("U_GUARDIAN");
    expect(verdict.guardianExternalUserId).toBe("U_GUARDIAN");
    expect(verdict.guardianDeliveryChatId).toBe("chat-guardian");
    expect(verdict.guardianPrincipalId).toBe("principal-1");
    expect(verdict.guardianDisplayName).toBe("The Guardian");
    expect(verdict.contactId).toBe("c-guardian");
    expect(verdict.status).toBe("active");
  });

  test("active non-guardian member → trusted_contact, member ACL fields populated", async () => {
    insertContact({
      id: "c-guardian",
      displayName: "Guardian",
      role: "guardian",
      principalId: "principal-1",
    });
    insertChannel({
      id: "ch-guardian",
      contactId: "c-guardian",
      address: "U_GUARDIAN",
    });
    insertContact({ id: "c-member", displayName: "Trusted Member" });
    insertChannel({
      id: "ch-member",
      contactId: "c-member",
      address: "U_MEMBER",
      externalChatId: "chat-member",
      status: "active",
      verifiedVia: "manual",
    });

    const verdict = await resolveTrustVerdict({
      channelType: CHANNEL,
      actorExternalId: "U_MEMBER",
    });

    expect(verdict.trustClass).toBe("trusted_contact");
    expect(verdict.status).toBe("active");
    expect(verdict.policy).toBe("allow");
    expect(verdict.contactId).toBe("c-member");
    expect(verdict.channelId).toBe("ch-member");
    expect(verdict.address).toBe("U_MEMBER");
    expect(verdict.externalChatId).toBe("chat-member");
    expect(verdict.memberDisplayName).toBe("Trusted Member");
    expect(verdict.verifiedVia).toBe("manual");
    // Guardian fields still populated from the channel binding.
    expect(verdict.guardianExternalUserId).toBe("U_GUARDIAN");
  });

  test("pending/unverified member → unverified_contact", async () => {
    insertContact({ id: "c-member", displayName: "Pending Member" });
    insertChannel({
      id: "ch-member",
      contactId: "c-member",
      address: "U_PENDING",
      status: "unverified",
      verifiedAt: null,
      verifiedVia: null,
    });

    const verdict = await resolveTrustVerdict({
      channelType: CHANNEL,
      actorExternalId: "U_PENDING",
    });

    expect(verdict.trustClass).toBe("unverified_contact");
    expect(verdict.status).toBe("unverified");
    expect(verdict.contactId).toBe("c-member");
  });

  test("no matching channel → unknown, canonicalSenderId reflects input, member fields undefined", async () => {
    const verdict = await resolveTrustVerdict({
      channelType: CHANNEL,
      actorExternalId: "U_STRANGER",
    });

    expect(verdict.trustClass).toBe("unknown");
    expect(verdict.canonicalSenderId).toBe("U_STRANGER");
    expect(verdict.contactId).toBeUndefined();
    expect(verdict.channelId).toBeUndefined();
    expect(verdict.status).toBeUndefined();
    expect(verdict.guardianExternalUserId).toBeUndefined();
  });

  test("no actorExternalId → unknown, canonicalSenderId null", async () => {
    const verdict = await resolveTrustVerdict({ channelType: CHANNEL });
    expect(verdict.trustClass).toBe("unknown");
    expect(verdict.canonicalSenderId).toBeNull();
  });

  test("blocked member → unknown, status/policy surfaced verbatim", async () => {
    insertContact({ id: "c-blocked", displayName: "Blocked Member" });
    insertChannel({
      id: "ch-blocked",
      contactId: "c-blocked",
      address: "U_BLOCKED",
      status: "blocked",
      policy: "deny",
    });

    const verdict = await resolveTrustVerdict({
      channelType: CHANNEL,
      actorExternalId: "U_BLOCKED",
    });

    // Mirrors the canonical resolver: blocked → unknown. Raw status/policy
    // still carry through so the consumer enforces member_blocked hard-deny.
    expect(verdict.trustClass).toBe("unknown");
    expect(verdict.status).toBe("blocked");
    expect(verdict.policy).toBe("deny");
    expect(verdict.contactId).toBe("c-blocked");
  });

  test("revoked member → unknown, status/policy surfaced verbatim", async () => {
    insertContact({ id: "c-revoked", displayName: "Revoked Member" });
    insertChannel({
      id: "ch-revoked",
      contactId: "c-revoked",
      address: "U_REVOKED",
      status: "revoked",
      policy: "deny",
    });

    const verdict = await resolveTrustVerdict({
      channelType: CHANNEL,
      actorExternalId: "U_REVOKED",
    });

    expect(verdict.trustClass).toBe("unknown");
    expect(verdict.status).toBe("revoked");
    expect(verdict.policy).toBe("deny");
    expect(verdict.contactId).toBe("c-revoked");
  });

  test("id-divergent row resolves by (type,address)", async () => {
    // Channel id intentionally unrelated to any assistant-side id — lookup is
    // keyed on (type,address), so it still resolves.
    insertContact({ id: "gw-only-contact", displayName: "Mirror Member" });
    insertChannel({
      id: "gw-only-channel-id-9999",
      contactId: "gw-only-contact",
      address: "U_DIVERGENT",
      status: "active",
    });

    const verdict = await resolveTrustVerdict({
      channelType: CHANNEL,
      actorExternalId: "U_DIVERGENT",
    });

    expect(verdict.trustClass).toBe("trusted_contact");
    expect(verdict.channelId).toBe("gw-only-channel-id-9999");
    expect(verdict.contactId).toBe("gw-only-contact");
  });

  test("case-insensitive address match (COLLATE NOCASE)", async () => {
    insertContact({ id: "c-member", displayName: "Case Member" });
    insertChannel({
      id: "ch-member",
      contactId: "c-member",
      address: "U_MixedCase",
      status: "active",
    });

    const verdict = await resolveTrustVerdict({
      channelType: CHANNEL,
      actorExternalId: "u_mixedcase",
    });

    expect(verdict.trustClass).toBe("trusted_contact");
    expect(verdict.channelId).toBe("ch-member");
  });

  test("sender matching the active guardian binding address → guardian", async () => {
    insertContact({
      id: "c-guardian",
      displayName: "Guardian",
      role: "guardian",
      principalId: "principal-1",
    });
    insertChannel({
      id: "ch-guardian",
      contactId: "c-guardian",
      address: "U_GUARDIAN_ACTIVE",
      status: "active",
    });

    const verdict = await resolveTrustVerdict({
      channelType: CHANNEL,
      actorExternalId: "U_GUARDIAN_ACTIVE",
    });

    expect(verdict.trustClass).toBe("guardian");
  });

  test("memberless sender whose address collides with the guardian's address on another channel type stays unknown", async () => {
    // ATL-958 regression: external identifiers are channel-local namespaces.
    // A telegram sender with NO telegram member row whose id happens to equal
    // the guardian's vellum address is NOT the guardian — raw cross-channel
    // address equality must never confer the class (it would grant
    // self-approval, unsandboxed shell, and memory access to a spoofable id).
    insertContact({
      id: "c-guardian",
      displayName: "Principal Guardian",
      role: "guardian",
      principalId: "principal-1",
    });
    insertChannel({
      id: "ch-guardian-vellum",
      contactId: "c-guardian",
      type: "vellum",
      address: "GUARDIAN_ID",
      status: "active",
    });

    const verdict = await resolveTrustVerdict({
      channelType: CHANNEL,
      actorExternalId: "GUARDIAN_ID",
    });

    expect(verdict.trustClass).toBe("unknown");
    expect(verdict.resolutionFailed).toBeUndefined();
    expect(verdict.guardianPrincipalId).toBeUndefined();
    expect(verdict.guardianDisplayName).toBeUndefined();
    expect(verdict.guardianExternalUserId).toBeUndefined();
    expect(verdict.contactId).toBeUndefined();
  });

  test("guardian with a pending same-channel row + active binding elsewhere → guardian, not unverified_contact", async () => {
    insertContact({
      id: "c-guardian",
      displayName: "Pending-Channel Guardian",
      role: "guardian",
      principalId: "principal-1",
    });
    insertChannel({
      id: "ch-guardian-vellum",
      contactId: "c-guardian",
      type: "vellum",
      address: "GUARDIAN_ANCHOR",
      status: "active",
    });
    insertChannel({
      id: "ch-guardian-telegram",
      contactId: "c-guardian",
      address: "U_GUARDIAN_TG",
      status: "pending",
      verifiedAt: null,
      verifiedVia: null,
    });

    const verdict = await resolveTrustVerdict({
      channelType: CHANNEL,
      actorExternalId: "U_GUARDIAN_TG",
    });

    expect(verdict.trustClass).toBe("guardian");
    expect(verdict.guardianPrincipalId).toBe("principal-1");
    // The same-channel member row still surfaces verbatim.
    expect(verdict.contactId).toBe("c-guardian");
    expect(verdict.status).toBe("pending");
  });

  test("guardian with a blocked same-channel row stays unknown despite an active binding elsewhere", async () => {
    // An explicit per-channel block wins over the principal-level check.
    insertContact({
      id: "c-guardian",
      displayName: "Blocked-Channel Guardian",
      role: "guardian",
      principalId: "principal-1",
    });
    insertChannel({
      id: "ch-guardian-vellum",
      contactId: "c-guardian",
      type: "vellum",
      address: "GUARDIAN_ANCHOR",
      status: "active",
    });
    insertChannel({
      id: "ch-guardian-telegram",
      contactId: "c-guardian",
      address: "U_GUARDIAN_TG",
      status: "blocked",
      policy: "deny",
    });

    const verdict = await resolveTrustVerdict({
      channelType: CHANNEL,
      actorExternalId: "U_GUARDIAN_TG",
    });

    expect(verdict.trustClass).toBe("unknown");
    expect(verdict.status).toBe("blocked");
  });

  test("guardian identity via a pending member row with a NULL principal is unresolved → resolutionFailed, not guardian", async () => {
    // Pre-cutover artifact: the sender's same-channel row belongs to a
    // guardian contact that has no principal. Classifying `guardian` would
    // confer self-approving capabilities with nothing to authorize decisions
    // against; classifying plain `unknown` would route the guardian through
    // the stranger lane. The verdict is could-not-vouch instead: the
    // consumer soft-denies with no stranger-lane side effects.
    insertContact({
      id: "c-guardian",
      displayName: "Principal-less Guardian",
      role: "guardian",
    });
    insertChannel({
      id: "ch-guardian-vellum",
      contactId: "c-guardian",
      type: "vellum",
      address: "GUARDIAN_ANCHOR",
      status: "active",
    });
    insertChannel({
      id: "ch-guardian-telegram",
      contactId: "c-guardian",
      address: "U_GUARDIAN_TG",
      status: "pending",
      verifiedAt: null,
      verifiedVia: null,
    });

    const verdict = await resolveTrustVerdict({
      channelType: CHANNEL,
      actorExternalId: "U_GUARDIAN_TG",
    });

    expect(verdict.trustClass).toBe("unknown");
    expect(verdict.resolutionFailed).toBe(true);
  });

  test("guardian whose only channel is revoked does not re-acquire guardian via the principal check", async () => {
    insertContact({
      id: "c-old-guardian",
      displayName: "Fully Revoked Guardian",
      role: "guardian",
      principalId: "principal-old",
    });
    insertChannel({
      id: "ch-old-guardian-vellum",
      contactId: "c-old-guardian",
      type: "vellum",
      address: "OLD_GUARDIAN_ID",
      status: "revoked",
      policy: "deny",
    });

    // Sender matches the revoked vellum address on telegram (no telegram
    // row): a memberless sender is a stranger — and even with a row, the
    // principal-level check requires an ACTIVE guardian channel → unknown.
    const verdict = await resolveTrustVerdict({
      channelType: CHANNEL,
      actorExternalId: "OLD_GUARDIAN_ID",
    });

    expect(verdict.trustClass).toBe("unknown");
    expect(verdict.guardianPrincipalId).toBeUndefined();
  });

  test("active non-guardian member whose address matches nothing guardian stays trusted_contact", async () => {
    // Guard against the principal check widening: a plain member is never
    // upgraded by it.
    insertContact({
      id: "c-guardian",
      displayName: "Guardian",
      role: "guardian",
      principalId: "principal-1",
    });
    insertChannel({
      id: "ch-guardian-vellum",
      contactId: "c-guardian",
      type: "vellum",
      address: "GUARDIAN_ANCHOR",
      status: "active",
    });
    insertContact({ id: "c-member", displayName: "Plain Member" });
    insertChannel({
      id: "ch-member",
      contactId: "c-member",
      address: "U_MEMBER",
      status: "active",
    });

    const verdict = await resolveTrustVerdict({
      channelType: CHANNEL,
      actorExternalId: "U_MEMBER",
    });

    expect(verdict.trustClass).toBe("trusted_contact");
  });

  test("revoked guardian channel does NOT confer guardian → unknown", async () => {
    // P1 regression: a guardian contact whose only channel is revoked must not
    // re-acquire guardian privileges by code-match. The status='active' filter
    // on the guardian binding excludes it, so the sender resolves to unknown.
    insertContact({
      id: "c-old-guardian",
      displayName: "Former Guardian",
      role: "guardian",
      principalId: "principal-old",
    });
    insertChannel({
      id: "ch-old-guardian",
      contactId: "c-old-guardian",
      address: "U_OLD_GUARDIAN",
      status: "revoked",
      policy: "deny",
    });

    const verdict = await resolveTrustVerdict({
      channelType: CHANNEL,
      actorExternalId: "U_OLD_GUARDIAN",
    });

    expect(verdict.trustClass).toBe("unknown");
    expect(verdict.status).toBe("revoked");
    // No active guardian binding exists, so guardian label fields are absent.
    expect(verdict.guardianExternalUserId).toBeUndefined();
  });
});
