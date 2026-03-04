/**
 * One-time startup migration that populates the contacts table from
 * legacy guardian-binding and ingress-member rows. Runs on daemon boot
 * so that upgrades from pre-contacts versions see their existing
 * relationships in the contacts table immediately.
 *
 * Idempotent — address-based dedup in upsertContact prevents duplicates.
 * Guardian bindings are synced first so guardian contacts exist before
 * member sync, letting upsertContact merge rather than duplicate.
 */

import type { ChannelId } from "../channels/types.js";
import type { GuardianBinding } from "../memory/guardian-bindings.js";
import { listActiveBindingsByAssistant } from "../memory/guardian-bindings.js";
import type { IngressMember } from "../memory/ingress-member-store.js";
import { listMembers } from "../memory/ingress-member-store.js";
import { canonicalizeInboundIdentity } from "../util/canonicalize-identity.js";
import { getLogger } from "../util/logger.js";
import { upsertContact } from "./contact-store.js";
import type { ChannelStatus } from "./types.js";

const log = getLogger("contacts-startup-migration");

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

// ── Guardian binding migration ───────────────────────────────────────

function migrateGuardianBinding(binding: GuardianBinding): void {
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

// ── Ingress member migration ─────────────────────────────────────────

function migrateMember(member: IngressMember): void {
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

// ── Public entry point ───────────────────────────────────────────────

/**
 * Migrate all legacy guardian bindings and ingress members into the
 * contacts table for the given assistant. Guardian bindings are processed
 * first so that guardian contacts exist before member sync — this lets
 * upsertContact's address-based dedup merge them rather than creating
 * duplicates.
 */
export function migrateContactsFromLegacyTables(assistantId: string): void {
  const bindings = listActiveBindingsByAssistant(assistantId);
  for (const binding of bindings) {
    migrateGuardianBinding(binding);
  }
  log.info(
    { count: bindings.length },
    "Migrated guardian bindings to contacts",
  );

  const members = listMembers({ assistantId });
  let memberCount = 0;
  for (const member of members) {
    if (member.status === "pending") continue;
    migrateMember(member);
    memberCount++;
  }
  log.info(
    { count: memberCount },
    "Migrated ingress members to contacts",
  );
}
