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
import type { ContactType, ContactWriteResult } from "./types.js";

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
  /** Explicit channel id for a NEW channel (identity-mirror path): reuse the
   *  gateway-minted id so both stores key the channel identically. */
  channelId?: string;
  /** Classification for a newly created contact (e.g. 'assistant' for bots). */
  contactType?: ContactType;
  /** Notes seeded onto a newly created contact (e.g. bot/app provenance). */
  notes?: string | null;
  /** userFile to seed on contact CREATE only (identity-mirror stubs pass null
   *  for a faithful null-user_file replica); ignored on update. */
  userFileOnCreate?: string | null;
  /** Refresh the contact display name from the supplied identity even when a
   *  contactId is given. Used by the inbound identity-seed mirror, whose intent
   *  is to keep the mirror name in sync with the platform profile. Defaults to
   *  false: the invite-binding path preserves the guardian-curated name. */
  refreshDisplayName?: boolean;
  /** Reparent a conflicting existing channel (same (type,address) owned by a
   *  DIFFERENT contact) to this contact. Invite-binding only. The inbound
   *  identity-seed mirror must pass false so it matches the gateway insert's
   *  onConflictDoNothing and never steals a channel from its existing contact.
   *  Defaults to `!!contactId` to preserve the invite-binding callers that
   *  don't set it explicitly. */
  reassignConflictingChannels?: boolean;
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
  // the target contact's curated displayName instead of overwriting it with the
  // raw platform identity. The inbound identity-seed mirror opts out
  // (refreshDisplayName) so a changed platform profile name refreshes the row.
  if (params.contactId && !params.refreshDisplayName) {
    const targetContact = getContact(params.contactId);
    if (targetContact?.displayName?.trim().length) {
      displayName = targetContact.displayName;
    }
  }

  upsertContact({
    id: params.contactId,
    displayName,
    contactType: params.contactType,
    notes: params.notes,
    userFileOnCreate: params.userFileOnCreate,
    channels: [
      {
        id: params.channelId,
        type: params.sourceChannel,
        address,
        // Pass through undefined so syncChannels preserves an existing
        // external_chat_id (COALESCE semantics); a new channel still defaults
        // to null. An explicit value overwrites.
        externalChatId: params.externalChatId,
      },
    ],
    // Reassign a conflicting channel from another contact only when the caller
    // explicitly asks (invite redemption binding a redeemer's existing channel
    // to the invite's target). Defaults to `!!contactId` for legacy callers;
    // the inbound-seed mirror passes false so a first-seen race does not steal
    // the channel from the contact the gateway insert kept.
    reassignConflictingChannels:
      params.reassignConflictingChannels ?? !!params.contactId,
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
