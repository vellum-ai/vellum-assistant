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
 * Outcome of a gateway-first member activation. The gateway owns the ACL
 * verdict; `activated` carries a stable memberId (gateway channel id, or the
 * local mirror's id when present) regardless of whether the best-effort local
 * mirror produced a row. `refused` means the gateway AUTHORITATIVELY denied the
 * actor (blocked/revoked) — callers must NOT treat it as an activation and the
 * denial is permanent. `unavailable` means the gateway write did NOT land
 * (relay threw / malformed response / no resolvable channel id) — a TRANSIENT
 * condition the caller should treat as retryable, never burning an invite use.
 */
export type ActivateMemberOutcome =
  | { status: "activated"; memberId: string; member: ContactWriteResult | null }
  | { status: "refused" }
  | { status: "unavailable" };

/**
 * Activate a member channel gateway-first, then mirror the activation to the
 * assistant DB best-effort. The gateway owns the ACL outcome; the local mirror
 * supplies the native contact/channel callers still wire downstream.
 *
 * A gateway write failure fails closed: the mirror is identity-only, so a
 * gateway that did not persist the activation must NOT report success off a
 * local row the gateway never verified. Such failures surface as `unavailable`
 * (transient) so callers don't burn an invite use, distinct from an
 * authoritative `refused`.
 *
 * Returns an `activated` outcome with a stable memberId on success, `refused`
 * when the gateway authoritatively denies the actor, or `unavailable` when the
 * gateway write did not land. A best-effort local-mirror failure never
 * downgrades a verified gateway activation.
 */
export async function activateMemberChannel(
  params: ActivateMemberChannelParams,
): Promise<ActivateMemberOutcome> {
  const address = params.externalUserId ?? params.externalChatId;
  const externalChatId = params.externalChatId ?? params.externalUserId;

  let gatewayChannelId: string | undefined;

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
        // Invite redemption may reactivate a revoked member; blocked actors are
        // still refused by the gateway guard.
        allowRevokedReactivation: true,
      });
      const parsed = UpsertVerifiedChannelIpcResponseSchema.parse(result);
      // The gateway refused the actor (blocked/revoked): do NOT mirror an
      // active local channel for an actor the gateway has denied.
      if (!parsed.verified) {
        log.warn(
          { sourceChannel: params.sourceChannel },
          "Gateway refused the channel activation; skipping the local mirror",
        );
        return { status: "refused" };
      }
      gatewayChannelId = parsed.channel?.id;
    } catch (err) {
      // Fail-closed but TRANSIENT: the gateway owns the ACL verdict and the
      // local mirror is identity-only. The gateway write did not land (relay
      // threw / malformed response), so we must not report success — but this
      // is not an authoritative deny, so surface `unavailable` and let the
      // caller retry without consuming an invite use.
      log.warn(
        { err, sourceChannel: params.sourceChannel },
        "upsert_verified_channel relay failed — activation unavailable (gateway write did not land)",
      );
      return { status: "unavailable" };
    }
  }

  const member = mirrorLocalActivation(params);
  const memberId = member?.channel.id ?? gatewayChannelId;
  if (!memberId) {
    // The gateway verified but produced no channel id AND the local mirror
    // produced no row — an inconsistent/transient state, not an authoritative
    // deny. Surface `unavailable` so the caller retries rather than burning the
    // invite use on a missing memberId.
    log.error(
      { sourceChannel: params.sourceChannel },
      "Member activation produced no gateway channel and no local mirror; no memberId to return",
    );
    return { status: "unavailable" };
  }
  return { status: "activated", memberId, member };
}

/**
 * Best-effort local mirror of the activation. Swallows failures. Persists only
 * the native contact/channel identity row — the gateway owns the ACL verdict.
 */
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
      inviteId: params.inviteId,
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
 * Revoke a member channel gateway-first. The gateway owns the ACL outcome; the
 * memberId may be a plain channel ID or the composite contactId:channelId form
 * revokeMember accepts.
 *
 * Returns the locally-resolved native contact/channel for the revoked id, or
 * null when no local row exists. The local read is best-effort and never gates
 * the gateway-owned downgrade.
 */
export async function revokeMemberChannel(
  memberId: string,
  reason?: string,
): Promise<ContactWriteResult | null> {
  const channelId = memberId.includes(":") ? memberId.split(":")[1] : memberId;

  // Always relay; the gateway owns the ACL outcome and mark_channel_revoked is
  // idempotent (already-revoked → didWrite:false). Skipping on the local row
  // status would suppress a needed revoke when the local read lags the gateway.
  const result = await ipcCallPersistent("mark_channel_revoked", {
    contactChannelId: channelId,
    reason,
  });
  const parsed = MarkChannelRevokedIpcResponseSchema.parse(result);
  if (!parsed.ok) {
    throw new Error("mark_channel_revoked relay returned ok: false");
  }

  try {
    return revokeMember(memberId);
  } catch (err) {
    log.error(
      { err, memberId },
      "Local revoke read failed after gateway revoke; gateway downgrade stands",
    );
    return null;
  }
}
