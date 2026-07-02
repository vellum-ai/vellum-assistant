/**
 * Test-only member seeding.
 *
 * Production identity upserts no longer write ACL columns (gateway-owned).
 * Tests that simulate gateway-resolved members seed the ACL state into the
 * in-process gateway ACL store ({@link upsertGatewayAcl}, the stand-in for
 * `gwContacts`/`gwContactChannels`) and warm the member-verdict cache so verdict
 * synthesis and the sync trust fallback resolve the intended trust. The assistant
 * row carries only identity/info columns (id, displayName, channel address/chat
 * id) — never the ACL columns (incl. principalId), which are gateway-owned.
 */

import { isChannelId } from "../../channels/types.js";
import { upsertContact } from "../../contacts/contact-store.js";
import type {
  ChannelPolicy,
  ChannelStatus,
  ContactRole,
} from "../../contacts/types.js";
import { setMemberVerdict } from "../../runtime/member-verdict-cache.js";
import {
  gatewayAclByChannelId,
  setGatewayAclStatusByChannelId,
  setGatewayAclStatusByType,
  upsertGatewayAcl,
} from "./gateway-acl-store.js";

export function seedContactChannel(params: {
  sourceChannel: string;
  externalUserId?: string;
  externalChatId?: string;
  displayName?: string;
  username?: string;
  contactId?: string;
  role?: ContactRole;
  status?: ChannelStatus;
  policy?: string;
  verifiedAt?: number | null;
  verifiedVia?: string | null;
  revokedReason?: string | null;
  blockedReason?: string | null;
  principalId?: string | null;
}): { contactId: string; channelId: string } {
  const address = params.externalUserId ?? params.externalChatId;
  if (!address) throw new Error("seedContactChannel requires an address");

  const contact = upsertContact({
    id: params.contactId,
    displayName: params.displayName ?? address,
    channels: [
      {
        type: params.sourceChannel,
        address,
        externalChatId: params.externalChatId ?? null,
      },
    ],
    reassignConflictingChannels: !!params.contactId,
  });

  const channel = contact.channels.find(
    (ch) => ch.type === params.sourceChannel,
  )!;

  // Stamp the gateway-owned ACL row (role/status/verifiedAt + delivery
  // endpoints) into the gateway ACL store — the source the guardian-delivery
  // resolver reads, mirroring production. Re-seeding a channel's member ACL
  // (e.g. a guardian's own active member row) without an explicit role keeps
  // the existing gateway role, mirroring the gateway: an identity/member upsert
  // never downgrades a guardian to a plain contact.
  const status = params.status ?? "active";
  const existing = gatewayAclByChannelId(channel.id);
  upsertGatewayAcl({
    contactId: contact.id,
    channelId: channel.id,
    channelType: channel.type,
    address: channel.address,
    externalChatId: channel.externalChatId ?? null,
    principalId: params.principalId ?? existing?.principalId ?? null,
    displayName: contact.displayName ?? null,
    role: params.role ?? existing?.role ?? "contact",
    status,
    policy: params.policy ?? "allow",
    verifiedAt: params.verifiedAt ?? existing?.verifiedAt ?? null,
  });

  // Warm the verdict cache so the sync trust fallback resolves this member, as
  // a gateway verdict fetch would in production.
  if (isChannelId(params.sourceChannel)) {
    setMemberVerdict(params.sourceChannel, address, {
      trustClass: params.role === "guardian" ? "guardian" : "unknown",
      canonicalSenderId: address,
      contactId: contact.id,
      channelId: channel.id,
      status: status as ChannelStatus,
      policy: (params.policy ?? "allow") as ChannelPolicy,
    });
  }

  return { contactId: contact.id, channelId: channel.id };
}

/**
 * Stamp the gateway-owned channel ACL downgrade. Production revoke is
 * gateway-owned (relayed via `mark_channel_revoked`); tests whose
 * guardian-resolution reads run against the gateway ACL store call these to
 * mark channels `revoked` so those reads observe the downgrade.
 */
export function revokeChannelsByType(channelType: string): void {
  setGatewayAclStatusByType(channelType, "revoked");
}

/** Stamp a gateway-owned channel revoke for a single channel id. */
export function revokeChannelById(channelId: string): void {
  setGatewayAclStatusByChannelId(channelId, "revoked");
}
