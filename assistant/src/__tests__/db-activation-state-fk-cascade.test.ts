import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../memory/db-connection.js";
import { migrateActivationState } from "../memory/migrations/232-activation-state.js";
import { migrateActivationStateFkCascade } from "../memory/migrations/241-activation-state-fk-cascade.js";
import * as schema from "../memory/schema.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

function bootstrap(raw: Database): void {
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_checkpoints (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY)
  `);
}

function insertActivation(
  raw: Database,
  conversationId: string,
  messageId = "msg-1",
): void {
  raw
    .query(
      /*sql*/ `INSERT INTO activation_state (conversation_id, message_id, state_json, updated_at) VALUES (?, ?, ?, ?)`,
    )
    .run(conversationId, messageId, "{}", 1);
}

describe("activation_state FK cascade migration", () => {
  test("rebuilds the table with ON DELETE CASCADE", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrap(raw);

    migrateActivationState(db);
    migrateActivationStateFkCascade(db);

    const ddl = raw
      .query(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='activation_state'`,
      )
      .get() as { sql: string } | null;
    expect(ddl?.sql).toContain("REFERENCES conversations(id)");
    expect(ddl?.sql).toContain("ON DELETE CASCADE");
  });

  test("deleting a conversation cascades to activation_state", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrap(raw);

    migrateActivationState(db);
    migrateActivationStateFkCascade(db);

    raw.query(`INSERT INTO conversations (id) VALUES (?)`).run("conv-1");
    insertActivation(raw, "conv-1");

    raw.query(`DELETE FROM conversations WHERE id = ?`).run("conv-1");

    const remaining = raw
      .query(`SELECT COUNT(*) AS n FROM activation_state`)
      .get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  test("rebuild purges existing orphan rows", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrap(raw);

    migrateActivationState(db);

    raw.query(`INSERT INTO conversations (id) VALUES (?)`).run("conv-live");
    insertActivation(raw, "conv-live");
    insertActivation(raw, "conv-orphan");

    migrateActivationStateFkCascade(db);

    const rows = raw
      .query(
        `SELECT conversation_id FROM activation_state ORDER BY conversation_id`,
      )
      .all() as Array<{ conversation_id: string }>;
    expect(rows.map((r) => r.conversation_id)).toEqual(["conv-live"]);
  });

  test("is idempotent — second run is a no-op", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrap(raw);

    migrateActivationState(db);
    migrateActivationStateFkCascade(db);
    expect(() => migrateActivationStateFkCascade(db)).not.toThrow();

    const ddl = raw
      .query(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='activation_state'`,
      )
      .get() as { sql: string } | null;
    expect(ddl?.sql).toContain("ON DELETE CASCADE");
  });

  test("no-ops when activation_state table is absent", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrap(raw);

    expect(() => migrateActivationStateFkCascade(db)).not.toThrow();

    const tableRow = raw
      .query(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='activation_state'`,
      )
      .get();
    expect(tableRow).toBeNull();
  });
});
