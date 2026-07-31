/**
 * One-time migration: finalize gateway ownership of ingress invites.
 *
 * Gated on m0009's `one_time_migrations` checkpoint: registration order alone
 * only guarantees m0009 ran *before* this migration, not that it succeeded
 * (the runner continues past a "skip"/throw). Both steps below run only once
 * the full-field backfill is checkpointed, so a failed backfill can never
 * lose its source table, and the a2a purge cannot delete gateway-native a2a
 * rows created between boots while the backfill retries.
 *
 * 1. Purges `source_channel = 'a2a'` rows from the gateway `ingress_invites`
 *    table. m0007 copied every assistant invite, but A2A invites live in the
 *    daemon's `a2a_invites` table, so the copies are phantoms in the
 *    gateway-native list/revoke surfaces.
 * 2. Drops the assistant's `assistant_ingress_invites` table via the IPC db
 *    proxy; m0009's missing-table bail therefore only occurs on fresh
 *    installs or once this drop has completed.
 *
 * "skip" when the IPC drop fails so the runner retries next boot; the a2a
 * purge is idempotent and re-runs harmlessly on that retry.
 */

import { Database } from "bun:sqlite";

import { getGatewayDb } from "../connection.js";
import { getLogger } from "../../logger.js";
import { assistantDbRun } from "../assistant-db-proxy.js";

import type { MigrationResult } from "./index.js";

const log = getLogger("m0010-drop-assistant-ingress-invites");

function getRawGatewayDb(): Database {
  return (getGatewayDb() as unknown as { $client: Database }).$client;
}

/** `one_time_migrations` key the runner records when m0009 completes. */
export const M0009_CHECKPOINT_KEY = "m0009-invite-fields-backfill";

export async function up(): Promise<MigrationResult> {
  const gwDb = getRawGatewayDb();

  const backfillDone = gwDb
    .prepare(`SELECT 1 FROM one_time_migrations WHERE key = ?`)
    .get(M0009_CHECKPOINT_KEY);
  if (!backfillDone) {
    log.info(
      "m0010: m0009 checkpoint absent — skipping purge + drop until the backfill completes",
    );
    return "skip";
  }

  const purgedA2a = gwDb
    .prepare(`DELETE FROM ingress_invites WHERE source_channel = 'a2a'`)
    .run().changes;

  try {
    await assistantDbRun(`DROP TABLE IF EXISTS assistant_ingress_invites`);
  } catch (err) {
    log.error(
      { err, purgedA2a },
      "m0010: assistant invite table drop failed — will retry on next startup",
    );
    return "skip";
  }

  log.info(
    { purgedA2a },
    "m0010: purged phantom a2a invites and dropped assistant_ingress_invites",
  );
  return "done";
}

export function down(): MigrationResult {
  // No-op: the dropped assistant table and purged phantom rows are not restorable.
  return "done";
}
