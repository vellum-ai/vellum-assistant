/**
 * Dual-write helper: syncs contact data to the gateway DB via IPC.
 *
 * All writes are best-effort — failures are logged but never propagate
 * to the caller. The assistant DB remains the primary write path;
 * gateway sync is additive for the ingress-ownership migration.
 */

import { ipcCall } from "../ipc/gateway-client.js";
import { getLogger } from "../util/logger.js";
import type { ContactWithChannels } from "./types.js";

const log = getLogger("contacts-gateway-dual-write");

/**
 * Sync a contact and its channels to the gateway DB.
 *
 * Maps the assistant's `ContactWithChannels` to the gateway's
 * ingress-relevant subset (drops context-only fields like notes,
 * userFile, contactType) and sends it via the `upsert_contact_with_channels`
 * IPC method.
 *
 * Fire-and-forget — callers should not await this.
 */
export function syncContactToGateway(contact: ContactWithChannels): void {
  const payload = {
    contact: {
      id: contact.id,
      displayName: contact.displayName,
      role: contact.role,
      principalId: contact.principalId,
      createdAt: contact.createdAt,
      updatedAt: contact.updatedAt,
    },
    channels: contact.channels.map((ch) => ({
      id: ch.id,
      contactId: ch.contactId,
      type: ch.type,
      address: ch.address,
      isPrimary: ch.isPrimary,
      externalUserId: ch.externalUserId,
      externalChatId: ch.externalChatId,
      status: ch.status,
      policy: ch.policy,
      verifiedAt: ch.verifiedAt,
      verifiedVia: ch.verifiedVia,
      inviteId: ch.inviteId,
      revokedReason: ch.revokedReason,
      blockedReason: ch.blockedReason,
      lastSeenAt: ch.lastSeenAt,
      interactionCount: ch.interactionCount,
      lastInteraction: ch.lastInteraction,
      createdAt: ch.createdAt,
      updatedAt: ch.updatedAt,
    })),
  };

  ipcCall("upsert_contact_with_channels", payload).catch((err) => {
    log.warn(
      { err, contactId: contact.id },
      "Failed to dual-write contact to gateway",
    );
  });
}
