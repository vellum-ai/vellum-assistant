/**
 * Contacts write module.
 *
 * All mutations (member upserts, guardian bindings, revocations) write
 * directly to the contacts table, the single authoritative source for
 * identity and access-control state.
 */

import type { ChannelId } from "../channels/types.js";
import { ipcCall } from "../ipc/gateway-client.js";
import type { GuardianBinding } from "../memory/channel-verification-sessions.js";
import { clearCache as clearTrustCache } from "../permissions/trust-store.js";
import { canonicalizeInboundIdentity } from "../util/canonicalize-identity.js";
import { getLogger } from "../util/logger.js";
import { emitContactChange } from "./contact-events.js";
import {
  findContactChannel,
  findGuardianForChannel,
  getChannelById,
  getContact,
  getContactInternal,
  updateChannelInteraction,
  updateChannelLastSeenById,
  updateChannelStatus,
  upsertContact,
} from "./contact-store.js";
import type {
  ChannelPolicy,
  ChannelStatus,
  ContactRole,
  ContactWriteResult,
} from "./types.js";

const log = getLogger("contacts-write");

// ── Helpers ──────────────────────────────────────────────────────────

function parseDisplayNameFromMetadata(
  metadataJson: string | null | undefined,
): string | null {
  if (!metadataJson) return null;
  try {
    const parsed = JSON.parse(metadataJson);
    if (
      typeof parsed.displayName === "string" &&
      parsed.displayName.length > 0
    ) {
      return parsed.displayName;
    }
  } catch {
    // Malformed JSON — fall through
  }
  return null;
}

// ── Guardian operations ──────────────────────────────────────────────

/**
 * Create a guardian binding via the gateway IPC.
 *
 * The gateway owns guardian identity establishment — it writes to both
 * the assistant and gateway DBs in a single transaction. This function
 * canonicalizes the sender ID, delegates to the gateway, then handles
 * assistant-side concerns (trust cache invalidation, contact change event).
 *
 * Returns a GuardianBinding-compatible object synthesized from the input
 * params (so callers expecting binding.id still work).
 */
export async function createGuardianBinding(params: {
  channel: string;
  guardianExternalUserId: string;
  guardianDeliveryChatId: string;
  guardianPrincipalId: string;
  verifiedVia?: string;
  metadataJson?: string | null;
}): Promise<GuardianBinding> {
  const canonicalId =
    canonicalizeInboundIdentity(
      params.channel as ChannelId,
      params.guardianExternalUserId,
    ) ?? params.guardianExternalUserId;

  const displayName =
    parseDisplayNameFromMetadata(params.metadataJson) ??
    params.guardianExternalUserId;

  await ipcCall("create_guardian_binding", {
    channel: params.channel,
    externalUserId: canonicalId,
    deliveryChatId: params.guardianDeliveryChatId,
    guardianPrincipalId: params.guardianPrincipalId,
    displayName,
    verifiedVia: params.verifiedVia ?? "challenge",
  });

  // The gateway wrote to the assistant DB — invalidate local caches so
  // downstream reads pick up the new guardian contact immediately.
  emitContactChange();
  clearTrustCache();

  const now = Date.now();
  const result: GuardianBinding = {
    id: `contact-binding-${params.channel}`,
    assistantId: "self",
    channel: params.channel,
    guardianExternalUserId: params.guardianExternalUserId,
    guardianDeliveryChatId: params.guardianDeliveryChatId,
    guardianPrincipalId: params.guardianPrincipalId,
    status: "active",
    verifiedAt: now,
    verifiedVia: params.verifiedVia ?? "challenge",
    metadataJson: params.metadataJson ?? null,
    createdAt: now,
    updatedAt: now,
  };

  return result;
}

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
  // is the sole responsibility of `createGuardianBinding`.

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

/**
 * Update the lastSeenAt timestamp on a contact channel by its ID.
 * Expects a plain channel UUID (ContactChannel.id), not the composite API ID.
 */
export function touchChannelLastSeen(channelId: string): void {
  try {
    updateChannelLastSeenById(channelId);
  } catch (err) {
    log.warn({ err }, "Failed to update channel lastSeenAt");
  }
}

/**
 * Track an interaction on the specific channel that received it.
 * Swallows errors to avoid disrupting the inbound message hot path.
 */
export function touchContactInteraction(channelId: string): void {
  try {
    updateChannelInteraction(channelId);
  } catch (err) {
    log.warn({ err }, "Failed to update channel interaction stats");
  }
}
