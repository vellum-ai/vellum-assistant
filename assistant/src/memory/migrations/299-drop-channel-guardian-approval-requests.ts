import { getLogger } from "../../util/logger.js";
import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

const log = getLogger("migration-299");

/**
 * Drops the `channel_guardian_approval_requests` table.
 *
 * Guardian approvals now flow exclusively through the canonical pipeline
 * (`canonical_guardian_requests` + per-kind resolvers). The legacy table lost
 * its production writer when channel reactions, callbacks, and text decisions
 * were migrated to the canonical store, leaving every reader a no-op, so the
 * table is dead.
 *
 * Idempotent: `DROP TABLE IF EXISTS` is a no-op once the table is gone.
 */
export function dropChannelGuardianApprovalRequestsTable(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);
  raw.run("DROP TABLE IF EXISTS channel_guardian_approval_requests");
  log.info("Dropped channel_guardian_approval_requests table");
}
