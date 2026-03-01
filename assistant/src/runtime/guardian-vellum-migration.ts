/**
 * Startup migration: backfill channel='vellum' guardian binding.
 *
 * On runtime start, ensures that a guardian binding exists for the
 * 'vellum' channel with a guardianPrincipalId. This is required for
 * the identity-bound hatch bootstrap flow.
 *
 * - If a vellum binding already exists, no-op.
 * - If no vellum binding exists, creates one with a fresh principal.
 * - Preserves existing guardian bindings for other channels unchanged.
 */

import { v4 as uuid } from 'uuid';

import {
  createBinding,
  getActiveBinding,
} from '../memory/guardian-bindings.js';
import { getLogger } from '../util/logger.js';
import { DAEMON_INTERNAL_ASSISTANT_ID } from './assistant-scope.js';

const log = getLogger('guardian-vellum-migration');

/**
 * Ensure a vellum guardian binding exists for the given assistant.
 * Called during daemon startup to backfill existing installations.
 *
 * Returns the guardianPrincipalId (existing or newly created).
 */
export function ensureVellumGuardianBinding(assistantId: string = DAEMON_INTERNAL_ASSISTANT_ID): string {
  const existing = getActiveBinding(assistantId, 'vellum');
  if (existing) {
    log.debug(
      { assistantId, guardianPrincipalId: existing.guardianExternalUserId },
      'Vellum guardian binding already exists',
    );
    return existing.guardianExternalUserId;
  }

  const guardianPrincipalId = `vellum-principal-${uuid()}`;

  createBinding({
    assistantId,
    channel: 'vellum',
    guardianExternalUserId: guardianPrincipalId,
    guardianDeliveryChatId: 'local',
    verifiedVia: 'startup-migration',
    metadataJson: JSON.stringify({ migratedAt: Date.now() }),
  });

  log.info(
    { assistantId, guardianPrincipalId },
    'Backfilled vellum guardian binding on startup',
  );

  return guardianPrincipalId;
}
