/**
 * Contacts write module.
 *
 * All mutations (member upserts, guardian bindings, revocations) write
 * directly to the contacts table, the single authoritative source for
 * identity and access-control state.
 */

import {
  findContactChannel,
  getChannelById,
  getContact,
  getContactInternal,
  upsertContact,
} from "./contact-store.js";
import type { ContactType, ContactWriteResult } from "./types.js";

// ── Guardian operations ──────────────────────────────────────────────

/**
 * No-op shim: the guardian channel ACL revoke is gateway-owned (relayed via
 * mark_channel_revoked). Retained while callers still invoke it; the return is
 * discarded.
 */
export function revokeGuardianBinding(_channel: string): boolean {
  return false;
}

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
