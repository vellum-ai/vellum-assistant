import { Database } from "bun:sqlite";

import { getLogger } from "../../util/logger.js";
import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

const log = getLogger("migration-305");

/**
 * Drops the redundant contact ACL columns now owned by the gateway DB.
 *
 * Combo 11 Phase B: the gateway DB is the source of truth for contact ACL,
 * making these assistant-DB columns redundant mirrors. Phase A drained the
 * runtime reads; gateway data migrations m0006/m0008 still read them to seed a
 * pre-cutover gateway, and checkpoint once they are gone.
 *
 * No DROP INDEX needed: the only contact_channels index
 * (idx_contact_channels_type_ext_chat on (type, external_chat_id)) covers none
 * of these columns.
 *
 * Idempotent: each drop is guarded on PRAGMA table_info.
 */
export function migrateDropContactAclColumns(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  dropColumnIfPresent(raw, "contacts", "role");
  dropColumnIfPresent(raw, "contacts", "principal_id");
  dropColumnIfPresent(raw, "contact_channels", "status");
  dropColumnIfPresent(raw, "contact_channels", "policy");
  dropColumnIfPresent(raw, "contact_channels", "verified_at");
  dropColumnIfPresent(raw, "contact_channels", "verified_via");
  dropColumnIfPresent(raw, "contact_channels", "revoked_reason");
  dropColumnIfPresent(raw, "contact_channels", "blocked_reason");
}

function dropColumnIfPresent(
  raw: Database,
  table: string,
  column: string,
): void {
  const cols = raw.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === column)) {
    log.info(`${table}.${column} already absent — skipping`);
    return;
  }

  raw.run(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  log.info(`Dropped ${column} column from ${table}`);
}
