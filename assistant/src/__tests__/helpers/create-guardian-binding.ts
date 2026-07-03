/**
 * Test-only helper to create a guardian binding by writing directly to the
 * contacts DB. Extracted from contacts-write.ts after the production code
 * path was moved to the gateway.
 */

import type { GuardianBinding } from "../../channels/channel-verification-sessions.js";
import { getContact } from "../../contacts/contact-store.js";
import { ensureGuardianPersonaFile } from "../../prompts/persona-resolver.js";
import { seedContactChannel } from "./seed-contact-channel.js";

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
  const displayName =
    parseDisplayNameFromMetadata(params.metadataJson) ??
    params.guardianExternalUserId;

  // The production identity upsert no longer writes ACL columns (gateway-owned);
  // seedContactChannel stamps the guardian ACL state directly so the local
  // guardian-resolution reads still under test resolve this binding.
  const { contactId } = seedContactChannel({
    sourceChannel: params.channel,
    externalUserId: params.guardianExternalUserId,
    externalChatId: params.guardianDeliveryChatId,
    displayName,
    role: "guardian",
    principalId: params.guardianPrincipalId,
    status: "active",
    verifiedAt: Date.now(),
    verifiedVia: params.verifiedVia ?? "challenge",
  });

  // Seed persona file (mirrors gateway's production behavior)
  const userFile = getContact(contactId)?.userFile;
  if (userFile) {
    try {
      ensureGuardianPersonaFile(userFile);
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
