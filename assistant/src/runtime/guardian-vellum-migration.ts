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

import { findGuardianForChannel } from "../contacts/contact-store.js";
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
