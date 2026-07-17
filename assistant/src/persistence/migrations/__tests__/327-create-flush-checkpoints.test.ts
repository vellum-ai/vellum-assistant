/**
 * Tests for migration 327 — the `flush_checkpoints` table on the dedicated
 * telemetry database, and the one-time move of the telemetry reporter's
 * watermark cursors out of the main DB's `memory_checkpoints` ledger.
 *
 * The step is idempotent, so each test can drive it directly.
 */
import { beforeEach, describe, expect, test } from "bun:test";

const { getDb, getSqlite, getTelemetrySqlite } =
  await import("../../db-connection.js");
const { initializeDb } = await import("../../db-init.js");
const { createFlushCheckpointsTable } =
  await import("../327-create-flush-checkpoints.js");

await initializeDb();

function telemetrySqlite() {
  const db = getTelemetrySqlite();
  if (!db) {
    throw new Error("telemetry DB unavailable in test");
  }
  return db;
}

function readTelemetryValue(key: string): string | null {
  const row = telemetrySqlite()
    .query(`SELECT value FROM flush_checkpoints WHERE key = ?`)
    .get(key) as { value: string } | null;
  return row?.value ?? null;
}

function readMainValue(key: string): string | null {
  const row = getSqlite()
    .query(`SELECT value FROM memory_checkpoints WHERE key = ?`)
    .get(key) as { value: string } | null;
  return row?.value ?? null;
}

function seedMainCheckpoint(key: string, value: string): void {
  getSqlite()
    .query(
      `INSERT OR REPLACE INTO memory_checkpoints (key, value, updated_at) VALUES (?, ?, ?)`,
    )
    .run(key, value, Date.now());
}

describe("migration 327 — flush_checkpoints on the telemetry database", () => {
  beforeEach(() => {
    telemetrySqlite().query(`DELETE FROM flush_checkpoints`).run();
    getSqlite()
      .query(`DELETE FROM memory_checkpoints WHERE key LIKE 'telemetry:%'`)
      .run();
  });

  test("after init, the table exists on the telemetry DB", () => {
    const row = telemetrySqlite()
      .query(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='flush_checkpoints'`,
      )
      .get();
    expect(row).not.toBeNull();
  });

  test("moves legacy watermark keys from memory_checkpoints", () => {
    seedMainCheckpoint("telemetry:usage:last_reported_at", "1700000000000");
    seedMainCheckpoint("telemetry:usage:last_reported_id", "row-abc");

    createFlushCheckpointsTable(getDb());

    expect(readTelemetryValue("telemetry:usage:last_reported_at")).toBe(
      "1700000000000",
    );
    expect(readTelemetryValue("telemetry:usage:last_reported_id")).toBe(
      "row-abc",
    );
    expect(readMainValue("telemetry:usage:last_reported_at")).toBeNull();
    expect(readMainValue("telemetry:usage:last_reported_id")).toBeNull();
  });

  test("leaves non-watermark telemetry-prefixed checkpoints in place", () => {
    seedMainCheckpoint("telemetry:installation_id", "inst-123");
    seedMainCheckpoint(
      "telemetry:watchers:inventory_last_recorded",
      "1700000000000",
    );

    createFlushCheckpointsTable(getDb());

    expect(readMainValue("telemetry:installation_id")).toBe("inst-123");
    expect(readMainValue("telemetry:watchers:inventory_last_recorded")).toBe(
      "1700000000000",
    );
    expect(readTelemetryValue("telemetry:installation_id")).toBeNull();
  });

  test("re-run never overwrites a value the reporter has since advanced", () => {
    seedMainCheckpoint("telemetry:turns:last_reported_at", "1000");
    createFlushCheckpointsTable(getDb());
    expect(readTelemetryValue("telemetry:turns:last_reported_at")).toBe("1000");

    // The reporter advances the moved cursor, then a crash re-runs the
    // migration with a stale main-DB copy still present (crash between copy
    // and delete on the first run). INSERT OR IGNORE must keep the advanced
    // value.
    telemetrySqlite()
      .query(`UPDATE flush_checkpoints SET value = '2000' WHERE key = ?`)
      .run("telemetry:turns:last_reported_at");
    seedMainCheckpoint("telemetry:turns:last_reported_at", "1000");

    createFlushCheckpointsTable(getDb());

    expect(readTelemetryValue("telemetry:turns:last_reported_at")).toBe("2000");
    expect(readMainValue("telemetry:turns:last_reported_at")).toBeNull();
  });

  test("no-op when there are no legacy keys", () => {
    createFlushCheckpointsTable(getDb());
    const count = telemetrySqlite()
      .query(`SELECT COUNT(*) as c FROM flush_checkpoints`)
      .get() as { c: number };
    expect(count.c).toBe(0);
  });
});
