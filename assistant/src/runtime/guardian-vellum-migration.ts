/**
 * Startup migration: backfill channel='vellum' guardian binding.
 *
 * On runtime start, ensures that a guardian binding exists for the
 * 'vellum' channel with a guardianPrincipalId. This is required for
 * the identity-bound hatch bootstrap flow.
 *
 * - If a vellum binding already exists, returns its guardianPrincipalId.
 * - If no vellum binding exists, creates one with a fresh principal.
 * - Preserves existing guardian bindings for other channels unchanged.
 */

import { v4 as uuid } from "uuid";

import {
  findGuardianForChannel,
  updateContactPrincipalAndChannel,
} from "../contacts/contact-store.js";
import { createGuardianBinding } from "../contacts/contacts-write.js";
import { getLogger } from "../util/logger.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "./assistant-scope.js";

const log = getLogger("guardian-vellum-migration");

/**
 * Ensure a vellum guardian binding exists for the given assistant,
 * with a populated guardianPrincipalId.
 * Called during daemon startup to backfill existing installations.
 *
 * Returns the guardianPrincipalId (existing or newly created).
 */
export function ensureVellumGuardianBinding(
  assistantId: string = DAEMON_INTERNAL_ASSISTANT_ID,
): string {
  const guardianResult = findGuardianForChannel("vellum");
  if (guardianResult && guardianResult.contact.principalId) {
    log.debug(
      { assistantId, guardianPrincipalId: guardianResult.contact.principalId },
      "Vellum guardian binding already exists with principal",
    );
    return guardianResult.contact.principalId;
  }

  const guardianPrincipalId = `vellum-principal-${uuid()}`;

  try {
    createGuardianBinding({
      channel: "vellum",
      guardianExternalUserId: guardianPrincipalId,
      guardianDeliveryChatId: "local",
      guardianPrincipalId,
      verifiedVia: "startup-migration",
      metadataJson: JSON.stringify({ migratedAt: Date.now() }),
    });
  } catch (err) {
    // A concurrent call or legacy binding may already occupy this slot.
    // Re-check contacts; if a binding now exists, return it instead of throwing.
    const existing = findGuardianForChannel("vellum");
    if (existing?.contact.principalId) {
      log.debug(
        { assistantId, guardianPrincipalId: existing.contact.principalId },
        "Vellum guardian binding creation conflicted — returning existing principal",
      );
      return existing.contact.principalId;
    }
    throw err;
  }

  log.info(
    { assistantId, guardianPrincipalId },
    "Backfilled vellum guardian binding on startup",
  );

  return guardianPrincipalId;
}

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
 */
export function healGuardianBindingDrift(incomingPrincipalId: string): boolean {
  if (!incomingPrincipalId.startsWith("vellum-principal-")) {
    return false;
  }

  const guardianResult = findGuardianForChannel("vellum");
  if (!guardianResult) return false;

  const currentPrincipalId = guardianResult.contact.principalId;
  if (!currentPrincipalId?.startsWith("vellum-principal-")) return false;
  if (currentPrincipalId === incomingPrincipalId) return false;

  const updated = updateContactPrincipalAndChannel(
    guardianResult.contact.id,
    guardianResult.channel.id,
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
    "Healed vellum guardian binding drift — updated principalId to match JWT actor",
  );

  return true;
}
