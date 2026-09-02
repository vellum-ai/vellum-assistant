import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { addMemoryRetrospectiveConsecutiveFailuresColumn } from "../376-add-memory-retrospective-consecutive-failures.js";

interface ColumnRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

function createLegacyMemoryDb(): Database {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE memory_retrospective_state (
      conversation_id TEXT PRIMARY KEY,
      last_processed_message_id TEXT NOT NULL,
      last_run_at INTEGER NOT NULL,
      remembered_log TEXT
    )
  `);
  return sqlite;
}

describe("migration 376 — memory_retrospective_state.consecutive_failures", () => {
  test("adds a NOT NULL INTEGER column defaulting to 0", () => {
    const raw = createLegacyMemoryDb();

    addMemoryRetrospectiveConsecutiveFailuresColumn(raw);

    const cols = raw
      .query(`PRAGMA table_info(memory_retrospective_state)`)
      .all() as ColumnRow[];
    const col = cols.find((c) => c.name === "consecutive_failures");

    expect(col).toBeDefined();
    expect(col!.type).toBe("INTEGER");
    expect(col!.notnull).toBe(1);
    expect(col!.dflt_value).toBe("0");
  });

  test("is idempotent — running twice does not throw or duplicate the column", () => {
    const raw = createLegacyMemoryDb();

    addMemoryRetrospectiveConsecutiveFailuresColumn(raw);
    expect(() =>
      addMemoryRetrospectiveConsecutiveFailuresColumn(raw),
    ).not.toThrow();

    const cols = raw
      .query(`PRAGMA table_info(memory_retrospective_state)`)
      .all() as ColumnRow[];
    expect(
      cols.filter((c) => c.name === "consecutive_failures"),
    ).toHaveLength(1);
  });

  test("pre-existing rows get 0 for the new column", () => {
    const raw = createLegacyMemoryDb();
    raw.exec(
      `INSERT INTO memory_retrospective_state (conversation_id, last_processed_message_id, last_run_at) VALUES ('c1', 'm1', 1000)`,
    );

    addMemoryRetrospectiveConsecutiveFailuresColumn(raw);

    const row = raw
      .query(
        `SELECT consecutive_failures FROM memory_retrospective_state WHERE conversation_id = 'c1'`,
      )
      .get() as { consecutive_failures: number };
    expect(row.consecutive_failures).toBe(0);
  });

  test("no-ops when the table is missing", () => {
    const raw = new Database(":memory:");
    expect(() =>
      addMemoryRetrospectiveConsecutiveFailuresColumn(raw),
    ).not.toThrow();
  });
});
