import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

/**
 * Phase 5 kickoff: normalized personal-knowledge storage.
 *
 * Adds:
 * - pkb_entities
 * - pkb_episodes
 * - pkb_preferences
 *
 * Uses IF NOT EXISTS for idempotency.
 */
export function migratePkbEntityEpisodeTables(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  raw.exec(`
    CREATE TABLE IF NOT EXISTS pkb_entities (
      id              TEXT PRIMARY KEY,
      scope_id        TEXT NOT NULL DEFAULT 'default',
      entity_type     TEXT NOT NULL,
      canonical_name  TEXT NOT NULL,
      aliases_json    TEXT NOT NULL DEFAULT '[]',
      attributes_json TEXT NOT NULL DEFAULT '{}',
      confidence      REAL NOT NULL DEFAULT 0.5,
      first_seen_at   INTEGER NOT NULL,
      last_seen_at    INTEGER NOT NULL,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    )
  `);
  raw.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pkb_entities_scope_type_name
      ON pkb_entities(scope_id, entity_type, canonical_name)
  `);
  raw.exec(`
    CREATE INDEX IF NOT EXISTS idx_pkb_entities_scope_updated
      ON pkb_entities(scope_id, updated_at)
  `);

  raw.exec(`
    CREATE TABLE IF NOT EXISTS pkb_episodes (
      id                      TEXT PRIMARY KEY,
      scope_id                TEXT NOT NULL DEFAULT 'default',
      entity_id               TEXT REFERENCES pkb_entities(id) ON DELETE SET NULL,
      summary                 TEXT NOT NULL,
      details_json            TEXT NOT NULL DEFAULT '{}',
      happened_at             INTEGER NOT NULL,
      salience                REAL NOT NULL DEFAULT 0.5,
      source_conversation_id  TEXT,
      created_at              INTEGER NOT NULL
    )
  `);
  raw.exec(`
    CREATE INDEX IF NOT EXISTS idx_pkb_episodes_scope_happened
      ON pkb_episodes(scope_id, happened_at)
  `);
  raw.exec(`
    CREATE INDEX IF NOT EXISTS idx_pkb_episodes_scope_salience
      ON pkb_episodes(scope_id, salience)
  `);
  raw.exec(`
    CREATE INDEX IF NOT EXISTS idx_pkb_episodes_entity
      ON pkb_episodes(entity_id)
  `);

  raw.exec(`
    CREATE TABLE IF NOT EXISTS pkb_preferences (
      id           TEXT PRIMARY KEY,
      scope_id     TEXT NOT NULL DEFAULT 'default',
      key          TEXT NOT NULL,
      value        TEXT NOT NULL,
      confidence   REAL NOT NULL DEFAULT 0.5,
      learned_from TEXT NOT NULL DEFAULT 'inferred',
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    )
  `);
  raw.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pkb_preferences_scope_key
      ON pkb_preferences(scope_id, key)
  `);
  raw.exec(`
    CREATE INDEX IF NOT EXISTS idx_pkb_preferences_scope_updated
      ON pkb_preferences(scope_id, updated_at)
  `);
}
