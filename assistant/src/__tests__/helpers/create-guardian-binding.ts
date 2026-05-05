/**
 * Test-only helper to create a guardian binding by writing directly to the
 * contacts DB. Extracted from contacts-write.ts after the production code
 * path was moved to the gateway.
 */

import type { ChannelId } from "../../channels/types.js";
import { upsertContact } from "../../contacts/contact-store.js";
import type { GuardianBinding } from "../../memory/channel-verification-sessions.js";
import { ensureGuardianPersonaFile } from "../../prompts/persona-resolver.js";
import { canonicalizeInboundIdentity } from "../../util/canonicalize-identity.js";

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

export function createGuardianBinding(params: {
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

  const contact = upsertContact({
    displayName,
    role: "guardian",
    notes: "guardian",
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

  // Seed persona file (mirrors gateway's production behavior)
  if (contact.userFile) {
    try {
      ensureGuardianPersonaFile(contact.userFile);
    } catch {
      // Tolerate filesystem failures in tests
    }
  }

  const now = Date.now();
  return {
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
}
