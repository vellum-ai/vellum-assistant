import type { DrizzleDb } from "../../memory/db-connection.js";
import { getSqliteFrom } from "../../memory/db-connection.js";
import { withCrashRecovery } from "../../memory/migrations/validate-migration-state.js";

const CHECKPOINT_KEY = "migration_inference_rate_cards_v1";

export function migrateInferenceRateCards(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);
    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS rate_cards (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL REFERENCES providers(id),
        model TEXT NOT NULL,
        input_token_cost_per_1m REAL NOT NULL,
        output_token_cost_per_1m REAL NOT NULL,
        cache_write_cost_per_1m REAL,
        cache_read_cost_per_1m REAL,
        currency TEXT NOT NULL DEFAULT 'USD',
        effective_from INTEGER NOT NULL,
        source TEXT NOT NULL
      )
    `);
    raw.exec(/*sql*/ `
      CREATE INDEX IF NOT EXISTS idx_rate_cards_provider_model_effective_from
        ON rate_cards (provider_id, model, effective_from)
    `);
  });
}

export function downInferenceRateCards(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  raw.exec(/*sql*/ `DROP TABLE IF EXISTS rate_cards`);
}
