/**
 * Gateway-first member-channel write relay.
 *
 * The gateway is the ACL source of truth. Each write goes to the gateway first;
 * the assistant-DB write in contacts-write.ts is a best-effort local mirror that
 * never throws and never gates the gateway-owned outcome.
 */

import {
  CreateContactIpcResponseSchema,
  MarkChannelRevokedIpcResponseSchema,
  UpsertVerifiedChannelIpcResponseSchema,
} from "@vellumai/gateway-client/gateway-ipc-contracts";

import { log } from "../daemon/handlers/shared.js";
import { ipcCallPersistent } from "../ipc/gateway-client.js";
import { findContactChannel } from "./contact-store.js";
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
  verifiedVia?: string;
  policy?: string;
}

/**
 * Outcome of a gateway-first member activation. The gateway owns the ACL
 * verdict; `activated` carries a stable memberId (gateway channel id, or the
 * local mirror's id when present) regardless of whether the best-effort local
 * mirror produced a row. `refused` means the gateway authoritatively denied the
 * actor (blocked/revoked) — callers must NOT treat it as an activation.
 */
export type ActivateMemberOutcome =
  | { status: "activated"; memberId: string; member: ContactWriteResult | null }
  | { status: "refused" };

/**
 * Activate a member channel gateway-first, then mirror the activation to the
 * assistant DB best-effort. The gateway owns the ACL outcome; the local mirror
 * supplies the native contact/channel callers still wire downstream.
 *
 * A gateway write failure fails closed: the mirror is identity-only, so a
 * gateway that did not persist the activation must surface as `refused` rather
 * than reporting success off a local row the gateway never verified.
 *
 * Returns an `activated` outcome with a stable memberId on success, or
 * `refused` when the gateway denies the actor or the gateway write fails. A
 * best-effort local-mirror failure never downgrades a verified gateway
 * activation.
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
      // Fail-closed: the gateway owns the ACL verdict and the local mirror is
      // identity-only. If the gateway write did not land, the activation is not
      // persisted to the source of truth, so we must not report success.
      log.warn(
        { err, sourceChannel: params.sourceChannel },
        "upsert_verified_channel relay failed — refusing activation (gateway write did not land)",
      );
      return { status: "refused" };
    }
  }

  const member = mirrorLocalActivation(params);
  const memberId = member?.channel.id ?? gatewayChannelId;
  if (!memberId) {
    // No gateway channel (the relay threw or was skipped) AND no local mirror —
    // no stable id to hand the caller. Surface as refused so the caller maps it
    // to a non-redeemed outcome instead of crashing on a missing memberId.
    log.error(
      { sourceChannel: params.sourceChannel },
      "Member activation produced no gateway channel and no local mirror; no memberId to return",
    );
    return { status: "refused" };
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

// ── Block ────────────────────────────────────────────────────────────

export interface BlockSenderChannelParams {
  sourceChannel: string;
  externalUserId: string;
  displayName?: string;
  /** Audit reason written to the gateway channel's revokedReason. */
  reason?: string;
}

/**
 * Block a sender's channel gateway-first: ensure a contact/channel row exists
 * for the (channel, address) pair, then mark it revoked so future inbound
 * resolves as `unknown` and is hard-denied. Used by the introduction card's
 * **Block** action for senders that may have no contact record yet.
 *
 * The gateway owns the verdict: `create_contact` preserves an existing row's
 * status, and `mark_channel_revoked` is idempotent (already-revoked →
 * didWrite:false) and refuses to downgrade a guardian channel. Fails closed —
 * a relay failure surfaces as `revoked: false` so callers never report a block
 * the gateway did not persist. The assistant-DB status update is a best-effort
 * mirror.
 */
export async function blockSenderChannel(
  params: BlockSenderChannelParams,
): Promise<{ revoked: boolean }> {
  let channelId: string;
  try {
    const created = await ipcCallPersistent("create_contact", {
      channelType: params.sourceChannel,
      address: params.externalUserId,
      ...(params.displayName ? { displayName: params.displayName } : {}),
    });
    channelId = CreateContactIpcResponseSchema.parse(created).channelId;
  } catch (err) {
    log.warn(
      { err, sourceChannel: params.sourceChannel },
      "create_contact relay failed — refusing block (no gateway channel row)",
    );
    return { revoked: false };
  }
  if (!channelId) {
    log.error(
      { sourceChannel: params.sourceChannel },
      "create_contact returned no channel id — refusing block",
    );
    return { revoked: false };
  }

  try {
    const result = await ipcCallPersistent("mark_channel_revoked", {
      contactChannelId: channelId,
      reason: params.reason,
    });
    const parsed = MarkChannelRevokedIpcResponseSchema.parse(result);
    if (!parsed.ok) {
      return { revoked: false };
    }
  } catch (err) {
    log.warn(
      { err, sourceChannel: params.sourceChannel },
      "mark_channel_revoked relay failed — block did not land on the gateway",
    );
    return { revoked: false };
  }

  // Best-effort local mirror so the Contacts page reflects the downgrade.
  // Resolved by logical (type, address) key — the local mirror row's id is
  // not guaranteed to match the gateway channel id.
  try {
    const local = findContactChannel({
      channelType: params.sourceChannel,
      address: params.externalUserId,
    });
    if (local) {
      revokeMember(local.channel.id);
    }
  } catch {
    // The local row may not exist for a brand-new sender; the gateway
    // outcome stands.
  }
  return { revoked: true };
}

// ── Seed unverified ──────────────────────────────────────────────────

export interface SeedUnverifiedMemberChannelParams {
  sourceChannel: string;
  externalUserId: string;
  displayName?: string;
}

/**
 * Seed a contact channel for a sender at the `unverified` admission tier,
 * gateway-first. Used when the guardian denies an access request: the sender
 * becomes a known `unverified_contact` — no longer an unknown stranger — so
 * subsequent inbound resolves as `unverified_contact` instead of re-running
 * discovery.
 *
 * Delegates to the gateway `create_contact` IPC, which upserts via
 * `ContactStore.upsertContact` (gateway DB is the ACL source of truth, with a
 * best-effort assistant-DB mirror). A brand-new channel lands at status
 * `unverified`; an existing channel's status is preserved, so a blocked,
 * revoked, or already-active row is never reactivated or downgraded.
 *
 * Best-effort: the gateway owns the ACL verdict, so a failed relay is logged
 * and swallowed — it must never fail the guardian's deny decision.
 */
export async function seedUnverifiedMemberChannel(
  params: SeedUnverifiedMemberChannelParams,
): Promise<void> {
  try {
    await ipcCallPersistent("create_contact", {
      channelType: params.sourceChannel,
      address: params.externalUserId,
      ...(params.displayName ? { displayName: params.displayName } : {}),
    });
  } catch (err) {
    log.warn(
      { err, sourceChannel: params.sourceChannel },
      "seed_unverified_channel relay failed (best-effort); sender not persisted as unverified_contact",
    );
  }
}
