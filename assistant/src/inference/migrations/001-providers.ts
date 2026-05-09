import type { DrizzleDb } from "../../memory/db-connection.js";
import { getSqliteFrom } from "../../memory/db-connection.js";
import { withCrashRecovery } from "../../memory/migrations/validate-migration-state.js";

const CHECKPOINT_KEY = "migration_inference_providers_v1";

export function migrateInferenceProviders(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);
    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        display_name TEXT,
        contract TEXT NOT NULL,
        base_url TEXT NOT NULL,
        auth TEXT NOT NULL,
        is_canonical INTEGER NOT NULL DEFAULT 0,
        canonical_revision INTEGER,
        canonical_equivalent_id TEXT REFERENCES providers(id),
        disabled INTEGER NOT NULL DEFAULT 0,
        modality TEXT NOT NULL DEFAULT 'chat',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_providers_canonical_equivalent_id
        ON providers (canonical_equivalent_id)
    `);
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_providers_is_canonical
        ON providers (is_canonical)
    `);
  });
}

export function downInferenceProviders(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  raw.exec(/*sql*/ `DROP TABLE IF EXISTS providers`);
}
