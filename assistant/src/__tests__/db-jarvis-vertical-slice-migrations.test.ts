import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../memory/db-connection.js";
import { migratePkbEntityEpisodeTables } from "../memory/migrations/240-pkb-entity-episode-tables.js";
import { migratePlanExecutionTables } from "../memory/migrations/241-plan-execution-tables.js";
import {
  downPkbQualityFields,
  migratePkbQualityFields,
} from "../memory/migrations/242-pkb-quality-fields.js";
import { migratePerceptionConsentGrants } from "../memory/migrations/243-perception-consent-grants.js";
import * as schema from "../memory/schema.js";

interface ColumnRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
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

function getColumns(raw: Database, table: string): Map<string, ColumnRow> {
  const columns = raw.query(`PRAGMA table_info(${table})`).all() as ColumnRow[];
  return new Map(columns.map((c) => [c.name, c]));
}

describe("migratePlanExecutionTables (241)", () => {
  test("creates plans / plan_steps / plan_step_runs with expected columns", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);

    migratePlanExecutionTables(db);

    const planCols = getColumns(raw, "plans");
    expect([...planCols.keys()].sort()).toEqual(
      [
        "cancellation_reason",
        "completed_at",
        "conversation_id",
        "created_at",
        "goal",
        "id",
        "scope_id",
        "status",
        "updated_at",
      ].sort(),
    );

    const stepCols = getColumns(raw, "plan_steps");
    expect(stepCols.has("plan_id")).toBe(true);
    expect(stepCols.has("step_order")).toBe(true);
    expect(stepCols.has("input_json")).toBe(true);

    const runCols = getColumns(raw, "plan_step_runs");
    expect(runCols.has("step_id")).toBe(true);
    expect(runCols.has("attempt")).toBe(true);
    expect(runCols.has("lifecycle_json")).toBe(true);
  });

  test("is idempotent", () => {
    const db = createTestDb();
    migratePlanExecutionTables(db);
    expect(() => migratePlanExecutionTables(db)).not.toThrow();
  });

  test("plan_steps unique index on (plan_id, step_order)", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);

    migratePlanExecutionTables(db);

    const now = Date.now();
    raw
      .query(
        `INSERT INTO plans (id, scope_id, goal, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("plan-1", "default", "test goal", "pending", now, now);
    raw
      .query(
        `INSERT INTO plan_steps (id, plan_id, step_order, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("step-1", "plan-1", 0, "step a", "pending", now, now);

    expect(() =>
      raw
        .query(
          `INSERT INTO plan_steps (id, plan_id, step_order, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("step-1-dup", "plan-1", 0, "duplicate order", "pending", now, now),
    ).toThrow();
  });
});

describe("migratePkbQualityFields (242)", () => {
  test("adds evidence/provenance/decay columns and idempotency key", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapCheckpointsTable(raw);

    migratePkbEntityEpisodeTables(db);
    migratePkbQualityFields(db);

    const entityCols = getColumns(raw, "pkb_entities");
    expect(entityCols.get("evidence_count")).toMatchObject({
      type: "INTEGER",
      notnull: 1,
    });
    expect(entityCols.has("last_reinforced_at")).toBe(true);
    expect(entityCols.get("provenance_json")).toMatchObject({
      type: "TEXT",
      notnull: 1,
    });

    const prefCols = getColumns(raw, "pkb_preferences");
    expect(prefCols.has("evidence_count")).toBe(true);
    expect(prefCols.has("positive_count")).toBe(true);
    expect(prefCols.has("negative_count")).toBe(true);
    expect(prefCols.has("last_reinforced_at")).toBe(true);
    expect(prefCols.has("last_contradicted_at")).toBe(true);

    const episodeCols = getColumns(raw, "pkb_episodes");
    expect(episodeCols.has("idempotency_key")).toBe(true);
  });

  test("idempotency key partial unique index rejects duplicate non-null keys", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapCheckpointsTable(raw);

    migratePkbEntityEpisodeTables(db);
    migratePkbQualityFields(db);

    const now = Date.now();
    raw
      .query(
        `INSERT INTO pkb_episodes (id, scope_id, summary, details_json, happened_at, salience, created_at, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("ep-1", "default", "summary one", "{}", now, 0.5, now, "key-1");

    expect(() =>
      raw
        .query(
          `INSERT INTO pkb_episodes (id, scope_id, summary, details_json, happened_at, salience, created_at, idempotency_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("ep-2", "default", "summary two", "{}", now, 0.5, now, "key-1"),
    ).toThrow();

    // Null idempotency keys can collide freely.
    raw
      .query(
        `INSERT INTO pkb_episodes (id, scope_id, summary, details_json, happened_at, salience, created_at, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run("ep-3", "default", "no key", "{}", now, 0.5, now);
    raw
      .query(
        `INSERT INTO pkb_episodes (id, scope_id, summary, details_json, happened_at, salience, created_at, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run("ep-4", "default", "no key 2", "{}", now, 0.5, now);
  });

  test("is idempotent on re-run", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapCheckpointsTable(raw);

    migratePkbEntityEpisodeTables(db);
    migratePkbQualityFields(db);

    expect(() => migratePkbQualityFields(db)).not.toThrow();
  });

  test("down migration drops the added columns and the index", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapCheckpointsTable(raw);

    migratePkbEntityEpisodeTables(db);
    migratePkbQualityFields(db);

    downPkbQualityFields(db);
    expect(() => downPkbQualityFields(db)).not.toThrow();

    const entityCols = getColumns(raw, "pkb_entities");
    expect(entityCols.has("evidence_count")).toBe(false);
    expect(entityCols.has("provenance_json")).toBe(false);
    expect(entityCols.has("last_reinforced_at")).toBe(false);

    const prefCols = getColumns(raw, "pkb_preferences");
    expect(prefCols.has("evidence_count")).toBe(false);
    expect(prefCols.has("positive_count")).toBe(false);

    const episodeCols = getColumns(raw, "pkb_episodes");
    expect(episodeCols.has("idempotency_key")).toBe(false);
  });
});

describe("migratePerceptionConsentGrants (243)", () => {
  test("creates table with expected columns", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);

    migratePerceptionConsentGrants(db);

    const cols = getColumns(raw, "perception_consent_grants");
    expect(cols.has("scope_id")).toBe(true);
    expect(cols.has("conversation_id")).toBe(true);
    expect(cols.has("event_kind")).toBe(true);
    expect(cols.has("granted_at")).toBe(true);
    expect(cols.has("expires_at")).toBe(true);
    expect(cols.has("revoked_at")).toBe(true);
  });

  test("unique index on (scope_id, conversation_id, event_kind)", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);

    migratePerceptionConsentGrants(db);

    const now = Date.now();
    raw
      .query(
        `INSERT INTO perception_consent_grants (id, scope_id, conversation_id, event_kind, granted_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("g-1", "default", "conv-a", "screen_snapshot", now, now);

    expect(() =>
      raw
        .query(
          `INSERT INTO perception_consent_grants (id, scope_id, conversation_id, event_kind, granted_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("g-2", "default", "conv-a", "screen_snapshot", now, now),
    ).toThrow();
  });

  test("is idempotent", () => {
    const db = createTestDb();
    migratePerceptionConsentGrants(db);
    expect(() => migratePerceptionConsentGrants(db)).not.toThrow();
  });
});
