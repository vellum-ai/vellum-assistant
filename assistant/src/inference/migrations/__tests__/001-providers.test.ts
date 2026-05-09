import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../../memory/db-connection.js";
import * as schema from "../../../memory/schema.js";
import {
  downInferenceProviders,
  migrateInferenceProviders,
} from "../001-providers.js";

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

const EXPECTED_INDEXES = [
  "idx_providers_canonical_equivalent_id",
  "idx_providers_is_canonical",
];

describe("providers migration", () => {
  test("creates table with expected columns and indexes", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapCheckpointsTable(raw);

    migrateInferenceProviders(db);

    const tableRow = raw
      .query(`SELECT name FROM sqlite_master WHERE type='table' AND name='providers'`)
      .get() as TableRow | null;
    expect(tableRow?.name).toBe("providers");

    const columns = raw
      .query(`PRAGMA table_info(providers)`)
      .all() as ColumnRow[];
    const byName = new Map(columns.map((c) => [c.name, c]));

    expect(byName.get("id")?.pk).toBe(1);
    expect(byName.get("id")?.type).toBe("TEXT");
    expect(byName.get("name")?.notnull).toBe(1);
    expect(byName.get("name")?.type).toBe("TEXT");
    expect(byName.get("display_name")?.notnull).toBe(0);
    expect(byName.get("display_name")?.type).toBe("TEXT");
    expect(byName.get("contract")?.notnull).toBe(1);
    expect(byName.get("contract")?.type).toBe("TEXT");
    expect(byName.get("base_url")?.notnull).toBe(1);
    expect(byName.get("base_url")?.type).toBe("TEXT");
    expect(byName.get("auth")?.notnull).toBe(1);
    expect(byName.get("auth")?.type).toBe("TEXT");
    expect(byName.get("is_canonical")?.notnull).toBe(1);
    expect(byName.get("is_canonical")?.type).toBe("INTEGER");
    expect(byName.get("is_canonical")?.dflt_value).toBe("0");
    expect(byName.get("canonical_revision")?.notnull).toBe(0);
    expect(byName.get("canonical_revision")?.type).toBe("INTEGER");
    expect(byName.get("canonical_equivalent_id")?.notnull).toBe(0);
    expect(byName.get("canonical_equivalent_id")?.type).toBe("TEXT");
    expect(byName.get("disabled")?.notnull).toBe(1);
    expect(byName.get("disabled")?.type).toBe("INTEGER");
    expect(byName.get("disabled")?.dflt_value).toBe("0");
    expect(byName.get("modality")?.notnull).toBe(1);
    expect(byName.get("modality")?.type).toBe("TEXT");
    expect(byName.get("modality")?.dflt_value).toBe("'chat'");
    expect(byName.get("created_at")?.notnull).toBe(1);
    expect(byName.get("created_at")?.type).toBe("INTEGER");
    expect(byName.get("updated_at")?.notnull).toBe(1);
    expect(byName.get("updated_at")?.type).toBe("INTEGER");

    const indexes = raw
      .query(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='providers'`,
      )
      .all() as IndexRow[];
    const indexNames = new Set(indexes.map((r) => r.name));
    for (const expected of EXPECTED_INDEXES) {
      expect(indexNames.has(expected)).toBe(true);
    }
  });

  test("name column has UNIQUE constraint", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapCheckpointsTable(raw);
    migrateInferenceProviders(db);

    const now = Date.now();
    raw
      .query(
        `INSERT INTO providers (id, name, contract, base_url, auth, created_at, updated_at)
         VALUES ('p1', 'anthropic-managed', 'anthropic_messages', 'https://api.anthropic.com', '{"type":"platform"}', ?, ?)`,
      )
      .run(now, now);

    expect(() =>
      raw
        .query(
          `INSERT INTO providers (id, name, contract, base_url, auth, created_at, updated_at)
           VALUES ('p2', 'anthropic-managed', 'anthropic_messages', 'https://api.anthropic.com', '{"type":"platform"}', ?, ?)`,
        )
        .run(now, now),
    ).toThrow();
  });

  test("re-running the migration is a no-op", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapCheckpointsTable(raw);

    migrateInferenceProviders(db);

    const now = Date.now();
    raw
      .query(
        `INSERT INTO providers (id, name, contract, base_url, auth, created_at, updated_at)
         VALUES ('p1', 'test-provider', 'anthropic_messages', 'https://example.com', '{"type":"none"}', ?, ?)`,
      )
      .run(now, now);

    expect(() => migrateInferenceProviders(db)).not.toThrow();

    const row = raw
      .query(`SELECT id FROM providers WHERE id = 'p1'`)
      .get() as { id: string } | null;
    expect(row?.id).toBe("p1");
  });

  test("down() drops the table and is idempotent", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapCheckpointsTable(raw);

    migrateInferenceProviders(db);

    expect(
      raw
        .query(`SELECT name FROM sqlite_master WHERE type='table' AND name='providers'`)
        .get(),
    ).toBeTruthy();

    downInferenceProviders(db);

    expect(
      raw
        .query(`SELECT name FROM sqlite_master WHERE type='table' AND name='providers'`)
        .get(),
    ).toBeNull();

    expect(() => downInferenceProviders(db)).not.toThrow();
  });
});
