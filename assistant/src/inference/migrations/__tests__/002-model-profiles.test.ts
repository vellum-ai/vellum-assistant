import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../../memory/db-connection.js";
import * as schema from "../../../memory/schema.js";
import {
  downInferenceModelProfiles,
  migrateInferenceModelProfiles,
} from "../002-model-profiles.js";
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

const EXPECTED_INDEXES = ["idx_model_profiles_provider_id"];

describe("model_profiles migration", () => {
  test("creates table with expected columns and indexes", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapCheckpointsTable(raw);

    migrateInferenceProviders(db);
    migrateInferenceModelProfiles(db);

    const tableRow = raw
      .query(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='model_profiles'`,
      )
      .get() as TableRow | null;
    expect(tableRow?.name).toBe("model_profiles");

    const columns = raw
      .query(`PRAGMA table_info(model_profiles)`)
      .all() as ColumnRow[];
    const byName = new Map(columns.map((c) => [c.name, c]));

    expect(byName.get("id")?.pk).toBe(1);
    expect(byName.get("id")?.type).toBe("TEXT");
    expect(byName.get("name")?.notnull).toBe(1);
    expect(byName.get("name")?.type).toBe("TEXT");
    expect(byName.get("provider_id")?.notnull).toBe(1);
    expect(byName.get("provider_id")?.type).toBe("TEXT");
    expect(byName.get("model")?.notnull).toBe(1);
    expect(byName.get("model")?.type).toBe("TEXT");
    expect(byName.get("system_prompt")?.notnull).toBe(0);
    expect(byName.get("system_prompt")?.type).toBe("TEXT");
    expect(byName.get("temperature")?.notnull).toBe(0);
    expect(byName.get("temperature")?.type).toBe("REAL");
    expect(byName.get("max_tokens")?.notnull).toBe(0);
    expect(byName.get("max_tokens")?.type).toBe("INTEGER");
    expect(byName.get("is_canonical")?.notnull).toBe(1);
    expect(byName.get("is_canonical")?.type).toBe("INTEGER");
    expect(byName.get("is_canonical")?.dflt_value).toBe("0");
    expect(byName.get("canonical_revision")?.notnull).toBe(0);
    expect(byName.get("canonical_revision")?.type).toBe("INTEGER");
    expect(byName.get("disabled")?.notnull).toBe(1);
    expect(byName.get("disabled")?.type).toBe("INTEGER");
    expect(byName.get("disabled")?.dflt_value).toBe("0");
    expect(byName.get("created_at")?.notnull).toBe(1);
    expect(byName.get("created_at")?.type).toBe("INTEGER");
    expect(byName.get("updated_at")?.notnull).toBe(1);
    expect(byName.get("updated_at")?.type).toBe("INTEGER");

    const indexes = raw
      .query(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='model_profiles'`,
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
    migrateInferenceModelProfiles(db);

    const now = Date.now();
    raw
      .query(
        `INSERT INTO providers (id, name, contract, base_url, auth, created_at, updated_at)
         VALUES ('prov1', 'anthropic-managed', 'anthropic_messages', 'https://api.anthropic.com', '{"type":"platform"}', ?, ?)`,
      )
      .run(now, now);
    raw
      .query(
        `INSERT INTO model_profiles (id, name, provider_id, model, created_at, updated_at)
         VALUES ('mp1', 'claude-sonnet', 'prov1', 'claude-sonnet-4.5', ?, ?)`,
      )
      .run(now, now);

    expect(() =>
      raw
        .query(
          `INSERT INTO model_profiles (id, name, provider_id, model, created_at, updated_at)
           VALUES ('mp2', 'claude-sonnet', 'prov1', 'claude-sonnet-4.5', ?, ?)`,
        )
        .run(now, now),
    ).toThrow();
  });

  test("provider_id FK enforces referential integrity", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapCheckpointsTable(raw);
    migrateInferenceProviders(db);
    migrateInferenceModelProfiles(db);

    const now = Date.now();
    expect(() =>
      raw
        .query(
          `INSERT INTO model_profiles (id, name, provider_id, model, created_at, updated_at)
           VALUES ('mp1', 'claude-sonnet', 'nonexistent-provider', 'claude-sonnet-4.5', ?, ?)`,
        )
        .run(now, now),
    ).toThrow();
  });

  test("re-running the migration is a no-op", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapCheckpointsTable(raw);

    migrateInferenceProviders(db);
    migrateInferenceModelProfiles(db);

    const now = Date.now();
    raw
      .query(
        `INSERT INTO providers (id, name, contract, base_url, auth, created_at, updated_at)
         VALUES ('prov1', 'test-provider', 'anthropic_messages', 'https://example.com', '{"type":"none"}', ?, ?)`,
      )
      .run(now, now);
    raw
      .query(
        `INSERT INTO model_profiles (id, name, provider_id, model, created_at, updated_at)
         VALUES ('mp1', 'test-profile', 'prov1', 'test-model', ?, ?)`,
      )
      .run(now, now);

    expect(() => migrateInferenceModelProfiles(db)).not.toThrow();

    const row = raw
      .query(`SELECT id FROM model_profiles WHERE id = 'mp1'`)
      .get() as { id: string } | null;
    expect(row?.id).toBe("mp1");
  });

  test("down() drops the table and is idempotent", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapCheckpointsTable(raw);

    migrateInferenceProviders(db);
    migrateInferenceModelProfiles(db);

    expect(
      raw
        .query(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='model_profiles'`,
        )
        .get(),
    ).toBeTruthy();

    downInferenceModelProfiles(db);

    expect(
      raw
        .query(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='model_profiles'`,
        )
        .get(),
    ).toBeNull();

    expect(() => downInferenceModelProfiles(db)).not.toThrow();
  });
});
