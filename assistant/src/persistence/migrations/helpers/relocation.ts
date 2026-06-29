import type { Database } from "bun:sqlite";

import { getLogger } from "../../../util/logger.js";
import { getDbPath } from "../../../util/platform.js";
import {
  parseChangesFromStdout,
  runAsyncSqlite,
} from "../../db-async-query.js";

const log = getLogger("memory-db");

/**
 * Incremental relocation of a heavy table out of the main DB and into its
 * own file (`assistant-logs.db` / `assistant-memory.db`).
 *
 * A one-shot `INSERT … SELECT` + `DROP TABLE` of a multi-GB table on the daemon
 * connection would pin the write lock and block the event loop for minutes.
 * Instead a relocation runs as an async migration step in two parts:
 *
 *   1. {@link stageTableForRelocation} renames the source table in `main` aside
 *      to `<table>__relocating` (instant, metadata-only), so live reads/writes
 *      route to the dedicated connection's copy immediately.
 *   2. {@link drainStagedTable} copies the staged rows into the target file in
 *      bounded batches and truncates them from the staging table as it goes,
 *      then drops it. Each batch runs through `runAsyncSqlite`, which opens the
 *      target file directly (the sqlite3 subprocess ATTACHes it), so the work
 *      is independent of the daemon connection; the migration `await`s it to
 *      completion before checkpointing, so later startup work observes the
 *      finished move.
 *
 * The engine is generic: each migration owns its {@link RelocationSpec} (the
 * instance-specific columns / filter / target file) and passes it in.
 */

/** Suffix of the staging table the source is renamed to during relocation. */
export const RELOCATING_SUFFIX = "__relocating";

/**
 * Describes how to drain one relocatable table. Defined by the owning migration
 * — never centrally — so instance-specific SQL stays next to the migration that
 * needs it.
 */
export interface RelocationSpec {
  /** Live, unqualified table name (renamed aside, then drained into the target). */
  table: string;
  /** Absolute path of the attached DB file the table is moved into. */
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
  /**
   * Optional per-column SELECT expressions, keyed by column name, for columns
   * that must be transformed during the copy rather than carried verbatim
   * (e.g. resetting a status). The expression is evaluated against the staging
   * row; unlisted columns copy as-is (or NULL when absent from the source).
   */
  columnExpr?: Record<string, string>;
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
 * `table` comes from a {@link RelocationSpec} (never user input); it is quoted
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
 */
export async function drainStagedTable(
  raw: Database,
  spec: RelocationSpec,
): Promise<void> {
  const { table } = spec;
  const staging = `${table}${RELOCATING_SUFFIX}`;

  // Nothing to do once the staging table is gone (drain finished previously).
  if (!tableExistsInMain(raw, staging)) return;

  // Build a select list from the staging table's actual columns: apply any
  // per-column transform, copy a present column verbatim, NULL-fill an absent
  // (legacy) one so an older row still copies cleanly.
  const present = new Set(
    (
      raw
        .query(`SELECT name FROM pragma_table_info('${staging}', 'main')`)
        .all() as Array<{ name: string }>
    ).map((r) => r.name),
  );
  const colList = spec.columns.map((c) => `"${c}"`).join(", ");
  const selectList = spec.columns
    .map((c) => spec.columnExpr?.[c] ?? (present.has(c) ? `"${c}"` : "NULL"))
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
        `relocation:purge-batch:${table}`,
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
      `relocation:copy-batch:${table}`,
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
    `relocation:finalize:${table}`,
    { dbPath },
  );
  if (!finalizeRes.ok) {
    throw new Error(
      `relocation finalize failed for "${table}": ${finalizeRes.error}`,
    );
  }
  log.info({ table }, "relocation: complete — staging dropped");
}
