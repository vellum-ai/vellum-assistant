import { getLogger } from "../../util/logger.js";
import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

const log = getLogger("migration-316");

/**
 * Drops the `contact_channels.invite_id` column.
 *
 * The gateway's `ingress_invites` table owns the invite lifecycle (A2A invites
 * live in the daemon's `a2a_invites` table), so the assistant-side column is
 * dead weight. The `assistant_ingress_invites` table is dropped by gateway
 * data migration m0010 — not here — because gateway m0009 must backfill its
 * rows first, and assistant migrations run at daemon boot, before the
 * gateway's post-assistant-ready data-migration pass.
 *
 * No DROP INDEX needed: `invite_id` is not covered by any contact_channels
 * index and carries no FK. Idempotent via the column-presence guard.
 */
export function migrateDropContactChannelInviteId(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  if (!tableHasColumn(database, "contact_channels", "invite_id")) {
    return;
  }
  raw.run(/*sql*/ `ALTER TABLE contact_channels DROP COLUMN invite_id`);
  log.info("Dropped invite_id column from contact_channels");
}
