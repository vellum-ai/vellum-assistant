/**
 * Tests for migration 342 — the imported-bookkeeping backstop for missing
 * side-DB schemas.
 *
 * A vbundle import carries the main `assistant.db` — including its migration
 * bookkeeping — but not the side databases. When the imported bookkeeping
 * already contains the relocation steps AND the later self-healing steps
 * (310/334/335/340/341), none of them re-run, so the fresh side DBs stay
 * empty and the runtime stores fail with `no such table`. Migration 342 is a
 * new step (absent from any imported bookkeeping at introduction time) that
 * idempotently recreates every migration-owned side-DB schema.
 *
 * The step is idempotent and not checkpoint-gated, so each test can drive it
 * directly without clearing any checkpoint.
 */
import { describe, expect, test } from "bun:test";

const { getDb, getLogsSqlite, getMemorySqlite, getTelemetrySqlite } =
  await import("../../db-connection.js");
const { initializeDb } = await import("../../db-init.js");
const { migrateEnsureRelocatedSideDbSchemas } =
  await import("../342-ensure-relocated-side-db-schemas.js");
const { recordRequestLog, getRequestLogById } =
  await import("../../llm-request-log-store.js");

await initializeDb();

const MEMORY_TABLES = [
  "memory_jobs",
  "memory_v2_injection_events",
  "memory_v2_activation_logs",
  "memory_recall_logs",
  "memory_v3_selections",
  "activation_sessions",
] as const;

const TELEMETRY_TABLES = ["flush_checkpoints", "telemetry_events"] as const;

function required<T>(db: T | null, name: string): T {
  if (!db) {
    throw new Error(`${name} DB unavailable in test`);
  }
  return db;
}

function tableExists(
  db: NonNullable<ReturnType<typeof getLogsSqlite>>,
  table: string,
): boolean {
  return (
    db
      .query(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
      .get(table) != null
  );
}

function columnNames(
  db: NonNullable<ReturnType<typeof getLogsSqlite>>,
  table: string,
): string[] {
  return (
    db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map((c) => c.name);
}

/** Simulate fresh side DBs on a machine whose bookkeeping is fully applied. */
function dropAllSideDbTables(): void {
  const logs = required(getLogsSqlite(), "logs");
  const memory = required(getMemorySqlite(), "memory");
  const telemetry = required(getTelemetrySqlite(), "telemetry");
  logs.exec(`DROP TABLE IF EXISTS llm_request_logs`);
  for (const table of MEMORY_TABLES) {
    memory.exec(`DROP TABLE IF EXISTS "${table}"`);
  }
  for (const table of TELEMETRY_TABLES) {
    telemetry.exec(`DROP TABLE IF EXISTS "${table}"`);
  }
}

describe("migration 342 — ensure relocated side-DB schemas", () => {
  test("recreates every side-DB table when all are missing (imported bookkeeping)", () => {
    dropAllSideDbTables();

    migrateEnsureRelocatedSideDbSchemas(getDb());

    const logs = required(getLogsSqlite(), "logs");
    const memory = required(getMemorySqlite(), "memory");
    const telemetry = required(getTelemetrySqlite(), "telemetry");

    // Logs DB: the 297 shape plus 310's latency_breakdown column.
    const logColumns = columnNames(logs, "llm_request_logs");
    expect(logColumns).toContain("call_site");
    expect(logColumns).toContain("latency_breakdown");

    for (const table of MEMORY_TABLES) {
      expect(tableExists(memory, table)).toBe(true);
    }
    expect(columnNames(memory, "memory_jobs")).toContain("deferrals");
    expect(columnNames(memory, "memory_v3_selections")).toContain(
      "section_ordinal",
    );

    for (const table of TELEMETRY_TABLES) {
      expect(tableExists(telemetry, table)).toBe(true);
    }
    expect(columnNames(telemetry, "telemetry_events")).toContain("payload");
  });

  test("the daemon-visible store round-trips against the recreated table", () => {
    dropAllSideDbTables();
    migrateEnsureRelocatedSideDbSchemas(getDb());

    const id = recordRequestLog(
      "conv-342",
      JSON.stringify({ req: 1 }),
      JSON.stringify({ res: 1 }),
      "msg-342",
      "anthropic",
      "mainAgent",
    );
    expect(id).toBeTruthy();
    const row = getRequestLogById(id!);
    expect(row?.conversationId).toBe("conv-342");
    expect(row?.callSite).toBe("mainAgent");
  });

  test("is a no-op on healthy databases (idempotent, rows undisturbed)", () => {
    dropAllSideDbTables();
    migrateEnsureRelocatedSideDbSchemas(getDb());

    const memory = required(getMemorySqlite(), "memory");
    const now = Date.now();
    memory
      .query(
        `INSERT INTO memory_jobs
           (id, type, payload, status, attempts, deferrals, run_after, created_at, updated_at)
         VALUES ('job-342', 'memory_v2_reembed', '{}', 'pending', 0, 0, ?, ?, ?)`,
      )
      .run(now, now, now);

    migrateEnsureRelocatedSideDbSchemas(getDb());

    expect(
      memory.query(`SELECT 1 FROM memory_jobs WHERE id = 'job-342'`).get(),
    ).not.toBeNull();
    memory.query(`DELETE FROM memory_jobs WHERE id = 'job-342'`).run();
  });
});
