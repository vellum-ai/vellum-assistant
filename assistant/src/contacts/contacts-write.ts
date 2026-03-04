/**
 * Contacts-first write module.
 *
 * All mutations write directly to the contacts table (the authoritative
 * source). The legacy ingress_members and guardian_bindings tables are
 * no longer written to.
 */

import type { ChannelId } from "../channels/types.js";
import type { GuardianBinding } from "../memory/channel-guardian-store.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import { canonicalizeInboundIdentity } from "../util/canonicalize-identity.js";
import { getLogger } from "../util/logger.js";
import { emitContactChange } from "./contact-events.js";
import {
  findContactChannel,
  findGuardianForChannel,
  getChannelById,
  getContact,
  updateChannelLastSeenById,
  updateChannelStatus,
  upsertContact,
} from "./contact-store.js";
import type { IngressMember } from "./member-record-shim.js";
import { contactChannelToMemberRecord } from "./member-record-shim.js";
import type { ChannelPolicy, ChannelStatus } from "./types.js";

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
 * Create a guardian binding by writing to the contacts table.
 * Returns a GuardianBinding-compatible object synthesized from the input params
 * (so callers expecting binding.id still work).
 */
export function createGuardianBindingContactsFirst(params: {
  assistantId: string;
  channel: string;
  guardianExternalUserId: string;
  guardianDeliveryChatId: string;
  guardianPrincipalId: string;
  verifiedVia?: string;
  metadataJson?: string | null;
}): GuardianBinding {
  const canonicalId =
    canonicalizeInboundIdentity(
      params.channel as ChannelId,
      params.guardianExternalUserId,
    ) ?? params.guardianExternalUserId;

  const displayName =
    parseDisplayNameFromMetadata(params.metadataJson) ??
    params.guardianExternalUserId;

  upsertContact({
    displayName,
    role: "guardian",
    principalId: params.guardianPrincipalId,
    assistantId: params.assistantId,
    channels: [
      {
        type: params.channel,
        address: canonicalId,
        externalUserId: canonicalId,
        externalChatId: params.guardianDeliveryChatId,
        status: "active",
        verifiedAt: Date.now(),
        verifiedVia: params.verifiedVia ?? "challenge",
      },
    ],
  });

  const now = Date.now();
  const result: GuardianBinding = {
    id: `contact-binding-${params.channel}`,
    assistantId: params.assistantId,
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

  emitContactChange();
  return result;
}

/**
 * Revoke a guardian binding by updating the contacts table.
 * Returns true when a guardian channel was found and revoked, false otherwise.
 */
export function revokeGuardianBindingContactsFirst(
  assistantId: string,
  channel: string,
): boolean {
  const guardian = findGuardianForChannel(channel, assistantId);
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
 * Upsert an ingress member by writing to the contacts table.
 * Returns an IngressMember synthesized from the contacts data.
 */
export function upsertMemberContactsFirst(params: {
  sourceChannel: string;
  externalUserId?: string;
  externalChatId?: string;
  displayName?: string;
  username?: string;
  policy?: string;
  status?: string;
  inviteId?: string;
  createdBySessionId?: string;
  assistantId?: string;
}): IngressMember {
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
    // No usable identity — return a minimal fallback record
    return {
      id: "",
      assistantId: params.assistantId ?? DAEMON_INTERNAL_ASSISTANT_ID,
      sourceChannel: params.sourceChannel,
      externalUserId: params.externalUserId ?? null,
      externalChatId: params.externalChatId ?? null,
      displayName: params.displayName ?? null,
      username: params.username ?? null,
      status: (params.status as IngressMember["status"]) ?? "pending",
      policy: (params.policy as IngressMember["policy"]) ?? "allow",
      inviteId: params.inviteId ?? null,
      createdBySessionId: params.createdBySessionId ?? null,
      revokedReason: null,
      blockedReason: null,
      lastSeenAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  const displayName = params.displayName ?? params.externalUserId ?? "Unknown";

  const canonicalId = params.externalUserId
    ? (canonicalizeInboundIdentity(
        params.sourceChannel as ChannelId,
        params.externalUserId,
      ) ?? params.externalUserId)
    : null;

  upsertContact({
    displayName,
    channels: [
      {
        type: params.sourceChannel,
        address,
        externalUserId: canonicalId,
        externalChatId: params.externalChatId ?? null,
        legacyAddress:
          params.externalUserId && params.externalUserId !== address
            ? params.externalUserId
            : undefined,
        status: (params.status as ChannelStatus) ?? undefined,
        policy: (params.policy as ChannelPolicy) ?? undefined,
        inviteId: params.inviteId ?? null,
        revokedReason: params.status === "active" ? null : undefined,
        blockedReason: params.status === "active" ? null : undefined,
      },
    ],
  });

  const contactResult = findContactChannel({
    channelType: params.sourceChannel,
    externalUserId: canonicalId ?? undefined,
    externalChatId: params.externalChatId,
  });

  emitContactChange();

  if (contactResult) {
    return contactChannelToMemberRecord(
      contactResult.contact,
      contactResult.channel,
    );
  }

  // Fallback: construct minimal IngressMember from params
  return {
    id: "",
    assistantId: params.assistantId ?? DAEMON_INTERNAL_ASSISTANT_ID,
    sourceChannel: params.sourceChannel,
    externalUserId: params.externalUserId ?? null,
    externalChatId: params.externalChatId ?? null,
    displayName: params.displayName ?? null,
    username: params.username ?? null,
    status: (params.status as IngressMember["status"]) ?? "pending",
    policy: (params.policy as IngressMember["policy"]) ?? "allow",
    inviteId: params.inviteId ?? null,
    createdBySessionId: params.createdBySessionId ?? null,
    revokedReason: null,
    blockedReason: null,
    lastSeenAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * Revoke an ingress member by updating the contacts channel status.
 * The memberId may be a channel ID (from contactChannelToMemberRecord shim)
 * or a composite contactId:channelId (from contactToMemberResponse in ingress-service).
 */
export function revokeMemberContactsFirst(
  memberId: string,
  reason?: string,
): IngressMember | null {
  const channelId = memberId.includes(":") ? memberId.split(":")[1] : memberId;

  const channelRow = getChannelById(channelId);
  if (!channelRow) return null;
  if (channelRow.status !== "active" && channelRow.status !== "pending")
    return null;

  updateChannelStatus(channelId, {
    status: "revoked",
    revokedReason: reason ?? null,
  });

  const contact = getContact(channelRow.contactId);
  if (!contact) return null;
  const updatedChannel = contact.channels.find((ch) => ch.id === channelId);
  if (!updatedChannel) return null;

  emitContactChange();
  return contactChannelToMemberRecord(contact, updatedChannel);
}

/**
 * Block an ingress member by updating the contacts channel status.
 * The memberId may be a channel ID (from contactChannelToMemberRecord shim)
 * or a composite contactId:channelId (from contactToMemberResponse in ingress-service).
 */
export function blockMemberContactsFirst(
  memberId: string,
  reason?: string,
): IngressMember | null {
  const channelId = memberId.includes(":") ? memberId.split(":")[1] : memberId;

  const channelRow = getChannelById(channelId);
  if (!channelRow) return null;
  if (channelRow.status === "blocked") return null;

  updateChannelStatus(channelId, {
    status: "blocked",
    blockedReason: reason ?? null,
  });

  const contact = getContact(channelRow.contactId);
  if (!contact) return null;
  const updatedChannel = contact.channels.find((ch) => ch.id === channelId);
  if (!updatedChannel) return null;

  emitContactChange();
  return contactChannelToMemberRecord(contact, updatedChannel);
}

/**
 * Update the lastSeenAt timestamp on a contact channel by its ID.
 * The channelId comes from the contactChannelToMemberRecord shim (member.id = channel.id).
 */
export function touchChannelLastSeen(channelId: string): void {
  try {
    updateChannelLastSeenById(channelId);
  } catch (err) {
    log.warn({ err }, "Failed to update channel lastSeenAt");
  }
}
