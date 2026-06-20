import type { Database } from "bun:sqlite";

import { getLogger } from "../util/logger.js";
import { getLogsDbPath } from "../util/logs-db-path.js";
import { getMemoryDbPath } from "../util/memory-db-path.js";
import { getDbPath } from "../util/platform.js";
import { parseChangesFromStdout, runAsyncSqlite } from "./db-async-query.js";
import {
  getSqlite,
  LOGS_DB_SCHEMA,
  MEMORY_DB_SCHEMA,
} from "./db-connection.js";

const log = getLogger("memory-db");

/**
 * Incremental relocation of a heavy table out of the main DB and into an
 * attached file (`assistant-logs.db` / `assistant-memory.db`).
 *
 * A one-shot `INSERT … SELECT` + `DROP TABLE` of a multi-GB table on the daemon
 * connection would pin the write lock and block the event loop for minutes.
 * Instead a relocation runs as an async migration step in two parts:
 *
 *   1. {@link stageTableForRelocation} creates the table in the target schema,
 *      then renames the source table in `main` aside to `<table>__relocating`
 *      (instant, metadata-only). Once `main` no longer has `<table>`, the
 *      unqualified name resolves to the attached copy, so live reads/writes
 *      route correctly immediately.
 *   2. {@link drainStagedTable} copies the staged rows into the target in
 *      bounded batches and truncates them from the staging table as it goes,
 *      then drops it. Each batch runs off the connection via `runAsyncSqlite`,
 *      so the event loop is free between batches; the migration `await`s it to
 *      completion before checkpointing, so later startup work observes the
 *      finished move.
 */

/** Suffix of the staging table the source is renamed to during relocation. */
export const RELOCATING_SUFFIX = "__relocating";

export interface RelocationSpec {
  /** Live, unqualified table name. Lives in {@link targetSchema} post-move. */
  table: string;
  /** Attached schema the table is moved into. */
  targetSchema: string;
  /** Absolute path of the attached DB file holding the table. */
  targetDbPath: () => string;
  /**
   * Columns to copy, in a fixed order — listed explicitly (not `SELECT *`) so
   * the copy is insensitive to the physical column order of the source table,
   * which varies with the history of `ALTER TABLE … ADD COLUMN` migrations.
   * Columns absent from the (legacy) source are copied as NULL.
   */
  columns: string[];
  /**
   * Optional predicate (evaluated against the staging table) selecting rows
   * worth preserving. Rows that do **not** match are deleted without being
   * copied. Omit to copy every row.
   */
  copyWhere?: string;
}

/**
 * Registry of relocatable tables, keyed by table name. {@link drainStagedTable}
 * looks the spec up by table name, so callers pass only the name — never SQL.
 */
export const RELOCATION_SPECS: Record<string, RelocationSpec> = {
  llm_request_logs: {
    table: "llm_request_logs",
    targetSchema: LOGS_DB_SCHEMA,
    targetDbPath: getLogsDbPath,
    columns: [
      "id",
      "conversation_id",
      "message_id",
      "provider",
      "request_payload",
      "response_payload",
      "created_at",
      "agent_loop_exit_reason",
      "call_site",
    ],
  },
  memory_jobs: {
    table: "memory_jobs",
    targetSchema: MEMORY_DB_SCHEMA,
    targetDbPath: getMemoryDbPath,
    columns: [
      "id",
      "type",
      "payload",
      "status",
      "attempts",
      "deferrals",
      "run_after",
      "last_error",
      "started_at",
      "created_at",
      "updated_at",
    ],
    // Only pending/running jobs are worth keeping; the bulk of a runaway queue
    // is terminal (completed/failed) rows that are purged without copying.
    copyWhere: "status IN ('pending','running')",
  },
};

/** True if `schema` is currently ATTACHed to the connection. */
export function isSchemaAttached(raw: Database, schema: string): boolean {
  const rows = raw
    .query<{ name: string }, []>("PRAGMA database_list")
    .all() as Array<{ name: string }>;
  return rows.some((r) => r.name === schema);
}

function tableExistsInMain(raw: Database, name: string): boolean {
  return (
    raw
      .query(
        `SELECT name FROM main.sqlite_master WHERE type='table' AND name = ?`,
      )
      .get(name) != null
  );
}

function tableIsEmpty(raw: Database, name: string): boolean {
  // EXISTS short-circuits at the first row, so this stays cheap even on a huge
  // table — no full COUNT(*) scan.
  return raw.query(`SELECT 1 FROM main."${name}" LIMIT 1`).get() == null;
}

/**
 * Move the source table in `main` aside so the unqualified name resolves to the
 * attached copy, returning whether a staging table now exists (i.e. a drain is
 * needed). Idempotent and safe to re-run after a crash:
 *
 *   - `main.<table>` empty           → drop it (a freshly recreated shadow, or
 *                                       an already-drained leftover).
 *   - `main.<table>` non-empty, no
 *     staging yet                     → rename it to `<table>__relocating`.
 *   - staging already exists          → leave it; a prior boot started the move.
 *
 * `table` comes from {@link RELOCATION_SPECS} (never user input); it is quoted
 * defensively all the same.
 */
export function stageTableForRelocation(raw: Database, table: string): boolean {
  const staging = `${table}${RELOCATING_SUFFIX}`;
  const hasStaging = tableExistsInMain(raw, staging);

  if (tableExistsInMain(raw, table)) {
    if (tableIsEmpty(raw, table)) {
      raw.exec(`DROP TABLE main."${table}"`);
    } else if (!hasStaging) {
      raw.exec(`ALTER TABLE main."${table}" RENAME TO "${staging}"`);
      return true;
    }
    // else: a non-empty live table alongside an existing staging table is not
    // expected; leave both and let the in-flight drain finish first.
  }

  return tableExistsInMain(raw, staging);
}

/**
 * Rows copied/purged per drain batch. Each batch is a couple of bounded
 * statements, so the write lock is held only briefly and the event loop is free
 * between batches. Sized as a balance between throughput and lock-hold time.
 */
const DRAIN_BATCH = 10_000;

/**
 * Drain a `<table>__relocating` staging table created by
 * {@link stageTableForRelocation}: copy the rows worth keeping into the attached
 * target in bounded batches, purge the rest without copying, then drop the
 * staging table and truncate the main WAL. Resolves once the move is complete.
 *
 * Awaited inline by the relocation migration step, so it runs at most once per
 * boot under the migration runner's checkpoint: an interrupted drain leaves the
 * step uncheckpointed and the staging table in place, and the next boot
 * re-stages (a no-op) and resumes from the remaining rows. Each batch is
 * dispatched off the connection via `runAsyncSqlite` (sqlite3 subprocess when
 * available; in-process fallback otherwise), keeping the event loop responsive
 * between batches. A batch failure throws so the step is reported failed and
 * retried on the next boot rather than checkpointed as done.
 *
 * `table` comes from {@link RELOCATION_SPECS} (never user input); names are
 * quoted defensively all the same.
 */
export async function drainStagedTable(table: string): Promise<void> {
  const spec = RELOCATION_SPECS[table];
  if (!spec) throw new Error(`drainStagedTable: unknown table "${table}"`);

  const staging = `${table}${RELOCATING_SUFFIX}`;
  const raw = getSqlite();

  // Nothing to do once the staging table is gone (drain finished previously).
  if (!tableExistsInMain(raw, staging)) return;

  // Build a NULL-filling select list from the staging table's actual columns so
  // a legacy row missing a newer (nullable) column still copies cleanly.
  const present = new Set(
    (
      raw
        .query(`SELECT name FROM pragma_table_info('${staging}', 'main')`)
        .all() as Array<{ name: string }>
    ).map((r) => r.name),
  );
  const colList = spec.columns.map((c) => `"${c}"`).join(", ");
  const selectList = spec.columns
    .map((c) => (present.has(c) ? `"${c}"` : "NULL"))
    .join(", ");

  const dbPath = getDbPath();
  const whereCopy = spec.copyWhere ? `WHERE ${spec.copyWhere}` : "";

  for (;;) {
    // (1) Purge a batch of non-keeper rows (no copy) when a copy filter narrows
    //     what is worth preserving — this is the bulk of a runaway queue.
    let purged = 0;
    if (spec.copyWhere) {
      const res = await runAsyncSqlite(
        `DELETE FROM "${staging}" WHERE rowid IN (` +
          `SELECT rowid FROM "${staging}" WHERE NOT (${spec.copyWhere}) LIMIT ${DRAIN_BATCH});\n` +
          `SELECT changes();`,
        { dbPath },
      );
      if (!res.ok) {
        throw new Error(
          `relocation purge batch failed for "${table}": ${res.error}`,
        );
      }
      purged = parseChangesFromStdout(res.stdout);
    }

    // (2) Copy a batch of keepers, then truncate those same rows. Two
    //     autocommitted statements (no BEGIN): the copy commits before the
    //     delete, so a crash in between just re-copies (INSERT OR IGNORE no-op)
    //     and re-deletes next boot — safe across the non-atomic cross-DB commit.
    const copyRes = await runAsyncSqlite(
      `INSERT OR IGNORE INTO "${table}" (${colList}) ` +
        `SELECT ${selectList} FROM "${staging}" ${whereCopy} ORDER BY rowid LIMIT ${DRAIN_BATCH};\n` +
        `DELETE FROM "${staging}" WHERE rowid IN (` +
        `SELECT rowid FROM "${staging}" ${whereCopy} ORDER BY rowid LIMIT ${DRAIN_BATCH});\n` +
        `SELECT changes();`,
      {
        dbPath,
        attach: [{ path: spec.targetDbPath(), alias: "_reloc_target" }],
      },
    );
    if (!copyRes.ok) {
      throw new Error(
        `relocation copy batch failed for "${table}": ${copyRes.error}`,
      );
    }
    const moved = parseChangesFromStdout(copyRes.stdout);

    if (purged > 0 || moved > 0) {
      log.info({ table, purged, moved }, "relocation: drain progressed");
      continue;
    }
    break;
  }

  // Drained — drop the (now empty) staging table and truncate the main WAL.
  const finalizeRes = await runAsyncSqlite(
    `DROP TABLE IF EXISTS "${staging}";\nPRAGMA wal_checkpoint(TRUNCATE);`,
    { dbPath },
  );
  if (!finalizeRes.ok) {
    throw new Error(
      `relocation finalize failed for "${table}": ${finalizeRes.error}`,
    );
  }
  log.info({ table }, "relocation: complete — staging dropped");
}
