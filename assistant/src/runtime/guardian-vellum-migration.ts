/**
 * Guardian binding drift healing for the vellum channel.
 *
 * The gateway owns guardian binding creation at startup
 * (`ensureVellumGuardianBinding` in gateway/src/auth/guardian-bootstrap.ts).
 * This module provides drift-healing logic which must remain
 * assistant-side since it reacts to incoming JWT principals.
 */

import type { ChannelId } from "../channels/types.js";
import {
  findContactByAddress,
  updateContactPrincipalAndChannel,
} from "../contacts/contact-store.js";
import {
  getGuardianDelivery,
  guardianForChannel,
} from "../contacts/guardian-delivery-reader.js";
import type { TrustContext } from "../daemon/trust-context.js";
import { getLogger } from "../util/logger.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "./assistant-scope.js";
import {
  resolveTrustContext,
  withSourceChannel,
} from "./trust-context-resolver.js";

const log = getLogger("guardian-vellum-migration");

/**
 * Heal guardian binding drift for the vellum channel.
 *
 * After a DB reset, the daemon creates a new guardian binding with a fresh
 * `vellum-principal-<uuid>`, but the client may still hold a valid JWT
 * signed with the surviving signing key containing the old principal.
 * The JWT passes signature validation but trust resolution returns
 * `unknown` because the principals don't match.
 *
 * This function detects that scenario and updates the binding to match
 * the JWT's principal. Only heals when both the stored and incoming
 * principals have the `vellum-principal-` prefix (both auto-generated,
 * no external identity meaning). The JWT's signature proves it was
 * minted by this daemon's signing key.
 *
 * Returns true if healing occurred, false otherwise.
 *
 * The gateway binding supplies the authoritative principal; the local
 * assistant-mirror row is repaired to match the JWT principal because the
 * /v1/messages trust path still resolves against the local mirror in this
 * plan. A stale mirror must be repaired or valid guardians stay `unknown`.
 */
export async function healGuardianBindingDrift(
  incomingPrincipalId: string,
): Promise<boolean> {
  if (!incomingPrincipalId.startsWith("vellum-principal-")) {
    return false;
  }

  const guardians = await getGuardianDelivery({ channelTypes: ["vellum"] });
  if (!guardians) return false;
  const guardian = guardianForChannel(guardians, "vellum");
  if (!guardian) return false;

  const currentPrincipalId = guardian.principalId;
  // Only repair auto-generated principals — never overwrite a real one.
  if (!currentPrincipalId?.startsWith("vellum-principal-")) return false;
  // No-op when the principal already matches the JWT principal.
  if (currentPrincipalId === incomingPrincipalId) return false;

  // Resolve the assistant-mirror row to repair so local trust resolution
  // converges on the JWT principal. The gateway delivery supplies the guardian
  // identity (channel + address) but not the local channel UUID write target,
  // so resolve that locally by the guardian's vellum-channel address.
  const localContact = findContactByAddress("vellum", guardian.address);
  const localChannel = localContact?.channels.find(
    (c) => c.type === "vellum",
  );
  if (!localContact || !localChannel) return false;

  const updated = updateContactPrincipalAndChannel(
    localContact.id,
    localChannel.id,
    incomingPrincipalId,
  );

  if (!updated) {
    log.warn(
      {
        oldPrincipalId: currentPrincipalId,
        newPrincipalId: incomingPrincipalId,
      },
      "Skipped guardian binding drift heal — address collision on contact_channels",
    );
    return false;
  }

  log.info(
    {
      oldPrincipalId: currentPrincipalId,
      newPrincipalId: incomingPrincipalId,
    },
    "Healed vellum guardian binding drift — updated local mirror principalId to match JWT actor",
  );

  return true;
}

/**
 * Re-resolve trust from the local mirror only for the narrow vellum-principal
 * reset-drift case; null when it isn't drift (caller keeps the gateway verdict).
 */
export async function reResolveTrustOnResetDrift(
  incomingPrincipalId: string,
  sourceChannel: ChannelId,
): Promise<TrustContext | null> {
  const guardians = await getGuardianDelivery({ channelTypes: ["vellum"] });
  const gatewayPrincipal = guardians
    ? guardianForChannel(guardians, "vellum")?.principalId
    : undefined;
  const isResetDrift =
    incomingPrincipalId.startsWith("vellum-principal-") &&
    !!gatewayPrincipal?.startsWith("vellum-principal-") &&
    gatewayPrincipal !== incomingPrincipalId;
  if (!isResetDrift) return null;
  await healGuardianBindingDrift(incomingPrincipalId);
  return withSourceChannel(
    sourceChannel,
    resolveTrustContext({
      assistantId: DAEMON_INTERNAL_ASSISTANT_ID,
      sourceChannel: "vellum",
      conversationExternalId: "local",
      actorExternalId: incomingPrincipalId,
    }),
  );
}
