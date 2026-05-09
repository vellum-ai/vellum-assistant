import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../../memory/db-connection.js";
import * as schema from "../../../memory/schema.js";
import {
  downInferenceRateCards,
  migrateInferenceRateCards,
} from "../003-rate-cards.js";
import { migrateInferenceProviders } from "../001-providers.js";

interface ColumnRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface IndexRow {
  name: string;
}

interface TableRow {
  name: string;
}

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

function bootstrapCheckpointsTable(raw: Database): void {
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_checkpoints (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

const EXPECTED_INDEXES = ["idx_rate_cards_provider_model_effective_from"];

describe("rate_cards migration", () => {
  test("creates table with expected columns and indexes", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapCheckpointsTable(raw);

    migrateInferenceProviders(db);
    migrateInferenceRateCards(db);

    const tableRow = raw
      .query(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='rate_cards'`,
      )
      .get() as TableRow | null;
    expect(tableRow?.name).toBe("rate_cards");

    const columns = raw
      .query(`PRAGMA table_info(rate_cards)`)
      .all() as ColumnRow[];
    const byName = new Map(columns.map((c) => [c.name, c]));

    expect(byName.get("id")?.pk).toBe(1);
    expect(byName.get("id")?.type).toBe("TEXT");
    expect(byName.get("provider_id")?.notnull).toBe(1);
    expect(byName.get("provider_id")?.type).toBe("TEXT");
    expect(byName.get("model")?.notnull).toBe(1);
    expect(byName.get("model")?.type).toBe("TEXT");
    expect(byName.get("input_token_cost_per_1m")?.notnull).toBe(1);
    expect(byName.get("input_token_cost_per_1m")?.type).toBe("REAL");
    expect(byName.get("output_token_cost_per_1m")?.notnull).toBe(1);
    expect(byName.get("output_token_cost_per_1m")?.type).toBe("REAL");
    expect(byName.get("cache_write_cost_per_1m")?.notnull).toBe(0);
    expect(byName.get("cache_write_cost_per_1m")?.type).toBe("REAL");
    expect(byName.get("cache_read_cost_per_1m")?.notnull).toBe(0);
    expect(byName.get("cache_read_cost_per_1m")?.type).toBe("REAL");
    expect(byName.get("currency")?.notnull).toBe(1);
    expect(byName.get("currency")?.type).toBe("TEXT");
    expect(byName.get("currency")?.dflt_value).toBe("'USD'");
    expect(byName.get("effective_from")?.notnull).toBe(1);
    expect(byName.get("effective_from")?.type).toBe("INTEGER");
    expect(byName.get("source")?.notnull).toBe(1);
    expect(byName.get("source")?.type).toBe("TEXT");

    const indexes = raw
      .query(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='rate_cards'`,
      )
      .all() as IndexRow[];
    const indexNames = new Set(indexes.map((r) => r.name));
    for (const expected of EXPECTED_INDEXES) {
      expect(indexNames.has(expected)).toBe(true);
    }
  });

  test("provider_id FK enforces referential integrity", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapCheckpointsTable(raw);
    migrateInferenceProviders(db);
    migrateInferenceRateCards(db);

    const now = Date.now();
    expect(() =>
      raw
        .query(
          `INSERT INTO rate_cards (id, provider_id, model, input_token_cost_per_1m, output_token_cost_per_1m, effective_from, source)
           VALUES ('rc1', 'nonexistent-provider', 'claude-sonnet-4.5', 3.0, 15.0, ?, 'manifest')`,
        )
        .run(now),
    ).toThrow();
  });

  test("re-running the migration is a no-op", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapCheckpointsTable(raw);

    migrateInferenceProviders(db);
    migrateInferenceRateCards(db);

    const now = Date.now();
    raw
      .query(
        `INSERT INTO providers (id, name, contract, base_url, auth, created_at, updated_at)
         VALUES ('prov1', 'anthropic-managed', 'anthropic_messages', 'https://api.anthropic.com', '{"type":"platform"}', ?, ?)`,
      )
      .run(now, now);
    raw
      .query(
        `INSERT INTO rate_cards (id, provider_id, model, input_token_cost_per_1m, output_token_cost_per_1m, effective_from, source)
         VALUES ('rc1', 'prov1', 'claude-sonnet-4.5', 3.0, 15.0, ?, 'manifest')`,
      )
      .run(now);

    expect(() => migrateInferenceRateCards(db)).not.toThrow();

    const row = raw
      .query(`SELECT id FROM rate_cards WHERE id = 'rc1'`)
      .get() as { id: string } | null;
    expect(row?.id).toBe("rc1");
  });

  test("down() drops the table and is idempotent", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapCheckpointsTable(raw);

    migrateInferenceProviders(db);
    migrateInferenceRateCards(db);

    expect(
      raw
        .query(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='rate_cards'`,
        )
        .get(),
    ).toBeTruthy();

    downInferenceRateCards(db);

    expect(
      raw
        .query(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='rate_cards'`,
        )
        .get(),
    ).toBeNull();

    expect(() => downInferenceRateCards(db)).not.toThrow();
  });
});
