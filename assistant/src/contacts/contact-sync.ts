/**
 * Sync service that populates the contacts table from legacy guardian-binding
 * and ingress-member tables. Each function is idempotent — duplicates are
 * prevented by address-based dedup in upsertContact.
 */

import type { ChannelId } from "../channels/types.js";
import type { GuardianBinding } from "../memory/guardian-bindings.js";
import { listActiveBindingsByAssistant } from "../memory/guardian-bindings.js";
import type { IngressMember } from "../memory/ingress-member-store.js";
import { listMembers } from "../memory/ingress-member-store.js";
import { canonicalizeInboundIdentity } from "../util/canonicalize-identity.js";
import { upsertContact } from "./contact-store.js";
import type { ChannelStatus } from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────────

function parseDisplayNameFromMetadata(
  metadataJson: string | null,
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

// ── Guardian binding sync ────────────────────────────────────────────

/**
 * Sync all active guardian bindings for an assistant into the contacts table.
 * Each binding creates (or updates) a contact with role 'guardian'.
 */
export function syncGuardianBindingsToContacts(assistantId: string): void {
  const bindings = listActiveBindingsByAssistant(assistantId);
  for (const binding of bindings) {
    syncSingleGuardianBinding(binding);
  }
}

/**
 * Sync a single guardian binding into the contacts table.
 * Useful for real-time forward-sync after a new binding is created.
 */
export function syncSingleGuardianBinding(binding: GuardianBinding): void {
  const canonicalId =
    canonicalizeInboundIdentity(
      binding.channel as ChannelId,
      binding.guardianExternalUserId,
    ) ?? binding.guardianExternalUserId;

  const displayName =
    parseDisplayNameFromMetadata(binding.metadataJson) ??
    binding.guardianExternalUserId;

  upsertContact({
    displayName,
    role: "guardian",
    principalId: binding.guardianPrincipalId,
    channels: [
      {
        type: binding.channel,
        address: canonicalId,
        externalUserId: canonicalId,
        externalChatId: binding.guardianDeliveryChatId,
        legacyAddress:
          binding.guardianExternalUserId !== canonicalId
            ? binding.guardianExternalUserId
            : undefined,
        status: "active",
        revokedReason: null,
        verifiedAt: binding.verifiedAt,
        verifiedVia: binding.verifiedVia,
      },
    ],
  });
}

// ── Ingress member sync ──────────────────────────────────────────────

/**
 * Sync all non-pending ingress members for an assistant into the contacts table.
 * Members are always created with role 'contact' — guardian role is set only
 * from guardian bindings.
 */
export function syncIngressMembersToContacts(assistantId: string): void {
  const members = listMembers({ assistantId });
  for (const member of members) {
    if (member.status === "pending") continue;
    syncSingleMember(member);
  }
}

/**
 * Sync a single ingress member into the contacts table.
 * Useful for real-time forward-sync after a member upsert.
 */
export function syncSingleMember(member: IngressMember): void {
  // Skip members with no usable identity
  if (!member.externalUserId && !member.externalChatId) return;

  const displayName =
    member.displayName ?? member.username ?? member.externalUserId ?? "Unknown";

  let address: string;
  let externalUserId: string | null;
  let legacyAddress: string | undefined;

  if (member.externalUserId) {
    const canonicalId =
      canonicalizeInboundIdentity(
        member.sourceChannel as ChannelId,
        member.externalUserId,
      ) ?? member.externalUserId;
    address = canonicalId;
    externalUserId = canonicalId;
    if (member.externalUserId !== canonicalId) {
      legacyAddress = member.externalUserId;
    }
  } else {
    address = member.externalChatId!;
    externalUserId = null;
  }

  upsertContact({
    displayName,
    channels: [
      {
        type: member.sourceChannel,
        address,
        externalUserId,
        externalChatId: member.externalChatId,
        legacyAddress,
        status: member.status as ChannelStatus,
        policy: member.policy as "allow" | "deny" | "escalate",
        inviteId: member.inviteId,
      },
    ],
  });
}

// ── Bulk sync ────────────────────────────────────────────────────────

/**
 * Sync all guardian bindings and ingress members for an assistant.
 * Guardian bindings are synced first so that guardian contacts exist before
 * member sync — this lets upsertContact's address-based dedup merge them
 * rather than creating duplicates.
 */
export function syncAllToContacts(assistantId: string): void {
  syncGuardianBindingsToContacts(assistantId);
  syncIngressMembersToContacts(assistantId);
}
