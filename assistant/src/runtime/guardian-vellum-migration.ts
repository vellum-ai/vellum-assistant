/**
 * Startup migration: backfill channel='vellum' guardian binding.
 *
 * On runtime start, ensures that a guardian binding exists for the
 * 'vellum' channel with a guardianPrincipalId. This is required for
 * the identity-bound hatch bootstrap flow.
 *
 * - If a vellum binding already exists with a guardianPrincipalId, no-op.
 * - If a vellum binding exists but lacks guardianPrincipalId, backfill it
 *   from the binding's guardianExternalUserId.
 * - If no vellum binding exists, creates one with a fresh principal.
 * - Preserves existing guardian bindings for other channels unchanged.
 */

import { eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';

import {
  createBinding,
  getActiveBinding,
} from '../memory/guardian-bindings.js';
import { getDb } from '../memory/db.js';
import { channelGuardianBindings } from '../memory/schema.js';
import { getLogger } from '../util/logger.js';
import { DAEMON_INTERNAL_ASSISTANT_ID } from './assistant-scope.js';

const log = getLogger('guardian-vellum-migration');

/**
 * Ensure a vellum guardian binding exists for the given assistant,
 * with a populated guardianPrincipalId.
 * Called during daemon startup to backfill existing installations.
 *
 * Returns the guardianPrincipalId (existing or newly created).
 */
export function ensureVellumGuardianBinding(assistantId: string = DAEMON_INTERNAL_ASSISTANT_ID): string {
  const existing = getActiveBinding(assistantId, 'vellum');
  if (existing) {
    // If the binding exists but is missing guardianPrincipalId, backfill it
    // from the binding's guardianExternalUserId (the canonical identity).
    if (!existing.guardianPrincipalId) {
      const principalId = existing.guardianExternalUserId;
      const db = getDb();
      db.update(channelGuardianBindings)
        .set({ guardianPrincipalId: principalId, updatedAt: Date.now() })
        .where(eq(channelGuardianBindings.id, existing.id))
        .run();

      log.info(
        { assistantId, guardianPrincipalId: principalId },
        'Backfilled guardianPrincipalId on existing vellum binding',
      );
      return principalId;
    }

    log.debug(
      { assistantId, guardianPrincipalId: existing.guardianPrincipalId },
      'Vellum guardian binding already exists with principal',
    );
    return existing.guardianPrincipalId;
  }

  const guardianPrincipalId = `vellum-principal-${uuid()}`;

  createBinding({
    assistantId,
    channel: 'vellum',
    guardianExternalUserId: guardianPrincipalId,
    guardianDeliveryChatId: 'local',
    guardianPrincipalId,
    verifiedVia: 'startup-migration',
    metadataJson: JSON.stringify({ migratedAt: Date.now() }),
  });

  log.info(
    { assistantId, guardianPrincipalId },
    'Backfilled vellum guardian binding on startup',
  );

  return guardianPrincipalId;
}
