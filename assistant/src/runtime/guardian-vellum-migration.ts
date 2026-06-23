/**
 * Guardian binding drift healing for the vellum channel.
 *
 * The gateway owns guardian binding creation at startup
 * (`ensureVellumGuardianBinding` in gateway/src/auth/guardian-bootstrap.ts).
 * This module provides drift-healing logic which must remain
 * assistant-side since it reacts to incoming JWT principals.
 */

import {
  findGuardianForChannel,
  updateContactPrincipalAndChannel,
} from "../contacts/contact-store.js";
import {
  getGuardianDelivery,
  guardianForChannel,
} from "../contacts/guardian-delivery-reader.js";
import { getLogger } from "../util/logger.js";

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
 * assistant-mirror row is repaired whenever it diverges from the JWT
 * principal — even when the gateway binding already matches — because the
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
  if (!currentPrincipalId?.startsWith("vellum-principal-")) return false;

  // Resolve the assistant-mirror row whose principal drives local trust.
  const guardianResult = findGuardianForChannel("vellum");
  if (!guardianResult) return false;

  const localPrincipalId = guardianResult.contact.principalId;
  // Only repair auto-generated local principals — never overwrite a real one.
  if (!localPrincipalId?.startsWith("vellum-principal-")) return false;
  // No-op when the local mirror already matches the JWT principal.
  if (localPrincipalId === incomingPrincipalId) return false;

  const updated = updateContactPrincipalAndChannel(
    guardianResult.contact.id,
    guardianResult.channel.id,
    incomingPrincipalId,
  );

  if (!updated) {
    log.warn(
      {
        oldPrincipalId: localPrincipalId,
        newPrincipalId: incomingPrincipalId,
      },
      "Skipped guardian binding drift heal — address collision on contact_channels",
    );
    return false;
  }

  log.info(
    {
      oldPrincipalId: localPrincipalId,
      newPrincipalId: incomingPrincipalId,
    },
    "Healed vellum guardian binding drift — updated local mirror principalId to match JWT actor",
  );

  return true;
}
