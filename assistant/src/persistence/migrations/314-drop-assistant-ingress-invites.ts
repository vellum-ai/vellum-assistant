import { getLogger } from "../../util/logger.js";
import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

const log = getLogger("migration-314");

/**
 * Drops the `assistant_ingress_invites` table and the
 * `contact_channels.invite_id` column.
 *
 * The gateway's `ingress_invites` table owns the invite lifecycle (A2A invites
 * live in the daemon's `a2a_invites` table), so the assistant-side invite
 * mirror is dead weight. No DROP INDEX needed: `invite_id` is not covered by
 * any contact_channels index and carries no FK.
 *
 * Idempotent: DROP TABLE IF EXISTS + a column-presence guard on the drop.
 */
export function migrateDropAssistantIngressInvites(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  raw.exec(/*sql*/ `DROP TABLE IF EXISTS assistant_ingress_invites`);

  if (!tableHasColumn(database, "contact_channels", "invite_id")) {
    return;
  }
  raw.run(/*sql*/ `ALTER TABLE contact_channels DROP COLUMN invite_id`);
  log.info("Dropped invite_id column from contact_channels");
}
