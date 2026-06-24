/**
 * Gateway-first member-channel write relay.
 *
 * The gateway is the ACL source of truth. Each write goes to the gateway first;
 * the assistant-DB write in contacts-write.ts is a best-effort local mirror that
 * never throws and never gates the gateway-owned outcome.
 */

import {
  MarkChannelRevokedIpcResponseSchema,
  UpsertVerifiedChannelIpcResponseSchema,
} from "@vellumai/gateway-client/gateway-ipc-contracts";

import { log } from "../daemon/handlers/shared.js";
import { ipcCallPersistent } from "../ipc/gateway-client.js";
import { getChannelById } from "./contact-store.js";
import { revokeMember, upsertContactChannel } from "./contacts-write.js";
import type { ContactWriteResult } from "./types.js";

// ── Activate ─────────────────────────────────────────────────────────

export interface ActivateMemberChannelParams {
  sourceChannel: string;
  externalUserId?: string;
  externalChatId?: string;
  contactId?: string;
  displayName?: string;
  username?: string;
  inviteId?: string;
  verifiedAt?: number;
  verifiedVia?: string;
  policy?: string;
}

/**
 * Activate a member channel gateway-first, then mirror the activation to the
 * assistant DB best-effort. The gateway owns the ACL outcome; the local mirror
 * supplies the native contact/channel callers still wire downstream.
 *
 * A gateway failure fails open with a logged warning (matching the redemption
 * service's record_invite_redemption posture) so a transient gateway outage
 * never drops a legitimate activation — the local mirror still stands.
 *
 * Returns the local ContactWriteResult, or null when the mirror yields none.
 */
export async function activateMemberChannel(
  params: ActivateMemberChannelParams,
): Promise<ContactWriteResult | null> {
  const address = params.externalUserId ?? params.externalChatId;
  const externalChatId = params.externalChatId ?? params.externalUserId;

  if (address && externalChatId) {
    try {
      const result = await ipcCallPersistent("upsert_verified_channel", {
        type: params.sourceChannel,
        address,
        externalChatId,
        displayName: params.displayName,
        username: params.username,
        verifiedVia: params.verifiedVia ?? "invite",
        contactId: params.contactId,
      });
      const parsed = UpsertVerifiedChannelIpcResponseSchema.parse(result);
      // The gateway refused the actor (blocked/revoked): do NOT mirror an
      // active local channel for an actor the gateway has denied.
      if (!parsed.verified) {
        log.warn(
          { sourceChannel: params.sourceChannel },
          "Gateway refused the channel activation; skipping the local mirror",
        );
        return null;
      }
    } catch (err) {
      log.warn(
        { err, sourceChannel: params.sourceChannel },
        "upsert_verified_channel relay unavailable — failing open (local mirror still applies)",
      );
    }
  }

  return mirrorLocalActivation(params);
}

/** Best-effort local mirror of the activation. Swallows failures. */
function mirrorLocalActivation(
  params: ActivateMemberChannelParams,
): ContactWriteResult | null {
  try {
    return upsertContactChannel({
      sourceChannel: params.sourceChannel,
      externalUserId: params.externalUserId,
      externalChatId: params.externalChatId,
      displayName: params.displayName,
      username: params.username,
      role: "contact",
      status: "active",
      policy: params.policy ?? "allow",
      inviteId: params.inviteId,
      verifiedAt: params.verifiedAt,
      verifiedVia: params.verifiedVia ?? "invite",
      contactId: params.contactId,
    });
  } catch (err) {
    log.error(
      { err, sourceChannel: params.sourceChannel },
      "Local activation mirror failed after gateway activation; gateway outcome stands",
    );
    return null;
  }
}

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
