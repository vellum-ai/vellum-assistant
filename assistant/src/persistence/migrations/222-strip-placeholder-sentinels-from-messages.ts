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
 * Number of `rowid` values swept per `runAsyncSqlite` dispatch. Each window is
 * one off-thread subprocess transaction. Keeping it well below the row count of
 * a typical `messages` table bounds how long a single write lock is held and how
 * much WAL one statement appends, at the cost of more (cheap) subprocess spawns.
 */
export const ROWID_WINDOW = 2_000;

/**
 * Per-window wall-clock cap for the sweep subprocess. Set well above the time a
 * {@link ROWID_WINDOW}-sized window needs even on a multi-GB table with large
 * content blobs, so it trips only on a genuinely stuck subprocess (e.g. one
 * blocked on a stale write lock) rather than on legitimately slow progress.
 * Far below `runAsyncSqlite`'s one-hour whole-process default so a stuck window
 * surfaces in minutes instead of blocking startup for an hour.
 */
export const WINDOW_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * SQL list of every sentinel `text` value to drop, in both the null-byte-
 * prefixed form the providers emit and the bare form that survives a tool
 * stripping the leading NUL. `char(0)` is evaluated inside SQLite so the literal
 * control byte is produced in the database and never written into the SQL piped
 * to the sqlite3 CLI. Derived from the exported sentinel constants so the set
 * stays in sync with `isPlaceholderSentinelText`.
 */
const SENTINEL_TEXT_LIST = [PLACEHOLDER_EMPTY_TURN, PLACEHOLDER_BLOCKS_OMITTED]
  .map((full) => (full.startsWith("\x00") ? full.slice(1) : full))
  .flatMap((bare) => {
    const escaped = bare.replace(/'/g, "''");
    return [`'${escaped}'`, `char(0) || '${escaped}'`];
  })
  .join(", ");

/** SQL predicate: this `json_each` element is a placeholder-sentinel text block. */
const ELEMENT_IS_SENTINEL = `(json_extract(value, '$.type') = 'text'
   AND json_extract(value, '$.text') IN (${SENTINEL_TEXT_LIST})) IS 1`;

/**
 * SQL predicate: this `json_each` element is kept. `IS NOT 1` (rather than a
 * bare `NOT`) keeps any element whose sentinel test is false *or* NULL, so a
 * non-text block — or one with an absent `type`/`text` — survives, dropping only
 * exact sentinel text blocks.
 */
const ELEMENT_IS_KEPT = `(json_extract(value, '$.type') = 'text'
   AND json_extract(value, '$.text') IN (${SENTINEL_TEXT_LIST})) IS NOT 1`;

/**
 * Build the two set-based UPDATEs that sweep one rowid window `(lo, hi]`.
 *
 *  - Statement A strips sentinel text blocks from rows that retain at least one
 *    kept block, rebuilding the content array in place. `json(value)` re-embeds
 *    each surviving element as JSON rather than a quoted string.
 *  - Statement B replaces all-sentinel rows (no kept block survives) with an
 *    empty array `[]`.
 *
 * Both are gated by a cheap `content LIKE '%__PLACEHOLDER__%'` substring
 * prefilter so the expensive `json_each` work only runs for rows that could
 * possibly contain a sentinel. The two statements touch disjoint row sets (A
 * requires a kept block, B requires none), so their order within the window is
 * immaterial.
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
 * Strip provider placeholder sentinel text blocks from persisted assistant
 * messages.
 *
 * PLACEHOLDER_EMPTY_TURN and PLACEHOLDER_BLOCKS_OMITTED are injected into
 * outbound provider request bodies (Anthropic role alternation, OpenAI-
 * compatible "content or tool_calls" constraint) when an assistant turn would
 * otherwise be empty. They are never supposed to be persisted, but a leak path
 * caused them to be stored in the messages table where they render in chat
 * bubbles as bold "PLACEHOLDER[...]" (markdown interprets the double-underscore
 * surround as bold).
 *
 * The strip runs entirely inside SQLite (via JSON1), dispatched through
 * {@link runAsyncSqlite} a rowid window at a time. On a host with the `sqlite3`
 * CLI each window executes in a subprocess, so the daemon's event loop stays
 * free to answer `/healthz` while the messages table is rewritten and each
 * window's write transaction stays small and short-lived.
 *
 * Idempotent — already-cleaned rows no longer contain a sentinel, so the
 * substring prefilter skips them. The migration runner owns run-once
 * bookkeeping: it only records the step as applied once this function returns,
 * so a boot interrupted mid-sweep simply re-runs the whole sweep next boot.
 */
export async function migrateStripPlaceholderSentinelsFromMessages(
  database: DrizzleDb,
): Promise<void> {
  // Gated on the async migration worker. This full-table sweep proved too
  // expensive for the synchronous startup migration runner — on a large
  // `messages` table it can hold the daemon's event loop and write lock for
  // minutes. While `migrations.worker.enabled` is false, skip the work and let
  // the step pass so startup is never blocked; performing the sweep is deferred
  // to the new async migration runner once it takes shape.
  if (!getConfig().migrations.worker.enabled) {
    log.info(
      "Migration 222: skipped — migrations.worker.enabled is false; deferring the placeholder-sentinel sweep to the async migration runner",
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
      `migration-222:strip-placeholder-window:(${lo},${hi}]`,
      {
        dbPath,
        timeoutMs: WINDOW_TIMEOUT_MS,
      },
    );
    if (!res.ok) {
      // Surface the failure so the runner leaves the step un-checkpointed and
      // retries the whole sweep on the next boot.
      throw new Error(
        `strip-placeholder window (${lo}, ${hi}] failed: ${res.error}`,
      );
    }
  }

  // Bound WAL growth left by the windowed rewrites.
  await runAsyncSqlite(
    `PRAGMA wal_checkpoint(TRUNCATE);`,
    "migration-222:wal-checkpoint-truncate",
    { dbPath },
  );
}
