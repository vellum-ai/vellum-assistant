/**
 * Test-only member seeding.
 *
 * Production identity upserts no longer write ACL columns (gateway-owned).
 * Tests that simulate gateway-resolved members stamp the ACL columns directly
 * and warm the member-verdict cache so verdict synthesis and the sync trust
 * fallback resolve the intended trust.
 */

import { eq, type SQL } from "drizzle-orm";

import { isChannelId } from "../../channels/types.js";
import { upsertContact } from "../../contacts/contact-store.js";
import type {
  ChannelPolicy,
  ChannelStatus,
  ContactRole,
} from "../../contacts/types.js";
import { getDb } from "../../memory/db-connection.js";
import { contactChannels, contacts } from "../../memory/schema.js";
import { setMemberVerdict } from "../../runtime/member-verdict-cache.js";

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
  inviteId?: string | null;
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
        inviteId: params.inviteId ?? null,
      },
    ],
    reassignConflictingChannels: !!params.contactId,
  });

  const db = getDb();
  if (params.role !== undefined || params.principalId !== undefined) {
    const set: Record<string, unknown> = {};
    if (params.role !== undefined) set.role = params.role;
    if (params.principalId !== undefined) set.principalId = params.principalId;
    db.update(contacts).set(set).where(eq(contacts.id, contact.id)).run();
  }

  const channel = contact.channels.find(
    (ch) => ch.type === params.sourceChannel,
  )!;
  const aclSet: Record<string, unknown> = { updatedAt: Date.now() };
  if (params.status !== undefined) aclSet.status = params.status;
  if (params.policy !== undefined) aclSet.policy = params.policy;
  if (params.verifiedAt !== undefined) aclSet.verifiedAt = params.verifiedAt;
  if (params.verifiedVia !== undefined) aclSet.verifiedVia = params.verifiedVia;
  if (params.revokedReason !== undefined)
    aclSet.revokedReason = params.revokedReason;
  if (params.blockedReason !== undefined)
    aclSet.blockedReason = params.blockedReason;
  db.update(contactChannels)
    .set(aclSet)
    .where(eq(contactChannels.id, channel.id))
    .run();

  // Warm the verdict cache so the sync trust fallback resolves this member, as
  // a gateway verdict fetch would in production.
  if (isChannelId(params.sourceChannel)) {
    setMemberVerdict(params.sourceChannel, address, {
      trustClass: params.role === "guardian" ? "guardian" : "unknown",
      canonicalSenderId: address,
      contactId: contact.id,
      channelId: channel.id,
      status: (params.status ?? "active") as ChannelStatus,
      policy: (params.policy ?? "allow") as ChannelPolicy,
    });
  }

  return { contactId: contact.id, channelId: channel.id };
}

/**
 * Stamp the local mirror of a gateway-owned channel ACL downgrade. Production
 * revoke is gateway-owned (relayed via `mark_channel_revoked`); tests whose
 * guardian-resolution reads run locally call these to mark channels `revoked`
 * so those reads observe the downgrade. The ACL-column write is confined here
 * so the trust/guardian test files don't reference the columns.
 */
export function revokeChannelsByType(channelType: string): void {
  revokeChannelsWhere(eq(contactChannels.type, channelType));
}

/** Stamp a gateway-owned channel revoke for a single channel id. */
export function revokeChannelById(channelId: string): void {
  revokeChannelsWhere(eq(contactChannels.id, channelId));
}

function revokeChannelsWhere(predicate: SQL): void {
  getDb()
    .update(contactChannels)
    .set({ status: "revoked", updatedAt: Date.now() })
    .where(predicate)
    .run();
}
