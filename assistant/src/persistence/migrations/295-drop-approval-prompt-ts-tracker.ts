import { getLogger } from "../../util/logger.js";
import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

const log = getLogger("migration-295");

/**
 * Drops the `approval_prompt_ts_tracker` table.
 *
 * Guardian approval-by-reaction no longer scopes reactions through a bespoke
 * `(channel, chat, ts)` tracker. The canonical guardian delivery record
 * (`canonical_guardian_deliveries.destination_message_id`) is now the single
 * mapping from a delivered approval card to its request, so this table is dead.
 *
 * Idempotent: `DROP TABLE IF EXISTS` is a no-op once the table is gone.
 */
export function dropApprovalPromptTsTrackerTable(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  raw.run("DROP TABLE IF EXISTS approval_prompt_ts_tracker");
  log.info("Dropped approval_prompt_ts_tracker table");
}
