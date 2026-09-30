/**
 * Redeems a `vellum-shared` invite link token for a new trusted-contact
 * principal and a device-bound token pair.
 */

import { randomUUID } from "node:crypto";

import { hashInviteToken } from "@vellumai/gateway-client";

import { mintAndRecordDeviceBoundTokenPair } from "../auth/guardian-bootstrap.js";
import { getGatewayDb } from "../db/connection.js";
import {
  BindContactPrincipalError,
  ContactStore,
  SHARED_PRINCIPAL_CHANNEL_TYPE,
  writeSharedPrincipalChannel,
} from "../db/contact-store.js";
import { ipcCallAssistant } from "../ipc/assistant-client.js";
import { getLogger } from "../logger.js";
import { claimInvite } from "./invite-redemption.js";

const log = getLogger("shared-invite-redemption");

/** Platform recorded on a contact's token rows. */
const CONTACT_TOKEN_PLATFORM = "web";

export type SharedInviteRedemptionResult =
  | {
      status: "redeemed";
      principalId: string;
      accessToken: string;
      accessTokenExpiresAt: number;
      refreshToken: string;
    }
  /** No live, unused `vellum-shared` invite matches the token. */
  | { status: "invalid" }
  /** The invite's contact cannot take a new principal. */
  | { status: "contact_unavailable" };

/**
 * Redeem a `vellum-shared` invite by its link token: claim one use, mint a
 * fresh principal, record it on the invite's contact, and mint a contact-role
 * token pair bound to `deviceId`.
 *
 * Only the link token redeems. The lookup is by token hash, so the invite's
 * 6-digit code never matches. The claim, the channel write, the principal
 * binding and the token records commit in one transaction, so a failure after
 * the claim leaves the invite redeemable.
 */
export function redeemSharedInvite(params: {
  token: string;
  deviceId: string;
}): SharedInviteRedemptionResult {
  const store = new ContactStore();
  const principalId = randomUUID();

  let result: SharedInviteRedemptionResult;
  try {
    result = getGatewayDb().transaction((): SharedInviteRedemptionResult => {
      const invite = store.findInviteByTokenHash(hashInviteToken(params.token));
      if (!invite) {
        return { status: "invalid" };
      }

      const failure = claimInvite(store, invite, {
        sourceChannel: SHARED_PRINCIPAL_CHANNEL_TYPE,
        redeemedByExternalUserId: principalId,
      });
      if (failure) {
        log.info(
          { inviteId: invite.id, reason: failure },
          "Shared invite redemption refused",
        );
        return { status: "invalid" };
      }

      writeSharedPrincipalChannel({
        contactId: invite.contactId,
        principalId,
        inviteId: invite.id,
      });
      const pair = mintAndRecordDeviceBoundTokenPair({
        guardianPrincipalId: principalId,
        deviceId: params.deviceId,
        platform: CONTACT_TOKEN_PLATFORM,
        role: "contact",
      });

      log.info(
        { inviteId: invite.id, contactId: invite.contactId },
        "Shared invite redeemed",
      );
      return {
        status: "redeemed",
        principalId,
        accessToken: pair.accessToken,
        accessTokenExpiresAt: pair.accessTokenExpiresAt,
        refreshToken: pair.refreshToken,
      };
    });
  } catch (err) {
    if (err instanceof BindContactPrincipalError) {
      log.warn(
        { err: err.message },
        "Shared invite redemption refused: contact cannot take a principal",
      );
      return { status: "contact_unavailable" };
    }
    throw err;
  }

  if (result.status === "redeemed") {
    void ipcCallAssistant("emit_event", {
      body: { kind: "contacts_changed" },
    } as unknown as Record<string, unknown>).catch(() => {});
  }
  return result;
}
