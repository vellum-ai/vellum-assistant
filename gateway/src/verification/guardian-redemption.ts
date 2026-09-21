/**
 * The guardian binding a redeemed guardian code is allowed to make.
 *
 * A code proves its sender holds a secret. Whether that identity may take a
 * channel from the guardian already on it is the guardian's decision, made at
 * mint and recorded on the session (`replacesGuardianAddress`). Redemption
 * reads that record and nothing else: a code that names no guardian binds
 * only a channel without another one.
 *
 * Synchronous over the gateway DB, so the refusal checks, the revoke and the
 * binding writes commit together or not at all. The assistant mirror follows
 * the commit (`mirrorGuardianBinding`).
 */

import type { GuardianBindingGatewayWrites } from "../auth/guardian-bootstrap.js";
import { applyGuardianBindingGatewayWrites } from "../auth/guardian-bootstrap.js";
import { getGatewayDb } from "../db/connection.js";
import { getLogger } from "../logger.js";

import {
  activeGuardianAddresses,
  resolveCanonicalPrincipal,
  revokeExistingChannelGuardian,
} from "./binding-helpers.js";
import { gatewayChannelStatus } from "./contact-helpers.js";

const log = getLogger("guardian-redemption");

export interface RedeemedGuardianBindingParams {
  channel: string;
  /** Canonical sender identity that redeemed the code. */
  externalUserId: string;
  deliveryChatId: string;
  displayName?: string;
  /** The redeemed session's `replacesGuardianAddress`. */
  replacesGuardianAddress: string | null;
}

export type RedeemedGuardianBindingResult =
  | { bound: true; writes: GuardianBindingGatewayWrites }
  | { bound: false; reason: "blocked" | "replace_not_consented" };

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Bind the sender of a redeemed guardian code as the channel's guardian.
 *
 * Refuses, writing nothing, when:
 *
 * - the sender's own row on the channel is blocked. The binding writer leaves
 *   a blocked row untouched without saying so, so revoking first would leave
 *   the channel with no guardian. A revoked row is reactivated: redeeming a
 *   guardian code is a fresh verification act.
 * - another identity is the channel's active guardian and the code does not
 *   name it. Every such identity has to be the one the guardian consented to
 *   replace, so a second active row is weighed instead of overlooked.
 */
export function applyRedeemedGuardianBinding(
  params: RedeemedGuardianBindingParams,
): RedeemedGuardianBindingResult {
  const { channel, externalUserId, replacesGuardianAddress } = params;

  return getGatewayDb().transaction(() => {
    if (gatewayChannelStatus(channel, externalUserId) === "blocked") {
      log.warn(
        { channel, address: externalUserId },
        "Guardian code refused: the sender's channel is blocked",
      );
      return { bound: false, reason: "blocked" } as const;
    }

    const otherGuardians = activeGuardianAddresses(channel).filter(
      (address) => !sameAddress(address, externalUserId),
    );
    const consented =
      replacesGuardianAddress !== null &&
      otherGuardians.every((address) =>
        sameAddress(address, replacesGuardianAddress),
      );
    if (otherGuardians.length > 0 && !consented) {
      log.warn(
        { channel, sender: externalUserId, guardians: otherGuardians },
        "Guardian code refused: the channel has a guardian this code was not minted to replace",
      );
      return { bound: false, reason: "replace_not_consented" } as const;
    }

    if (otherGuardians.length > 0) {
      log.info(
        { channel, sender: externalUserId, replaced: otherGuardians },
        "Guardian code replaces the channel's guardian, as consented at mint",
      );
    }

    revokeExistingChannelGuardian(channel);
    const writes = applyGuardianBindingGatewayWrites({
      channel,
      externalUserId,
      deliveryChatId: params.deliveryChatId,
      guardianPrincipalId: resolveCanonicalPrincipal(externalUserId),
      displayName: params.displayName,
      verifiedVia: "challenge",
      reactivateRevoked: true,
    });
    return { bound: true, writes } as const;
  });
}
