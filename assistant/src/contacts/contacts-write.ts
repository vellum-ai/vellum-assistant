/**
 * Contacts-first write module.
 *
 * Each function writes to the contacts table first (the primary write),
 * then reverse-syncs to the legacy table for backward compatibility.
 * The legacy functions' built-in forward-sync hooks fire redundantly
 * but are harmless (upsertContact is idempotent).
 *
 * All contacts writes are wrapped in try/catch — a contacts failure
 * does not prevent the legacy write from succeeding.
 */

import { eq } from "drizzle-orm";

import type { ChannelId } from "../channels/types.js";
import { emitContactChange } from "./contact-events.js";
import type { GuardianBinding } from "../memory/guardian-bindings.js";
import {
  createBinding,
  revokeBinding,
} from "../memory/guardian-bindings.js";
import type { IngressMember } from "../memory/ingress-member-store.js";
import {
  blockMember,
  revokeMember,
  updateLastSeen,
  upsertMember,
} from "../memory/ingress-member-store.js";
import { assistantIngressMembers } from "../memory/schema.js";
import { canonicalizeInboundIdentity } from "../util/canonicalize-identity.js";
import { getLogger } from "../util/logger.js";
import {
  findContactByChannelExternalId,
  findGuardianForChannel,
  updateChannelLastSeenByExternalId,
  updateChannelStatus,
  upsertContact,
} from "./contact-store.js";
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

function readMemberById(
  memberId: string,
): typeof assistantIngressMembers.$inferSelect | undefined {
  const db = getDb();
  return db
    .select()
    .from(assistantIngressMembers)
    .where(eq(assistantIngressMembers.id, memberId))
    .get();
}

// ── Guardian operations ──────────────────────────────────────────────

/**
 * Create a guardian binding, writing to the contacts table first,
 * then reverse-syncing to the legacy guardian_bindings table.
 * Returns the legacy GuardianBinding (so callers expecting binding.id still work).
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
  try {
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
  } catch (err) {
    log.warn({ err }, "Contacts write failed for createGuardianBinding");
  }

  const result = createBinding(params);
  emitContactChange();
  return result;
}

/**
 * Revoke a guardian binding, updating the contacts table first,
 * then reverse-syncing to the legacy guardian_bindings table.
 * Returns the boolean result from the legacy call.
 */
export function revokeGuardianBindingContactsFirst(
  assistantId: string,
  channel: string,
): boolean {
  try {
    const guardian = findGuardianForChannel(channel);
    if (guardian) {
      updateChannelStatus(guardian.channel.id, {
        status: "revoked",
        revokedReason: "binding_revoked",
      });
    }
  } catch (err) {
    log.warn({ err }, "Contacts write failed for revokeGuardianBinding");
  }

  const result = revokeBinding(assistantId, channel);
  emitContactChange();
  return result;
}

// ── Member operations ────────────────────────────────────────────────

/**
 * Upsert an ingress member, writing to the contacts table first,
 * then reverse-syncing to the legacy ingress_members table.
 * Returns the IngressMember from the legacy call (callers expect this type).
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
  try {
    // Compute address and canonicalId (same logic as syncSingleMember in contact-sync)
    let address: string;
    let canonicalId: string | null;

    if (params.externalUserId) {
      const canonical =
        canonicalizeInboundIdentity(
          params.sourceChannel as ChannelId,
          params.externalUserId,
        ) ?? params.externalUserId;
      address = canonical;
      canonicalId = canonical;
    } else if (params.externalChatId) {
      address = params.externalChatId;
      canonicalId = null;
    } else {
      // No usable identity — skip contacts write, let legacy handle validation
      return upsertMember(params as Parameters<typeof upsertMember>[0]);
    }

    const displayName =
      params.displayName ?? params.externalUserId ?? "Unknown";

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
          revokedReason: params.status === 'active' ? null : undefined,
          blockedReason: params.status === 'active' ? null : undefined,
        },
      ],
    });
  } catch (err) {
    log.warn({ err }, "Contacts write failed for upsertMember");
  }

  const result = upsertMember(params as Parameters<typeof upsertMember>[0]);
  emitContactChange();
  return result;
}

/**
 * Revoke an ingress member, updating the contacts table first,
 * then reverse-syncing to the legacy ingress_members table.
 * Returns the IngressMember | null from the legacy call.
 */
export function revokeMemberContactsFirst(
  memberId: string,
  reason?: string,
): IngressMember | null {
  // Perform legacy revoke first — it only applies to active/pending members
  const result = revokeMember(memberId, reason);

  // Only update contacts if the legacy revoke actually succeeded
  if (result) {
    try {
      const canonicalUserId = result.externalUserId
        ? (canonicalizeInboundIdentity(
            result.sourceChannel as ChannelId,
            result.externalUserId,
          ) ?? result.externalUserId)
        : null;

      if (canonicalUserId) {
        const contact = findContactByChannelExternalId(
          result.sourceChannel,
          canonicalUserId,
        );
        if (contact) {
          const matchingChannel = contact.channels.find(
            (ch) =>
              ch.type === result.sourceChannel &&
              ch.externalUserId === canonicalUserId,
          );
          if (matchingChannel) {
            updateChannelStatus(matchingChannel.id, {
              status: "revoked",
              revokedReason: reason ?? null,
            });
          }
        }
      }
    } catch (err) {
      log.warn({ err }, "Contacts write failed for revokeMember");
    }
  }

  emitContactChange();
  return result;
}

/**
 * Block an ingress member, performing the legacy block first,
 * then updating the contacts table only if the legacy call succeeded.
 * Returns the IngressMember | null from the legacy call.
 */
export function blockMemberContactsFirst(
  memberId: string,
  reason?: string,
): IngressMember | null {
  // Perform legacy block first — it only applies to non-blocked members
  const result = blockMember(memberId, reason);

  // Only update contacts if the legacy block actually succeeded
  if (result) {
    try {
      const canonicalUserId = result.externalUserId
        ? (canonicalizeInboundIdentity(
            result.sourceChannel as ChannelId,
            result.externalUserId,
          ) ?? result.externalUserId)
        : null;

      if (canonicalUserId) {
        // Try canonical ID first, fall back to raw ID for legacy contacts
        let contact = findContactByChannelExternalId(
          result.sourceChannel,
          canonicalUserId,
        );
        let lookupId = canonicalUserId;

        if (!contact && canonicalUserId !== result.externalUserId) {
          contact = findContactByChannelExternalId(
            result.sourceChannel,
            result.externalUserId,
          );
          lookupId = result.externalUserId;
        }

        if (contact) {
          const matchingChannel = contact.channels.find(
            (ch) =>
              ch.type === result.sourceChannel &&
              ch.externalUserId === lookupId,
          );
          if (matchingChannel) {
            updateChannelStatus(matchingChannel.id, {
              status: "blocked",
              blockedReason: reason ?? null,
            });
          }
        }
      }
    } catch (err) {
      log.warn({ err }, "Contacts write failed for blockMember");
    }
  }

  emitContactChange();
  return result;
}

/**
 * Touch the lastSeenAt timestamp on a member's contact channel,
 * then reverse-sync to the legacy ingress_members table.
 */
export function touchChannelLastSeen(memberId: string): void {
  try {
    const member = readMemberById(memberId);
    if (member?.externalUserId) {
      const canonicalUserId =
        canonicalizeInboundIdentity(
          member.sourceChannel as ChannelId,
          member.externalUserId,
        ) ?? member.externalUserId;

      // Try canonical ID first
      updateChannelLastSeenByExternalId(
        member.sourceChannel,
        canonicalUserId,
      );

      // Also try raw ID for legacy contacts that haven't been rewritten yet
      if (canonicalUserId !== member.externalUserId) {
        updateChannelLastSeenByExternalId(
          member.sourceChannel,
          member.externalUserId,
        );
      }
    }
  } catch (err) {
    log.warn({ err }, "Contacts write failed for touchChannelLastSeen");
  }

  updateLastSeen(memberId);
}
