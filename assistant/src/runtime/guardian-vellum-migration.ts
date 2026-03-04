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
import { createGuardianBindingContactsFirst } from "../contacts/contacts-write.js";
import { getActiveBinding } from "../memory/guardian-bindings.js";
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

  // Fallback: check the legacy channel_guardian_bindings table. On first
  // startup after the contacts migration, the contacts table may not yet
  // have the guardian entry. If found, sync it into contacts so downstream
  // trust resolution (which reads contacts only) sees it immediately.
  const legacyBinding = getActiveBinding(assistantId, "vellum");
  if (legacyBinding) {
    createGuardianBindingContactsFirst({
      assistantId,
      channel: "vellum",
      guardianExternalUserId: legacyBinding.guardianExternalUserId,
      guardianDeliveryChatId: legacyBinding.guardianDeliveryChatId,
      guardianPrincipalId: legacyBinding.guardianPrincipalId,
      verifiedVia: legacyBinding.verifiedVia,
      metadataJson: legacyBinding.metadataJson,
    });
    log.info(
      { assistantId, guardianPrincipalId: legacyBinding.guardianPrincipalId },
      "Synced legacy vellum guardian binding into contacts",
    );
    return legacyBinding.guardianPrincipalId;
  }

  const guardianPrincipalId = `vellum-principal-${uuid()}`;

  createGuardianBindingContactsFirst({
    assistantId,
    channel: "vellum",
    guardianExternalUserId: guardianPrincipalId,
    guardianDeliveryChatId: "local",
    guardianPrincipalId,
    verifiedVia: "startup-migration",
    metadataJson: JSON.stringify({ migratedAt: Date.now() }),
  });

  log.info(
    { assistantId, guardianPrincipalId },
    "Backfilled vellum guardian binding on startup",
  );

  return guardianPrincipalId;
}
