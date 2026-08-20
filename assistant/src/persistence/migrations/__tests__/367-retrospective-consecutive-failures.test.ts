/**
 * Tests for migration 367: the `consecutive_failures` column on
 * `memory_retrospective_state`.
 *
 * Runs against the real workspace databases (`initializeDb()`) because the
 * column is added on the dedicated memory connection, which the migration
 * resolves itself. `initializeDb()` already applied the step, so the tests seed
 * the table directly and re-run the exported function.
 */
import { beforeEach, describe, expect, test } from "bun:test";

const { getMemorySqlite } = await import("../../db-connection.js");
const { initializeDb } = await import("../../db-init.js");
const { migrateRetrospectiveConsecutiveFailures } =
  await import("../367-retrospective-consecutive-failures.js");

await initializeDb();

interface ColumnRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

function columns(): ColumnRow[] {
  return getMemorySqlite()!
    .query(`PRAGMA table_info(memory_retrospective_state)`)
    .all() as ColumnRow[];
}

describe("migration 367 — memory_retrospective_state.consecutive_failures", () => {
  beforeEach(() => {
    getMemorySqlite()!.exec("DELETE FROM memory_retrospective_state");
  });

  test("the column is NOT NULL and defaults to 0", () => {
    // The job reads the count on every pass and compares it against a
    // threshold, so a NULL would make the comparison meaningless. Zero is the
    // only correct default: a row that has never failed reads as "no failures".
    const column = columns().find((c) => c.name === "consecutive_failures");

    expect(column).toBeDefined();
    expect(column!.type).toBe("INTEGER");
    expect(column!.notnull).toBe(1);
    expect(column!.dflt_value).toBe("0");
  });

  test("rows that predate the column read as zero failures", () => {
    getMemorySqlite()!
      .query(
        `INSERT INTO memory_retrospective_state
           (conversation_id, last_processed_message_id, last_run_at)
         VALUES ('conv-legacy', 'm1', 1000)`,
      )
      .run();

    const row = getMemorySqlite()!
      .query(
        `SELECT consecutive_failures FROM memory_retrospective_state
         WHERE conversation_id = 'conv-legacy'`,
      )
      .get() as { consecutive_failures: number };

    expect(row.consecutive_failures).toBe(0);
  });

  test("re-running is a no-op rather than a duplicate-column error", () => {
    expect(() => migrateRetrospectiveConsecutiveFailures()).not.toThrow();
    expect(
      columns().filter((c) => c.name === "consecutive_failures"),
    ).toHaveLength(1);
  });
});
