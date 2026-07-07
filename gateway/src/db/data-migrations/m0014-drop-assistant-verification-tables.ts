/**
 * One-time migration: drop the assistant's verification tables now that the
 * gateway owns the session lifecycle.
 *
 * Gated on m0013's `one_time_migrations` checkpoint: registration order alone
 * only guarantees m0013 ran *before* this migration, not that it succeeded
 * (the runner continues past a "skip"/throw). The drops run only once the
 * backfill is checkpointed, so a failed backfill can never lose its source
 * tables.
 *
 * Drops `channel_verification_sessions` and `channel_guardian_rate_limits`
 * from the assistant DB via the IPC db proxy. "skip" when either IPC drop
 * fails so the runner retries next boot; DROP TABLE IF EXISTS is idempotent
 * on that retry.
 */

import { Database } from "bun:sqlite";

import { getGatewayDb } from "../connection.js";
import { getLogger } from "../../logger.js";
import { assistantDbRun } from "../assistant-db-proxy.js";

import type { MigrationResult } from "./index.js";

const log = getLogger("m0014-drop-assistant-verification-tables");

function getRawGatewayDb(): Database {
  return (getGatewayDb() as unknown as { $client: Database }).$client;
}

/** `one_time_migrations` key the runner records when m0013 completes. */
export const M0013_CHECKPOINT_KEY = "m0013-verification-sessions-backfill";

export async function up(): Promise<MigrationResult> {
  const gwDb = getRawGatewayDb();

  const backfillDone = gwDb
    .prepare(`SELECT 1 FROM one_time_migrations WHERE key = ?`)
    .get(M0013_CHECKPOINT_KEY);
  if (!backfillDone) {
    log.info(
      "m0014: m0013 checkpoint absent — skipping drops until the backfill completes",
    );
    return "skip";
  }

  try {
    await assistantDbRun(`DROP TABLE IF EXISTS channel_verification_sessions`);
    await assistantDbRun(`DROP TABLE IF EXISTS channel_guardian_rate_limits`);
  } catch (err) {
    log.error(
      { err },
      "m0013: assistant verification table drop failed — will retry on next startup",
    );
    return "skip";
  }

  log.info(
    "m0013: dropped assistant channel_verification_sessions and channel_guardian_rate_limits",
  );
  return "done";
}

export function down(): MigrationResult {
  // No-op: the dropped assistant tables are not restorable.
  return "done";
}
