import { getConfig } from "../../config/loader.js";
import { getLogger } from "../../util/logger.js";
import { getDbPath } from "../../util/platform.js";
import { runAsyncSqlite } from "../db-async-query.js";
import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

const log = getLogger("db-init");

/**
 * Checkpoint key holding the highest `messages.rowid` already swept by this
 * migration. Persisted after every window so an interrupted run resumes from
 * where it left off instead of restarting the whole table scan. The value is a
 * plain integer string — deliberately not `started`/`rolling_back`, so
 * `recoverCrashedMigrations` never mistakes it for a stalled step and clears
 * it, and not `step:`-prefixed, so `validateMigrationState` ignores it.
 */
const WATERMARK_KEY = "migration_209_strip_thinking_watermark";

/**
 * Number of `rowid` values swept per `runAsyncSqlite` dispatch. Each window is
 * one off-thread subprocess transaction. The size stays well below the row
 * count of a typical `messages` table so the whole table is never swept in a
 * single subprocess: a window must finish inside {@link WINDOW_TIMEOUT_MS} for
 * the per-window watermark to advance, and only an advancing watermark lets an
 * interrupted run resume from the last completed window instead of re-running
 * the same window forever. A smaller window also bounds WAL growth per statement
 * and how long a single write lock is held, at the cost of more (cheap)
 * subprocess spawns.
 *
 * Exported for the regression test that asserts the table is swept across
 * multiple bounded windows rather than one table-sized sweep.
 */
export const ROWID_WINDOW = 2_000;

/**
 * Per-window wall-clock cap for the sweep subprocess. Set well above the time a
 * {@link ROWID_WINDOW}-sized window needs even on a multi-GB table with large
 * content blobs, so it trips only on a genuinely stuck subprocess (e.g. one
 * blocked on a stale write lock) rather than on legitimately slow progress.
 * Far below `runAsyncSqlite`'s one-hour whole-process default so a stuck window
 * surfaces in minutes and the runner retries from the last completed window on
 * the next boot.
 */
export const WINDOW_TIMEOUT_MS = 15 * 60 * 1000;

/** SQL predicate: this `json_each` element is an internal reasoning block. */
const IS_THINKING = `json_extract(value, '$.type') IN ('thinking', 'redacted_thinking')`;

/**
 * SQL predicate: this `json_each` element is kept. `IS NOT` (not `!=`) so a
 * block with a NULL/absent `type` is preserved, matching the JS filter the
 * original migration used (`b.type !== 'thinking'`).
 */
const IS_KEPT = `json_extract(value, '$.type') IS NOT 'thinking' AND json_extract(value, '$.type') IS NOT 'redacted_thinking'`;

/**
 * Build the two set-based UPDATEs that sweep one rowid window `(lo, hi]`.
 *
 *  - Statement A strips thinking/redacted_thinking blocks from rows that retain
 *    at least one kept block, rebuilding the content array in place. `json(value)`
 *    re-embeds each surviving element as JSON rather than a quoted string.
 *  - Statement B replaces all-thinking rows (no kept block survives) with the
 *    null-byte placeholder sentinel so the message isn't left empty. `char(0)`
 *    is evaluated inside SQLite, so the literal NUL is produced in the database
 *    and never written into the SQL piped to the sqlite3 CLI.
 *
 * Both are gated by a cheap `content LIKE '%thinking%'` substring prefilter
 * (covers both `thinking` and `redacted_thinking`) so the expensive `json_each`
 * work only runs for rows that could possibly contain a reasoning block. The
 * two statements touch disjoint row sets (A requires a kept block, B requires
 * none), so their order within the window is immaterial.
 */
function windowSql(lo: number, hi: number): string {
  const scope = `role = 'assistant'
       AND rowid > ${lo} AND rowid <= ${hi}
       AND content LIKE '%thinking%'
       AND json_valid(content)
       AND json_type(content) = 'array'`;

  const stripMixed = /*sql*/ `
    UPDATE messages
    SET content = (
      SELECT json_group_array(json(value))
      FROM json_each(messages.content)
      WHERE ${IS_KEPT}
    )
    WHERE ${scope}
      AND EXISTS (SELECT 1 FROM json_each(messages.content) WHERE ${IS_THINKING})
      AND EXISTS (SELECT 1 FROM json_each(messages.content) WHERE ${IS_KEPT});`;

  const placeholderOnly = /*sql*/ `
    UPDATE messages
    SET content = json_array(
      json_object('type', 'text', 'text', char(0) || '__PLACEHOLDER__[internal blocks omitted]')
    )
    WHERE ${scope}
      AND EXISTS (SELECT 1 FROM json_each(messages.content) WHERE ${IS_THINKING})
      AND NOT EXISTS (SELECT 1 FROM json_each(messages.content) WHERE ${IS_KEPT});`;

  return `${stripMixed}\n${placeholderOnly}`;
}

/**
 * Strip thinking and redacted_thinking blocks from all assistant messages.
 *
 * Consolidated messages merge thinking blocks from different API responses,
 * making their cryptographic signatures invalid. Previously the Anthropic
 * provider stripped these on every request, mutating the conversation prefix
 * and defeating prompt caching. This migration cleans them at rest so the
 * provider no longer needs to strip, enabling append-only conversation
 * history and stable prefix caching.
 *
 * The rewrite runs entirely inside SQLite (via JSON1), dispatched through
 * {@link runAsyncSqlite} a rowid window at a time. On a host with the `sqlite3`
 * CLI each window executes in a subprocess, leaving the daemon's event loop
 * free to answer `/healthz` while a multi-GB table is rewritten — the original
 * synchronous in-process loop blocked the loop for minutes and tripped the
 * startup probe into a restart loop. Progress is checkpointed per window, so an
 * interrupted run resumes instead of rescanning from the start.
 *
 * Idempotent — safe to re-run. Already-cleaned rows no longer contain a
 * thinking block, so the substring prefilter skips them.
 */
export async function migrateStripThinkingFromConsolidated(
  database: DrizzleDb,
): Promise<void> {
  // Gated on the async migration worker. This sweep proved too expensive for
  // the synchronous startup migration runner — on a large `messages` table it
  // can hold the daemon for minutes and trip the startup probe into a restart
  // loop. While `migrations.worker.enabled` is false, skip the work and let the
  // step pass so startup is never blocked; performing the sweep is deferred to
  // the new async migration runner once it takes shape.
  if (!getConfig().migrations.worker.enabled) {
    log.info(
      "Migration 209: skipped — migrations.worker.enabled is false; deferring the strip-thinking sweep to the async migration runner",
    );
    return;
  }

  const raw = getSqliteFrom(database);
  const dbPath = getDbPath();

  const maxRow = (
    raw.query(`SELECT MAX(rowid) AS m FROM messages`).get() as {
      m: number | null;
    }
  ).m;
  if (maxRow == null) return; // empty table — nothing to sweep

  const watermarkRow = raw
    .query(`SELECT value FROM memory_checkpoints WHERE key = ?`)
    .get(WATERMARK_KEY) as { value: string } | undefined;
  let lo = watermarkRow ? Number.parseInt(watermarkRow.value, 10) || 0 : 0;

  const setWatermark = raw.query(
    `INSERT OR REPLACE INTO memory_checkpoints (key, value, updated_at) VALUES (?, ?, ?)`,
  );

  while (lo < maxRow) {
    const hi = Math.min(lo + ROWID_WINDOW, maxRow);

    const res = await runAsyncSqlite(
      windowSql(lo, hi),
      `migration-209:strip-thinking-window:(${lo},${hi}]`,
      {
        dbPath,
        timeoutMs: WINDOW_TIMEOUT_MS,
      },
    );
    if (!res.ok) {
      // Leave the watermark at the last completed window; throwing reports the
      // step failed so the runner retries it (from the watermark) next boot
      // rather than checkpointing it as done.
      throw new Error(
        `strip-thinking window (${lo}, ${hi}] failed: ${res.error}`,
      );
    }

    lo = hi;
    setWatermark.run(WATERMARK_KEY, String(lo), Date.now());
  }

  // Bound WAL growth left by the windowed rewrites, then drop the watermark so
  // a future re-run (e.g. after a rollback) starts clean.
  await runAsyncSqlite(
    `PRAGMA wal_checkpoint(TRUNCATE);`,
    "migration-209:wal-checkpoint-truncate",
    { dbPath },
  );
  raw.query(`DELETE FROM memory_checkpoints WHERE key = ?`).run(WATERMARK_KEY);

  log.info(
    "Migration 209: stripped thinking blocks from consolidated messages",
  );
}
