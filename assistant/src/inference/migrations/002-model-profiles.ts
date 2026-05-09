import type { DrizzleDb } from "../../memory/db-connection.js";
import { getSqliteFrom } from "../../memory/db-connection.js";
import { withCrashRecovery } from "../../memory/migrations/validate-migration-state.js";

const CHECKPOINT_KEY = "migration_inference_model_profiles_v1";

export function migrateInferenceModelProfiles(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);
    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS model_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
        model TEXT NOT NULL,
        system_prompt TEXT,
        temperature REAL,
        max_tokens INTEGER,
        is_canonical INTEGER NOT NULL DEFAULT 0,
        canonical_revision INTEGER,
        disabled INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_model_profiles_provider_id
        ON model_profiles (provider_id)
    `);
  });
}

export function downInferenceModelProfiles(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  raw.exec(/*sql*/ `DROP TABLE IF EXISTS model_profiles`);
}
