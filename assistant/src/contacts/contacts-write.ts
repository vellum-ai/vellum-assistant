/**
 * Contacts write module.
 *
 * Best-effort local mirror of contact identity/INFO fields. The gateway owns
 * the ACL verdict (status, policy, verification); these writes never carry or
 * mutate ACL state.
 */

import {
  findContactChannel,
  getChannelById,
  getContact,
  getContactInternal,
  upsertContact,
} from "./contact-store.js";
import type { ContactWriteResult } from "./types.js";

// ── Member operations ────────────────────────────────────────────────

/**
 * Upsert a contact and channel identity by writing to the contacts table.
 * Persists only identity/INFO — the gateway owns the ACL verdict. Returns the
 * native Contact + ContactChannel, or null if no usable identity was provided
 * or the lookup failed after upsert.
 */
export function upsertContactChannel(params: {
  sourceChannel: string;
  externalUserId?: string;
  externalChatId?: string;
  displayName?: string;
  username?: string;
  contactId?: string;
}): ContactWriteResult | null {
  let address: string;

  if (params.externalUserId) {
    address = params.externalUserId;
  } else if (params.externalChatId) {
    address = params.externalChatId;
  } else {
    // No usable identity — cannot create a contact
    return null;
  }

  let displayName = params.displayName ?? address;

  // When binding a channel to a specific contact (invite redemption), preserve
  // the target contact's curated displayName instead of overwriting it
  // with the raw platform identity.
  if (params.contactId) {
    const targetContact = getContact(params.contactId);
    if (targetContact?.displayName?.trim().length) {
      displayName = targetContact.displayName;
    }
  }

  upsertContact({
    id: params.contactId,
    displayName,
    channels: [
      {
        type: params.sourceChannel,
        address,
        externalChatId: params.externalChatId ?? null,
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
    address,
    externalChatId: params.externalChatId,
  });

  if (contactResult) {
    return { contact: contactResult.contact, channel: contactResult.channel };
  }

  return null;
}

/**
 * Resolve the native contact/channel for a member id. The ACL downgrade is
 * gateway-owned (relayed via mark_channel_revoked); this no longer mutates
 * local status. The memberId may be a plain channel ID (internal callers) or a
 * composite contactId:channelId (from the API response format).
 */
export function revokeMember(memberId: string): ContactWriteResult | null {
  const channelId = memberId.includes(":") ? memberId.split(":")[1] : memberId;

  const channelRow = getChannelById(channelId);
  if (!channelRow) return null;

  const contact = getContactInternal(channelRow.contactId);
  if (!contact) return null;
  const channel = contact.channels.find((ch) => ch.id === channelId);
  if (!channel) return null;

  return { contact, channel };
}
