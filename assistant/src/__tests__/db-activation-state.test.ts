import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../memory/db-connection.js";
import {
  downActivationState,
  migrateActivationState,
} from "../memory/migrations/232-activation-state.js";
import * as schema from "../memory/schema.js";

interface TableRow {
  name: string;
}

interface ColumnRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
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

describe("activation_state migration", () => {
  test("creates table with expected columns", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapCheckpointsTable(raw);

    migrateActivationState(db);

    const tableRow = raw
      .query(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='activation_state'`,
      )
      .get() as TableRow | null;
    expect(tableRow?.name).toBe("activation_state");

    const columns = raw
      .query(`PRAGMA table_info(activation_state)`)
      .all() as ColumnRow[];

    const byName = new Map(columns.map((c) => [c.name, c]));
    expect(byName.get("conversation_id")?.pk).toBe(1);
    expect(byName.get("conversation_id")?.type).toBe("TEXT");
    expect(byName.get("message_id")?.notnull).toBe(1);
    expect(byName.get("message_id")?.type).toBe("TEXT");
    expect(byName.get("state_json")?.notnull).toBe(1);
    expect(byName.get("state_json")?.type).toBe("TEXT");
    expect(byName.get("ever_injected_json")?.notnull).toBe(1);
    expect(byName.get("ever_injected_json")?.dflt_value).toBe("'[]'");
    expect(byName.get("current_turn")?.notnull).toBe(1);
    expect(byName.get("current_turn")?.type).toBe("INTEGER");
    expect(byName.get("current_turn")?.dflt_value).toBe("0");
    expect(byName.get("updated_at")?.notnull).toBe(1);
    expect(byName.get("updated_at")?.type).toBe("INTEGER");
  });

  test("supports insert and select round-trip", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapCheckpointsTable(raw);

    migrateActivationState(db);

    const stateJson = JSON.stringify({ "alice-prefers-vscode": 0.42 });
    const everInjectedJson = JSON.stringify([
      { slug: "alice-prefers-vscode", turn: 3 },
    ]);

    raw
      .query(
        /*sql*/ `
        INSERT INTO activation_state (
          conversation_id,
          message_id,
          state_json,
          ever_injected_json,
          current_turn,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
      )
      .run("conv-abc", "msg-xyz", stateJson, everInjectedJson, 5, 1000);

    const row = raw
      .query(
        /*sql*/ `
        SELECT
          conversation_id,
          message_id,
          state_json,
          ever_injected_json,
          current_turn,
          updated_at
        FROM activation_state
        WHERE conversation_id = ?
      `,
      )
      .get("conv-abc") as {
      conversation_id: string;
      message_id: string;
      state_json: string;
      ever_injected_json: string;
      current_turn: number;
      updated_at: number;
    } | null;

    expect(row).toEqual({
      conversation_id: "conv-abc",
      message_id: "msg-xyz",
      state_json: stateJson,
      ever_injected_json: everInjectedJson,
      current_turn: 5,
      updated_at: 1000,
    });
  });

  test("ever_injected_json defaults to '[]' and current_turn to 0 when omitted", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapCheckpointsTable(raw);

    migrateActivationState(db);

    raw
      .query(
        /*sql*/ `
        INSERT INTO activation_state (
          conversation_id,
          message_id,
          state_json,
          updated_at
        ) VALUES (?, ?, ?, ?)
      `,
      )
      .run("conv-defaults", "msg-1", "{}", 2000);

    const row = raw
      .query(
        /*sql*/ `
        SELECT ever_injected_json, current_turn
        FROM activation_state
        WHERE conversation_id = ?
      `,
      )
      .get("conv-defaults") as {
      ever_injected_json: string;
      current_turn: number;
    } | null;

    expect(row).toEqual({
      ever_injected_json: "[]",
      current_turn: 0,
    });
  });

  test("re-running the migration is idempotent", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapCheckpointsTable(raw);

    migrateActivationState(db);

    raw
      .query(
        /*sql*/ `
        INSERT INTO activation_state (
          conversation_id,
          message_id,
          state_json,
          updated_at
        ) VALUES (?, ?, ?, ?)
      `,
      )
      .run("conv-rerun", "msg-1", "{}", 1234);

    expect(() => migrateActivationState(db)).not.toThrow();

    const row = raw
      .query(
        `SELECT conversation_id FROM activation_state WHERE conversation_id = 'conv-rerun'`,
      )
      .get() as { conversation_id: string } | null;
    expect(row?.conversation_id).toBe("conv-rerun");
  });

  test("down() drops the table", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapCheckpointsTable(raw);

    migrateActivationState(db);

    expect(
      raw
        .query(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='activation_state'`,
        )
        .get(),
    ).toBeTruthy();

    downActivationState(db);

    expect(
      raw
        .query(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='activation_state'`,
        )
        .get(),
    ).toBeNull();
  });

  test("down() is idempotent when run on an empty schema", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapCheckpointsTable(raw);

    expect(() => downActivationState(db)).not.toThrow();
    expect(() => downActivationState(db)).not.toThrow();
  });
});
