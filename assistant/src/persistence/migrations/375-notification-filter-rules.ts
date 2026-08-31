import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

const PREFERENCES_TABLE = "notification_preferences";

const PREFERENCE_COLUMNS: Array<{ name: string; definition: string }> = [
  { name: "match_json", definition: "TEXT NOT NULL DEFAULT '{}'" },
  { name: "tier", definition: "TEXT" },
  { name: "provenance", definition: "TEXT NOT NULL DEFAULT 'user'" },
  { name: "source_request_id", definition: "TEXT" },
  { name: "status", definition: "TEXT NOT NULL DEFAULT 'active'" },
];

/**
 * Give notification preferences a deterministic layer, and record the two
 * things prose cannot say.
 *
 * `notification_preferences` holds natural-language preferences that are read
 * into a prompt. That is the right shape for nuance and the wrong shape for a
 * verdict the filter has to reach the same way every time. The new columns sit
 * beside the prose rather than replacing it: `match_json` is a structured
 * predicate, `tier` is the verdict the rule asserts when that predicate holds,
 * `provenance` separates a rule the user wrote from one the assistant
 * proposed, `source_request_id` links a proposed rule back to the approval
 * that created it, and `status` retires a rule without deleting it.
 *
 * `tier` is nullable and that nullability is the compatibility story: every
 * row written before this migration keeps `tier = NULL` and stays advisory
 * prose, so an upgrade changes no existing behavior. A row only becomes
 * deterministic once something sets a tier on it.
 *
 * `notification_rule_declines` records the user saying no to a proposal. The
 * `scope_key` is unique because the record is a fact about a scope, not a log
 * of how often it was asked: one row means never ask again. It is separate
 * from the preferences table because a decline is the absence of a rule, and
 * storing it as a disabled rule would let it be read as one.
 *
 * `notification_interactions` is observation, not policy: what the user did
 * with a delivery, keyed to the normalized shape of what was delivered, so
 * behavior can be summarized without re-deriving it from deliveries whose
 * rendering has since changed.
 *
 * Idempotent: each column is guarded by a column-exists check because SQLite
 * has no `ADD COLUMN IF NOT EXISTS`, and the tables and index use
 * `IF NOT EXISTS`.
 */
export function migrateNotificationFilterRules(database: DrizzleDb): void {
  const sqlite = getSqliteFrom(database);

  for (const { name, definition } of PREFERENCE_COLUMNS) {
    if (!tableHasColumn(database, PREFERENCES_TABLE, name)) {
      sqlite.exec(
        /*sql*/ `ALTER TABLE ${PREFERENCES_TABLE} ADD COLUMN ${name} ${definition}`,
      );
    }
  }

  sqlite.exec(/*sql*/ `CREATE TABLE IF NOT EXISTS notification_rule_declines (
       id TEXT PRIMARY KEY,
       scope_key TEXT NOT NULL UNIQUE,
       proposed_tier TEXT NOT NULL,
       request_id TEXT,
       declined_at INTEGER NOT NULL
     )`);

  sqlite.exec(/*sql*/ `CREATE TABLE IF NOT EXISTS notification_interactions (
       id TEXT PRIMARY KEY,
       delivery_id TEXT NOT NULL,
       normalized_json TEXT NOT NULL,
       tier TEXT NOT NULL,
       kind TEXT NOT NULL,
       observed_at INTEGER NOT NULL
     )`);

  sqlite.exec(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_notif_interactions_observed
       ON notification_interactions (observed_at)`);
}
