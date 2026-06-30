import { getConfig } from "../../config/loader.js";
import {
  PLACEHOLDER_BLOCKS_OMITTED,
  PLACEHOLDER_EMPTY_TURN,
} from "../../providers/placeholder-sentinels.js";
import { getLogger } from "../../util/logger.js";
import { getDbPath } from "../../util/platform.js";
import { runAsyncSqlite } from "../db-async-query.js";
import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

const log = getLogger("db-init");

/**
 * Rowid window per `runAsyncSqlite` dispatch and the per-window wall-clock cap.
 * Same values and rationale as migration 222 — each window is one off-thread
 * subprocess transaction, sized to bound how long a single write lock is held
 * and how much WAL one statement appends on a multi-GB `messages` table.
 */
export const ROWID_WINDOW = 2_000;
export const WINDOW_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * SQL list of every sentinel `text` value to drop, in both the null-byte-
 * prefixed form the providers emit and the bare form. `char(0)` is produced
 * inside SQLite so the literal control byte never enters the SQL text piped to
 * the sqlite3 CLI. Derived from the exported sentinel constants so the set stays
 * in sync with `isPlaceholderSentinelText`.
 */
const SENTINEL_TEXT_LIST = [PLACEHOLDER_EMPTY_TURN, PLACEHOLDER_BLOCKS_OMITTED]
  .map((full) => (full.startsWith("\x00") ? full.slice(1) : full))
  .flatMap((bare) => {
    const escaped = bare.replace(/'/g, "''");
    return [`'${escaped}'`, `char(0) || '${escaped}'`];
  })
  .join(", ");

/**
 * The text value to match, with surrounding whitespace trimmed so an echo whose
 * `\x00` guard byte arrived as a leading space still matches. The trim set lists
 * whitespace bytes only (tab, newline, carriage return, space) and deliberately
 * omits `char(0)`: SQLite treats an embedded NUL as a string terminator, so a
 * NUL in the trim set collapses it and trims nothing. The NUL-prefixed forms are
 * matched directly via SENTINEL_TEXT_LIST instead.
 */
const SENTINEL_TEXT_EXPR = `trim(json_extract(value, '$.text'), char(9) || char(10) || char(13) || char(32))`;

/** SQL predicate: this `json_each` element is a placeholder-sentinel text block. */
const ELEMENT_IS_SENTINEL = `(json_extract(value, '$.type') = 'text'
   AND ${SENTINEL_TEXT_EXPR} IN (${SENTINEL_TEXT_LIST})) IS 1`;

/**
 * SQL predicate: this `json_each` element is kept. `IS NOT 1` (rather than a
 * bare `NOT`) keeps any element whose sentinel test is false *or* NULL, so a
 * non-text block — or one with an absent `type`/`text` — survives, dropping only
 * sentinel text blocks (matched after trimming surrounding whitespace).
 */
const ELEMENT_IS_KEPT = `(json_extract(value, '$.type') = 'text'
   AND ${SENTINEL_TEXT_EXPR} IN (${SENTINEL_TEXT_LIST})) IS NOT 1`;

/**
 * Build the two set-based UPDATEs that sweep one rowid window `(lo, hi]`.
 *
 *  - Statement A strips sentinel text blocks from rows that retain at least one
 *    kept block, rebuilding the content array in place.
 *  - Statement B replaces all-sentinel rows (no kept block survives) with an
 *    empty array `[]`.
 *
 * Both are gated by a cheap `content LIKE '%__PLACEHOLDER__%'` substring
 * prefilter so the expensive `json_each` work only runs for candidate rows.
 */
function windowSql(lo: number, hi: number): string {
  const scope = `role = 'assistant'
       AND rowid > ${lo} AND rowid <= ${hi}
       AND content LIKE '%__PLACEHOLDER__%'
       AND json_valid(content)
       AND json_type(content) = 'array'`;

  const stripMixed = /*sql*/ `
    UPDATE messages
    SET content = (
      SELECT json_group_array(json(value))
      FROM json_each(messages.content)
      WHERE ${ELEMENT_IS_KEPT}
    )
    WHERE ${scope}
      AND EXISTS (SELECT 1 FROM json_each(messages.content) WHERE ${ELEMENT_IS_SENTINEL})
      AND EXISTS (SELECT 1 FROM json_each(messages.content) WHERE ${ELEMENT_IS_KEPT});`;

  const sentinelOnly = /*sql*/ `
    UPDATE messages
    SET content = json_array()
    WHERE ${scope}
      AND EXISTS (SELECT 1 FROM json_each(messages.content) WHERE ${ELEMENT_IS_SENTINEL})
      AND NOT EXISTS (SELECT 1 FROM json_each(messages.content) WHERE ${ELEMENT_IS_KEPT});`;

  return `${stripMixed}\n${sentinelOnly}`;
}

/**
 * Strip placeholder sentinel text blocks whose `\x00` guard byte was replaced by
 * surrounding whitespace before persistence.
 *
 * Migration 222 strips the exact sentinel forms, but an Anthropic-compatible
 * proxy can echo the marker back with the `\x00` guard replaced by a leading
 * space (` __PLACEHOLDER__[empty assistant turn]`), which 222's exact-match
 * predicate misses. Each migration step is checkpointed by function name and
 * runs at most once per database, so widening 222 in place would never re-run on
 * installs that already recorded it; this is a separate step so the trimmed
 * sweep runs on every database. The trimmed predicate also matches the exact
 * forms, so this is a superset of 222 and stays idempotent.
 *
 * Mirrors 222's windowed, worker-gated execution: the sweep runs entirely inside
 * SQLite via {@link runAsyncSqlite}, a rowid window at a time, so the daemon
 * event loop and write lock stay free. While `migrations.worker.enabled` is
 * false the work is deferred to the async migration runner.
 */
export async function migrateStripWhitespaceCorruptedPlaceholderSentinelsFromMessages(
  database: DrizzleDb,
): Promise<void> {
  if (!getConfig().migrations.worker.enabled) {
    log.info(
      "Migration 311: skipped — migrations.worker.enabled is false; deferring the whitespace-corrupted placeholder-sentinel sweep to the async migration runner",
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

  for (let lo = 0; lo < maxRow; lo += ROWID_WINDOW) {
    const hi = Math.min(lo + ROWID_WINDOW, maxRow);

    const res = await runAsyncSqlite(
      windowSql(lo, hi),
      `migration-311:strip-whitespace-placeholder-window:(${lo},${hi}]`,
      {
        dbPath,
        timeoutMs: WINDOW_TIMEOUT_MS,
      },
    );
    if (!res.ok) {
      // Surface the failure so the runner leaves the step un-checkpointed and
      // retries the whole sweep on the next boot.
      throw new Error(
        `strip-whitespace-placeholder window (${lo}, ${hi}] failed: ${res.error}`,
      );
    }
  }

  // Bound WAL growth left by the windowed rewrites.
  await runAsyncSqlite(
    `PRAGMA wal_checkpoint(TRUNCATE);`,
    "migration-311:wal-checkpoint-truncate",
    { dbPath },
  );
}
