/**
 * Contacts write module.
 *
 * All mutations (member upserts, guardian bindings, revocations) write
 * directly to the contacts table, the single authoritative source for
 * identity and access-control state.
 */

import type { ChannelId } from "../channels/types.js";
import { canonicalizeInboundIdentity } from "../util/canonicalize-identity.js";
import { emitContactChange } from "./contact-events.js";
import {
  findContactChannel,
  findGuardianForChannel,
  getChannelById,
  getContact,
  getContactInternal,
  updateChannelStatus,
  upsertContact,
} from "./contact-store.js";
import type {
  ChannelPolicy,
  ChannelStatus,
  ContactRole,
  ContactWriteResult,
} from "./types.js";


// ── Guardian operations ──────────────────────────────────────────────

/**
 * Revoke a guardian binding by updating the contacts table.
 * Returns true when a guardian channel was found and revoked, false otherwise.
 */
export function revokeGuardianBinding(channel: string): boolean {
  const guardian = findGuardianForChannel(channel);
  if (!guardian) return false;

  updateChannelStatus(guardian.channel.id, {
    status: "revoked",
    revokedReason: "binding_revoked",
  });
  emitContactChange();
  return true;
}

// ── Member operations ────────────────────────────────────────────────

/**
 * Upsert a contact and channel by writing to the contacts table.
 * Returns the native Contact + ContactChannel, or null if no usable
 * identity was provided or the lookup failed after upsert.
 */
export function upsertContactChannel(params: {
  sourceChannel: string;
  externalUserId?: string;
  externalChatId?: string;
  displayName?: string;
  username?: string;
  policy?: string;
  status?: string;
  inviteId?: string;
  verifiedAt?: number;
  verifiedVia?: string;
  role?: ContactRole;
  contactId?: string;
}): ContactWriteResult | null {
  let address: string;

  if (params.externalUserId) {
    const canonical =
      canonicalizeInboundIdentity(
        params.sourceChannel as ChannelId,
        params.externalUserId,
      ) ?? params.externalUserId;
    address = canonical;
  } else if (params.externalChatId) {
    address = params.externalChatId;
  } else {
    // No usable identity — cannot create a contact
    return null;
  }

  let displayName = params.displayName ?? params.externalUserId ?? "Unknown";

  // When binding a channel to a specific contact (invite redemption), preserve
  // the target contact's curated displayName (e.g. "Mom") instead of overwriting
  // it with the redeemer's externalUserId.
  if (params.contactId) {
    const targetContact = getContact(params.contactId);
    if (targetContact?.displayName?.trim().length) {
      displayName = targetContact.displayName;
    }
  }

  const canonicalId = params.externalUserId
    ? (canonicalizeInboundIdentity(
        params.sourceChannel as ChannelId,
        params.externalUserId,
      ) ?? params.externalUserId)
    : null;

  upsertContact({
    id: params.contactId,
    displayName,
    role: params.role,
    channels: [
      {
        type: params.sourceChannel,
        address,
        externalUserId: canonicalId,
        externalChatId: params.externalChatId ?? null,
        status: (params.status as ChannelStatus) ?? undefined,
        policy: (params.policy as ChannelPolicy) ?? undefined,
        inviteId: params.inviteId ?? null,
        revokedReason: params.status === "active" ? null : undefined,
        blockedReason: params.status === "active" ? null : undefined,
        verifiedAt: params.verifiedAt ?? undefined,
        verifiedVia: params.verifiedVia ?? undefined,
      },
    ],
    // When a specific contactId is provided, reassign conflicting channels from
    // other contacts. This enables invite redemption to bind a redeemer's
    // existing channel identity to the invite's target contact.
    reassignConflictingChannels: !!params.contactId,
  });

  // NOTE: We intentionally do NOT seed `users/<slug>.md` here. This is the
  // inbound-message hot path — every new contact (Slack, phone, email, etc)
  // would otherwise fire the `users/` directory watcher in
  // config-watcher.ts and evict live conversations. Persona-file seeding
  // is handled by the gateway's guardian bootstrap flow.

  const contactResult = findContactChannel({
    channelType: params.sourceChannel,
    externalUserId: canonicalId ?? undefined,
    externalChatId: params.externalChatId,
  });

  if (contactResult) {
    return { contact: contactResult.contact, channel: contactResult.channel };
  }

  return null;
}

/**
 * Revoke a contact channel by updating its status.
 * The memberId may be a plain channel ID (internal callers) or a composite
 * contactId:channelId (from the API response format).
 */
export function revokeMember(
  memberId: string,
  reason?: string,
): ContactWriteResult | null {
  const channelId = memberId.includes(":") ? memberId.split(":")[1] : memberId;

  const channelRow = getChannelById(channelId);
  if (!channelRow) return null;
  if (channelRow.status !== "active" && channelRow.status !== "pending")
    return null;

  updateChannelStatus(channelId, {
    status: "revoked",
    revokedReason: reason ?? null,
  });

  // Use unscoped lookup — the contact was already resolved via channel ID
  const contact = getContactInternal(channelRow.contactId);
  if (!contact) return null;
  const updatedChannel = contact.channels.find((ch) => ch.id === channelId);
  if (!updatedChannel) return null;

  emitContactChange();
  return { contact, channel: updatedChannel };
}

