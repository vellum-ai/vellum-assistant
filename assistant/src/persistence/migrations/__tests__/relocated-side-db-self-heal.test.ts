/**
 * Regression tests for the "relocated side-DB table missing" trap.
 *
 * A vbundle import (or warm-pool claim) carries the main `assistant.db` —
 * including its migration bookkeeping — but not the side databases
 * (`assistant-logs.db`, `assistant-memory.db`, `assistant-telemetry.db`).
 * Relocation migrations (297, 298, 327, …) are marked applied in the imported
 * bookkeeping, so they never re-run on the new machine, and the side DB lacks
 * the relocated tables. `PRAGMA table_info(<missing table>)` returns an EMPTY
 * list — not an error — so a naive column guard passes and the following
 * `ALTER TABLE` / `INSERT` / `DELETE` throws `no such table`, failing the
 * step on every boot and pinning daemon readiness at 503.
 *
 * Each later side-DB migration therefore self-heals: it re-runs the owning
 * relocation's exported ensure-schema function before touching the table.
 * These tests simulate the fresh-side-DB state by dropping the relocated
 * table from the dedicated connection, then drive the later migration
 * directly — it must succeed and leave the table with the expected shape.
 *
 * The steps are idempotent and not checkpoint-gated, so each test can drive
 * them directly without clearing any checkpoint.
 */
import { describe, expect, test } from "bun:test";

const { getDb, getSqlite, getLogsSqlite, getMemorySqlite, getTelemetrySqlite } =
  await import("../../db-connection.js");
const { initializeDb } = await import("../../db-init.js");
const { ensureLlmRequestLogsSchema } =
  await import("../297-move-llm-request-logs-to-logs-db.js");
const { migrateLlmRequestLogCallSite } =
  await import("../264-llm-request-log-call-site.js");
const { migrateLlmRequestLogLatencyBreakdown } =
  await import("../310-llm-request-log-latency-breakdown.js");
const { migrateBackfillTelemetryEventsOutbox } =
  await import("../334-backfill-telemetry-events-outbox.js");
const { migrateCollapseMemoryEmbedBacklog } =
  await import("../335-collapse-memory-embed-backlog.js");
const { migrateSweepOrphanedGraphNodeVectors } =
  await import("../340-sweep-orphaned-graph-node-vectors.js");
const { migrateSweepCachelessGraphNodeVectors } =
  await import("../341-sweep-cacheless-graph-node-vectors.js");

await initializeDb();

function logsSqlite() {
  const db = getLogsSqlite();
  if (!db) {
    throw new Error("logs DB unavailable in test");
  }
  return db;
}

function memorySqlite() {
  const db = getMemorySqlite();
  if (!db) {
    throw new Error("memory DB unavailable in test");
  }
  return db;
}

function telemetrySqlite() {
  const db = getTelemetrySqlite();
  if (!db) {
    throw new Error("telemetry DB unavailable in test");
  }
  return db;
}

function columnNames(
  db: ReturnType<typeof logsSqlite>,
  table: string,
): string[] {
  return (
    db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map((c) => c.name);
}

function tableExists(
  db: ReturnType<typeof logsSqlite>,
  table: string,
): boolean {
  return (
    db
      .query(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
      .get(table) != null
  );
}

describe("migration 310 — llm_request_logs self-heal on the logs DB", () => {
  test("recreates a missing table (fresh logs DB, 297 marked applied) and adds the column", () => {
    const logs = logsSqlite();
    logs.exec(`DROP TABLE IF EXISTS llm_request_logs`);

    // The empty-PRAGMA trap: table_info on the missing table is [], so a
    // bare column guard would pass and ALTER TABLE would throw.
    expect(columnNames(logs, "llm_request_logs")).toEqual([]);

    migrateLlmRequestLogLatencyBreakdown();

    const columns = columnNames(logs, "llm_request_logs");
    expect(columns).toContain("id");
    expect(columns).toContain("conversation_id");
    expect(columns).toContain("request_payload");
    expect(columns).toContain("call_site");
    expect(columns).toContain("latency_breakdown");

    const indexes = (
      logs
        .query(
          `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='llm_request_logs'`,
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(indexes).toContain("idx_llm_request_logs_message_id");
    expect(indexes).toContain("idx_llm_request_logs_created_at");
    expect(indexes).toContain("idx_llm_request_logs_conv_created");

    // Idempotent — a second run is a no-op.
    migrateLlmRequestLogLatencyBreakdown();
    expect(
      columnNames(logs, "llm_request_logs").filter(
        (c) => c === "latency_breakdown",
      ),
    ).toHaveLength(1);
  });

  test("adds the column to an existing 297-shaped table without disturbing rows", () => {
    const logs = logsSqlite();
    logs.exec(`DROP TABLE IF EXISTS llm_request_logs`);
    ensureLlmRequestLogsSchema(logs);
    logs.exec(
      `INSERT INTO llm_request_logs (id, conversation_id, request_payload, response_payload, created_at) VALUES ('row-310', 'conv-310', '{}', '{}', 42)`,
    );

    migrateLlmRequestLogLatencyBreakdown();

    const row = logs
      .query(
        `SELECT conversation_id, latency_breakdown FROM llm_request_logs WHERE id = 'row-310'`,
      )
      .get() as { conversation_id: string; latency_breakdown: null };
    expect(row.conversation_id).toBe("conv-310");
    expect(row.latency_breakdown).toBeNull();
  });
});

describe("migration 264 — llm_request_logs absent from main (relocated by 297)", () => {
  test("skips instead of ALTERing a missing table, and does not resurrect it in main", () => {
    const main = getSqlite();
    // Post-297 state: the table lives on the logs connection, not in main.
    expect(tableExists(main, "llm_request_logs")).toBe(false);

    expect(() => migrateLlmRequestLogCallSite(getDb())).not.toThrow();
    expect(tableExists(main, "llm_request_logs")).toBe(false);
  });

  test("still adds call_site when the table is present in main (pre-297 database)", () => {
    const main = getSqlite();
    main.exec(`
      CREATE TABLE main.llm_request_logs (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        request_payload TEXT NOT NULL,
        response_payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    try {
      migrateLlmRequestLogCallSite(getDb());
      expect(columnNames(main, "llm_request_logs")).toContain("call_site");
    } finally {
      main.exec(`DROP TABLE main.llm_request_logs`);
    }
  });
});

describe("memory-DB migrations — memory_jobs self-heal (fresh memory DB, 298 marked applied)", () => {
  test("335 collapse-embed-backlog recreates a missing memory_jobs and succeeds", async () => {
    const memory = memorySqlite();
    memory.exec(`DROP TABLE IF EXISTS memory_jobs`);

    await migrateCollapseMemoryEmbedBacklog(getDb());

    expect(tableExists(memory, "memory_jobs")).toBe(true);
    const columns = columnNames(memory, "memory_jobs");
    expect(columns).toContain("type");
    expect(columns).toContain("payload");
    expect(columns).toContain("status");
    expect(columns).toContain("run_after");
  });

  test("340 orphaned-vector sweep recreates a missing memory_jobs and enqueues the deletion", () => {
    const main = getSqlite();
    const memory = memorySqlite();
    memory.exec(`DROP TABLE IF EXISTS memory_jobs`);

    const now = Date.now();
    main
      .query(
        `INSERT OR REPLACE INTO memory_embeddings
           (id, target_type, target_id, provider, model, dimensions, vector_json, created_at, updated_at)
         VALUES ('emb-340', 'graph_node', 'node-orphan-340', 'test', 'test-model', 2, '[0,1]', ?, ?)`,
      )
      .run(now, now);

    try {
      migrateSweepOrphanedGraphNodeVectors(getDb());

      expect(tableExists(memory, "memory_jobs")).toBe(true);
      const job = memory
        .query(`SELECT type, payload FROM memory_jobs WHERE id = ?`)
        .get(
          "migration-340-sweep-orphan-graph-node-vector:node-orphan-340",
        ) as {
        type: string;
        payload: string;
      } | null;
      expect(job?.type).toBe("delete_qdrant_vectors");
      expect(JSON.parse(job!.payload)).toEqual({
        targetType: "graph_node",
        targetId: "node-orphan-340",
      });
      expect(
        main.query(`SELECT 1 FROM memory_embeddings WHERE id='emb-340'`).get(),
      ).toBeNull();
    } finally {
      main.query(`DELETE FROM memory_embeddings WHERE id='emb-340'`).run();
    }
  });

  test("341 cacheless-vector sweep recreates a missing memory_jobs and enqueues the sweep job", () => {
    const memory = memorySqlite();
    memory.exec(`DROP TABLE IF EXISTS memory_jobs`);

    migrateSweepCachelessGraphNodeVectors(getDb());

    expect(tableExists(memory, "memory_jobs")).toBe(true);
    const job = memory
      .query(`SELECT type FROM memory_jobs WHERE id = ?`)
      .get("migration-341-sweep-cacheless-graph-node-vectors") as {
      type: string;
    } | null;
    expect(job?.type).toBe("sweep_orphaned_graph_node_points");
  });
});

describe("migration 334 — flush_checkpoints self-heal (fresh telemetry DB, 327 marked applied)", () => {
  test("recreates a missing flush_checkpoints and completes the backfill", () => {
    const telemetry = telemetrySqlite();
    telemetry.exec(`DROP TABLE IF EXISTS flush_checkpoints`);

    expect(() => migrateBackfillTelemetryEventsOutbox(getDb())).not.toThrow();

    expect(tableExists(telemetry, "flush_checkpoints")).toBe(true);
    expect(columnNames(telemetry, "flush_checkpoints")).toEqual([
      "key",
      "value",
      "updated_at",
    ]);
  });
});
