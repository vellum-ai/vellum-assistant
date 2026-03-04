/**
 * Legacy startup migration stub.
 *
 * Previously this populated the contacts table from legacy guardian-binding
 * and ingress-member rows on daemon boot. That sync is now handled by the
 * DB migration (131-drop-legacy-member-guardian-tables) which safety-syncs
 * remaining data then drops both legacy tables. This stub is kept to avoid
 * breaking callers; it simply no-ops.
 */

import { getLogger } from "../util/logger.js";

const log = getLogger("contacts-startup-migration");

/**
 * No-op — legacy tables have been dropped. The DB migration
 * (131-drop-legacy-member-guardian-tables) performed the final sync.
 */
export function migrateContactsFromLegacyTables(_assistantId: string): void {
  log.debug("Legacy startup migration skipped — tables already dropped");
}
