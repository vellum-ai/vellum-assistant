/**
 * Gateway-first member-channel write relay.
 *
 * The gateway is the ACL source of truth. Each write goes to the gateway first;
 * the assistant-DB write in contacts-write.ts is a best-effort local mirror that
 * never throws and never gates the gateway-owned outcome.
 */

import { MarkChannelRevokedIpcResponseSchema } from "@vellumai/gateway-client/gateway-ipc-contracts";

import { log } from "../daemon/handlers/shared.js";
import { ipcCallPersistent } from "../ipc/gateway-client.js";
import { getChannelById } from "./contact-store.js";
import { revokeMember } from "./contacts-write.js";
import type { ContactWriteResult } from "./types.js";

// ── Revoke ───────────────────────────────────────────────────────────

/**
 * Revoke a member channel gateway-first, then mirror the downgrade to the
 * assistant DB best-effort. The memberId may be a plain channel ID or the
 * composite contactId:channelId form revokeMember accepts.
 *
 * Returns the local ContactWriteResult so callers still get the native
 * contact/channel, or null when the local mirror produces no result.
 */
export async function revokeMemberChannel(
  memberId: string,
  reason?: string,
): Promise<ContactWriteResult | null> {
  const channelId = memberId.includes(":") ? memberId.split(":")[1] : memberId;

  // Skip a redundant relay when the channel is already revoked. The gateway
  // dual-write keeps this local status in sync, so it's an adequate guard
  // without an extra gateway round-trip. A missing local row still relays so
  // the gateway stays authoritative.
  const localChannel = getChannelById(channelId);
  if (localChannel && localChannel.status === "revoked") {
    return null;
  }

  const result = await ipcCallPersistent("mark_channel_revoked", {
    contactChannelId: channelId,
    reason,
  });
  const parsed = MarkChannelRevokedIpcResponseSchema.parse(result);
  if (!parsed.ok) {
    throw new Error("mark_channel_revoked relay returned ok: false");
  }

  return mirrorLocalRevoke(memberId, reason);
}

/** Best-effort local mirror of the revoke. Swallows failures. */
function mirrorLocalRevoke(
  memberId: string,
  reason?: string,
): ContactWriteResult | null {
  try {
    return revokeMember(memberId, reason);
  } catch (err) {
    log.error(
      { err, memberId },
      "Local revoke mirror failed after gateway revoke; gateway downgrade stands",
    );
    return null;
  }
}
