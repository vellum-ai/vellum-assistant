// ---------------------------------------------------------------------------
// Memory retrospective — per-conversation state CRUD.
// ---------------------------------------------------------------------------
//
// Two pointers move independently:
//   - `lastProcessedMessageId` advances ONLY when a retrospective run
//     completes successfully (correctness invariant — failures must
//     re-process the same messages on the next attempt). Its companion
//     `lastProcessedCreatedAt` is that row's `createdAt` at write time, so the
//     `(createdAt, id)` cursor stays reconstructible after the row itself is
//     deleted: a regenerated reply discards the latest assistant message,
//     which is exactly where the cursor tends to sit.
//   - `lastRunAt` advances at the end of every job that actually attempted a
//     run (success or failure). Drives the per-conversation cooldown gate in
//     the trigger-check helper so failing jobs can't loop in tight retries
//     across trigger types. The job's mid-turn skip intentionally leaves it
//     untouched so the turn-end trigger check can requeue immediately — see
//     `memory-retrospective-job.ts`.
//
// A third column rides along with the success-path pointer write:
//   - `rememberedLog` (JSON array of strings) — the cumulative `remember`
//     contents saved across retrospective passes. The job's
//     `<already_remembered>` dedup block reads from this log so dedup context
//     survives GC of superseded retrospective conversations and spans more
//     than the last pass. Capped — see `appendToRememberedLog`.
//
// The row lives on the dedicated memory connection (`assistant-memory.db`),
// resolved via `memoryDbOrNull`; every read/write degrades to a no-op when
// that connection is unavailable. The memory database has no `conversations`
// table, so there is no FK cascade — the `conversation-deleted` hook purges the
// row explicitly instead.
//
// `last_processed_created_at` is added to the table by
// `ensureRetrospectiveCursorColumn`: an idempotent, fail-open ALTER run lazily
// on first use in each process (daemon, memory worker, CLI) rather than by the
// global migration chain, which must not gate DB readiness on the memory
// database. The probe is memoized per memory connection, so a connection
// replaced by `resetDb()` (restores, imports) is probed again before its
// first read. When the column cannot be added, reads and writes fall back to
// the id-only cursor shape and the probe is retried after a short backoff.

import { desc, eq } from "drizzle-orm";

import type { DrizzleDb } from "../../../persistence/db-connection.js";
import { messageCreatedAtByIds } from "../../../persistence/message-reads.js";
import { memoryRetrospectiveState } from "../../../persistence/schema/index.js";
import { withSqliteRetry } from "./host-utils.js";
import { getLogger } from "./logging.js";
import { memoryDbOrNull, memorySqliteOrNull } from "./memory-db.js";

const log = getLogger("memory-retrospective-state");

const TABLE = "memory_retrospective_state";
const CURSOR_CREATED_AT_COLUMN = "last_processed_created_at";

export interface MemoryRetrospectiveState {
  conversationId: string;
  lastProcessedMessageId: string;
  /**
   * `createdAt` of the `lastProcessedMessageId` row when the pointer was
   * written, or null when unknown: rows written before the column existed,
   * and the `""` sentinel. Lets the cursor bound a read after its row is gone.
   */
  lastProcessedCreatedAt: number | null;
  lastRunAt: number;
  /**
   * Cumulative `remember` contents from prior retrospective passes, oldest
   * first. Empty for rows that predate the `remembered_log` column or have
   * no saves yet — callers fall back to scanning the prior retrospective
   * conversation in that case.
   */
  rememberedLog: string[];
}

/**
 * Cap for the persisted remembered log: keep the most recent entries up to
 * 100 entries or 8 KB serialized, whichever binds first. The log is injected
 * verbatim into every retrospective prompt, so the byte cap bounds prompt
 * growth; the entry cap bounds list length for pathological tiny entries.
 */
export const REMEMBERED_LOG_MAX_ENTRIES = 100;
export const REMEMBERED_LOG_MAX_BYTES = 8 * 1024;

/**
 * Append new entries to the remembered log and apply the cap, dropping the
 * OLDEST entries first. A single entry larger than the byte cap is dropped
 * entirely rather than truncated mid-string.
 */
export function appendToRememberedLog(
  existing: string[],
  newEntries: string[],
): string[] {
  const combined = [...existing, ...newEntries];
  let result = combined.slice(
    Math.max(0, combined.length - REMEMBERED_LOG_MAX_ENTRIES),
  );
  while (
    result.length > 0 &&
    Buffer.byteLength(JSON.stringify(result), "utf8") > REMEMBERED_LOG_MAX_BYTES
  ) {
    result = result.slice(1);
  }
  return result;
}

function parseRememberedLog(raw: string | null): string[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

function serializeRememberedLog(log: string[]): string | null {
  return log.length === 0 ? null : JSON.stringify(log);
}

// ---------------------------------------------------------------------------
// Cursor timestamp column
// ---------------------------------------------------------------------------

type MemorySqlite = NonNullable<ReturnType<typeof memorySqliteOrNull>>;

/** The memory connection the column was confirmed on; any other re-probes. */
let cursorColumnEnsuredOn: MemorySqlite | null = null;
/**
 * The connection the last probe failed on and when. The backoff applies to
 * that connection only: a replaced connection is probed at once, so a
 * restore right after a failure still gets the column before its first read.
 */
let cursorColumnFailedOn: MemorySqlite | null = null;
let lastCursorColumnFailureAt = 0;
/** Backoff before re-probing the same connection after a failed ALTER. */
const CURSOR_COLUMN_RETRY_MS = 60_000;

function isDuplicateColumnError(err: unknown): boolean {
  return err instanceof Error && /duplicate column name/i.test(err.message);
}

/**
 * Add `last_processed_created_at` to the state table when it is missing.
 * Idempotent; memoized per memory connection, so a connection replaced by
 * `resetDb()` is probed again and an imported database that lacks the column
 * gets it before its first read. Fail-open: when the ALTER cannot run, the
 * failure is logged, every read and write falls back to the id-only shape,
 * and that connection is probed again after {@link CURSOR_COLUMN_RETRY_MS}.
 * A table the migration chain has not created yet is neither memoized nor a
 * failure.
 */
export function ensureRetrospectiveCursorColumn(context: string): boolean {
  const raw = memorySqliteOrNull(context);
  if (!raw) {
    return false;
  }
  if (cursorColumnEnsuredOn === raw) {
    return true;
  }
  if (
    cursorColumnFailedOn === raw &&
    Date.now() - lastCursorColumnFailureAt < CURSOR_COLUMN_RETRY_MS
  ) {
    return false;
  }
  try {
    const columns = raw.query(`PRAGMA table_info(${TABLE})`).all() as Array<{
      name: string;
    }>;
    if (columns.length === 0) {
      return false;
    }
    if (!columns.some((column) => column.name === CURSOR_CREATED_AT_COLUMN)) {
      raw.exec(
        `ALTER TABLE ${TABLE} ADD COLUMN ${CURSOR_CREATED_AT_COLUMN} INTEGER`,
      );
    }
  } catch (err) {
    if (!isDuplicateColumnError(err)) {
      cursorColumnFailedOn = raw;
      lastCursorColumnFailureAt = Date.now();
      log.warn(
        { err, context },
        "could not add the retrospective cursor timestamp column; cursors fall back to id-only until the next probe",
      );
      return false;
    }
  }
  cursorColumnEnsuredOn = raw;
  cursorColumnFailedOn = null;
  return true;
}

/**
 * Forget the memoized column probe so the next call re-runs it. Intended
 * ONLY for tests that recreate the memory database mid-process.
 */
export function _resetRetrospectiveCursorColumnForTests(): void {
  cursorColumnEnsuredOn = null;
  cursorColumnFailedOn = null;
  lastCursorColumnFailureAt = 0;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const BASE_COLUMNS = {
  conversationId: memoryRetrospectiveState.conversationId,
  lastProcessedMessageId: memoryRetrospectiveState.lastProcessedMessageId,
  lastRunAt: memoryRetrospectiveState.lastRunAt,
  rememberedLog: memoryRetrospectiveState.rememberedLog,
};

const CURSOR_COLUMNS = {
  ...BASE_COLUMNS,
  lastProcessedCreatedAt: memoryRetrospectiveState.lastProcessedCreatedAt,
};

interface StateRow {
  conversationId: string;
  lastProcessedMessageId: string;
  lastRunAt: number;
  rememberedLog: string | null;
  lastProcessedCreatedAt?: number | null;
}

function toState(row: StateRow): MemoryRetrospectiveState {
  return {
    conversationId: row.conversationId,
    lastProcessedMessageId: row.lastProcessedMessageId,
    lastProcessedCreatedAt: row.lastProcessedCreatedAt ?? null,
    lastRunAt: row.lastRunAt,
    rememberedLog: parseRememberedLog(row.rememberedLog),
  };
}

/**
 * Return the `limit` most-recently-run retrospective state rows, newest first.
 */
export function listRetrospectiveStates(
  limit: number,
): MemoryRetrospectiveState[] {
  const mdb = memoryDbOrNull("listRetrospectiveStates");
  if (!mdb) {
    return [];
  }
  const rows: StateRow[] = ensureRetrospectiveCursorColumn(
    "listRetrospectiveStates",
  )
    ? mdb
        .select(CURSOR_COLUMNS)
        .from(memoryRetrospectiveState)
        .orderBy(desc(memoryRetrospectiveState.lastRunAt))
        .limit(limit)
        .all()
    : mdb
        .select(BASE_COLUMNS)
        .from(memoryRetrospectiveState)
        .orderBy(desc(memoryRetrospectiveState.lastRunAt))
        .limit(limit)
        .all();
  return rows.map(toState);
}

/**
 * Load the state row for a conversation, or `null` if no row exists.
 */
export function getRetrospectiveState(
  conversationId: string,
): MemoryRetrospectiveState | null {
  const mdb = memoryDbOrNull("getRetrospectiveState");
  if (!mdb) {
    return null;
  }
  const where = eq(memoryRetrospectiveState.conversationId, conversationId);
  const row: StateRow | undefined = ensureRetrospectiveCursorColumn(
    "getRetrospectiveState",
  )
    ? mdb
        .select(CURSOR_COLUMNS)
        .from(memoryRetrospectiveState)
        .where(where)
        .get()
    : mdb
        .select(BASE_COLUMNS)
        .from(memoryRetrospectiveState)
        .where(where)
        .get();
  return row ? toState(row) : null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Upsert both pointers atomically. Used on successful retrospective runs.
 *
 * `lastProcessedCreatedAt` is the id's companion and is rewritten with every
 * pointer write: an omitted value records "unknown" for the new id rather
 * than keeping the previous row's timestamp.
 *
 * `rememberedLog`, when provided, is written in the same statement so the
 * cumulative dedup log can never drift from the pointer it was computed
 * against. When omitted, the stored log is left untouched (and seeded NULL on
 * first insert).
 */
export async function upsertRetrospectiveState(
  args: Omit<
    MemoryRetrospectiveState,
    "rememberedLog" | "lastProcessedCreatedAt"
  > & {
    lastProcessedCreatedAt?: number | null;
    rememberedLog?: string[];
  },
): Promise<void> {
  const mdb = memoryDbOrNull("upsertRetrospectiveState");
  if (!mdb) {
    return;
  }
  const withCursor = ensureRetrospectiveCursorColumn(
    "upsertRetrospectiveState",
  );
  const serializedLog =
    args.rememberedLog === undefined
      ? undefined
      : serializeRememberedLog(args.rememberedLog);
  // Only overwrite the stored log when the caller supplied one, so an
  // omitted `rememberedLog` leaves the existing value untouched (seeded NULL
  // on first insert).
  const set: {
    lastProcessedMessageId: string;
    lastProcessedCreatedAt?: number | null;
    lastRunAt: number;
    rememberedLog?: string | null;
  } = {
    lastProcessedMessageId: args.lastProcessedMessageId,
    lastRunAt: args.lastRunAt,
  };
  if (withCursor) {
    set.lastProcessedCreatedAt = args.lastProcessedCreatedAt ?? null;
  }
  if (serializedLog !== undefined) {
    set.rememberedLog = serializedLog;
  }
  await withSqliteRetry(
    () =>
      mdb
        .insert(memoryRetrospectiveState)
        .values({
          conversationId: args.conversationId,
          lastProcessedMessageId: args.lastProcessedMessageId,
          lastRunAt: args.lastRunAt,
          rememberedLog: serializedLog ?? null,
          ...(withCursor
            ? { lastProcessedCreatedAt: args.lastProcessedCreatedAt ?? null }
            : {}),
        })
        .onConflictDoUpdate({
          target: memoryRetrospectiveState.conversationId,
          set,
        })
        .run(),
    {
      op: "upsertRetrospectiveState",
      context: { conversationId: args.conversationId },
    },
  );
}

/**
 * The copied source row that sits latest at or before `bound` in
 * `(createdAt, id)` order, as its forked id and `createdAt`, or null when
 * every copied row lies after the bound. Reads the source rows through the
 * fork transaction's handle.
 */
function latestCopiedRowAtOrBefore(
  database: DrizzleDb,
  forkedMessageIds: Map<string, string>,
  bound: { createdAt: number; id: string },
): { forkedId: string; createdAt: number } | null {
  const createdAtBySourceId = messageCreatedAtByIds(
    [...forkedMessageIds.keys()],
    { db: database },
  );
  let best: { sourceId: string; createdAt: number } | null = null;
  for (const [sourceId, createdAt] of createdAtBySourceId) {
    const atOrBefore =
      createdAt < bound.createdAt ||
      (createdAt === bound.createdAt && sourceId <= bound.id);
    if (!atOrBefore) {
      continue;
    }
    const later =
      best === null ||
      createdAt > best.createdAt ||
      (createdAt === best.createdAt && sourceId > best.sourceId);
    if (later) {
      best = { sourceId, createdAt };
    }
  }
  if (best === null) {
    return null;
  }
  const forkedId = forkedMessageIds.get(best.sourceId);
  return forkedId === undefined
    ? null
    : { forkedId, createdAt: best.createdAt };
}

/**
 * Carry the source conversation's retrospective state into a forked child so
 * the fork doesn't re-process content the parent already covered. Synchronous
 * so it can run inside the bun:sqlite transaction wrapping `forkConversation`.
 *
 * Mapping for `lastProcessedMessageId`:
 *
 *   - source has no state row → no-op (child inherits "first run" semantics
 *     and `findMostRecentRetrospectiveFor` walks the fork chain instead).
 *   - source pointer is the `""` sentinel (failed-only attempts, never
 *     succeeded) → child pointer is also `""`.
 *   - source pointer is within the copied range (`forkedMessageIds` has it) →
 *     child pointer is the mapped forked message ID.
 *   - source pointer is not in `forkedMessageIds` (its row was deleted, or it
 *     lies past the copied range) and carries a stored `createdAt` → child
 *     pointer is the latest copied row at or before the source's
 *     `(createdAt, id)` bound; copied rows after the bound stay unprocessed.
 *   - source pointer is not in `forkedMessageIds` and has no stored
 *     `createdAt` → child pointer is the last copied message's mapped ID, on
 *     the assumption it lies past the fork boundary.
 *
 * `lastProcessedCreatedAt` is read from the forked pointer's row through
 * `database`, the fork transaction's main-DB handle, which is the only handle
 * the freshly copied rows are visible through.
 * `lastRunAt` is copied verbatim — the cooldown gate inherits from source.
 * `rememberedLog` is copied verbatim — the parent's saves remain the child's
 * dedup baseline.
 *
 * The state row itself is written on the memory connection; an unavailable
 * memory database is a best-effort no-op.
 */
export function forkRetrospectiveState(args: {
  database: DrizzleDb;
  sourceConversationId: string;
  forkedConversationId: string;
  forkedMessageIds: Map<string, string>;
  lastCopiedSourceMessageId: string | null;
}): void {
  const {
    database,
    sourceConversationId,
    forkedConversationId,
    forkedMessageIds,
    lastCopiedSourceMessageId,
  } = args;

  try {
    const mdb = memoryDbOrNull("forkRetrospectiveState");
    if (!mdb) {
      return;
    }

    const withCursor = ensureRetrospectiveCursorColumn(
      "forkRetrospectiveState",
    );
    const sourceRow: StateRow | undefined = withCursor
      ? mdb
          .select(CURSOR_COLUMNS)
          .from(memoryRetrospectiveState)
          .where(
            eq(memoryRetrospectiveState.conversationId, sourceConversationId),
          )
          .get()
      : mdb
          .select(BASE_COLUMNS)
          .from(memoryRetrospectiveState)
          .where(
            eq(memoryRetrospectiveState.conversationId, sourceConversationId),
          )
          .get();
    if (!sourceRow) {
      return;
    }

    const sourcePointer = sourceRow.lastProcessedMessageId;
    const sourceCreatedAt = sourceRow.lastProcessedCreatedAt ?? null;
    let forkedPointer = "";
    let forkedCreatedAt: number | null = null;
    if (sourcePointer !== "") {
      const mapped = forkedMessageIds.get(sourcePointer);
      if (mapped !== undefined) {
        forkedPointer = mapped;
        forkedCreatedAt =
          messageCreatedAtByIds([forkedPointer], { db: database }).get(
            forkedPointer,
          ) ?? null;
      } else if (sourceCreatedAt !== null) {
        // The source pointer is not among the copied rows: either its row
        // was deleted (a regenerated reply) or it lies past the copied range.
        // Its stored `(createdAt, id)` bound still says where it sat, so the
        // child takes the latest copied row at or before that bound. Copied
        // rows after it (a replacement reply, later turns) stay unprocessed;
        // a bound before every copied row leaves the child at "nothing
        // processed yet".
        const placed = latestCopiedRowAtOrBefore(database, forkedMessageIds, {
          createdAt: sourceCreatedAt,
          id: sourcePointer,
        });
        if (placed) {
          forkedPointer = placed.forkedId;
          forkedCreatedAt = placed.createdAt;
        }
      } else if (lastCopiedSourceMessageId !== null) {
        // No stored bound to place a missing pointer by (a row written before
        // timestamps were kept): treat it as past the fork boundary and clamp
        // to the last copied message so the fork waits for new post-fork
        // messages.
        forkedPointer = forkedMessageIds.get(lastCopiedSourceMessageId) ?? "";
        forkedCreatedAt =
          forkedPointer === ""
            ? null
            : (messageCreatedAtByIds([forkedPointer], { db: database }).get(
                forkedPointer,
              ) ?? null);
      }
    }

    const values = {
      lastProcessedMessageId: forkedPointer,
      lastRunAt: sourceRow.lastRunAt,
      rememberedLog: sourceRow.rememberedLog,
      ...(withCursor ? { lastProcessedCreatedAt: forkedCreatedAt } : {}),
    };

    mdb
      .insert(memoryRetrospectiveState)
      .values({ conversationId: forkedConversationId, ...values })
      .onConflictDoUpdate({
        target: memoryRetrospectiveState.conversationId,
        set: values,
      })
      .run();
  } catch (err) {
    log.warn({ err }, "failed to fork retrospective state; continuing");
  }
}

/**
 * Advance only `lastRunAt`. Used on failure paths that attempted a run (wake
 * failure, fork failure) so the cooldown gate applies to subsequent
 * trigger-driven enqueues; the mid-turn skip does NOT call this. If no row
 * exists yet (first attempt failed), seed `lastProcessedMessageId` to the
 * empty string — a sentinel meaning "nothing successfully processed yet"
 * that subsequent `getMessagesSince(...)` queries treat the same as a
 * missing row. An existing row's `rememberedLog` is left untouched.
 */
export async function bumpRetrospectiveLastRunAt(
  conversationId: string,
  lastRunAt: number,
): Promise<void> {
  const mdb = memoryDbOrNull("bumpRetrospectiveLastRunAt");
  if (!mdb) {
    return;
  }
  await withSqliteRetry(
    () =>
      mdb
        .insert(memoryRetrospectiveState)
        .values({
          conversationId,
          lastProcessedMessageId: "",
          lastRunAt,
        })
        .onConflictDoUpdate({
          target: memoryRetrospectiveState.conversationId,
          set: { lastRunAt },
        })
        .run(),
    { op: "bumpRetrospectiveLastRunAt", context: { conversationId } },
  );
}
