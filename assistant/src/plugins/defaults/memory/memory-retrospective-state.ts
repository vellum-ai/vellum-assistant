// ---------------------------------------------------------------------------
// Memory retrospective — per-conversation state CRUD.
// ---------------------------------------------------------------------------
//
// Two pointers move independently:
//   - `lastProcessedMessageId` advances ONLY when a retrospective run
//     completes successfully (correctness invariant — failures must
//     re-process the same messages on the next attempt).
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
// resolved via `memorySqliteOrNull`; every read/write degrades to a no-op when
// that connection is unavailable. The memory database has no `conversations`
// table, so there is no FK cascade — the `conversation-deleted` hook purges the
// row explicitly instead.

import type { DrizzleDb } from "../../../persistence/db-connection.js";
import { withSqliteRetry } from "./host-utils.js";
import { getLogger } from "./logging.js";
import { memorySqliteOrNull } from "./memory-db.js";

const log = getLogger("memory-retrospective-state");

export interface MemoryRetrospectiveState {
  conversationId: string;
  lastProcessedMessageId: string;
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
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

function serializeRememberedLog(log: string[]): string | null {
  return log.length === 0 ? null : JSON.stringify(log);
}

/**
 * Return the `limit` most-recently-run retrospective state rows, newest first.
 */
export function listRetrospectiveStates(
  limit: number,
): MemoryRetrospectiveState[] {
  const raw = memorySqliteOrNull("listRetrospectiveStates");
  if (!raw) return [];
  const rows = raw
    .query(
      /*sql*/ `
      SELECT conversation_id, last_processed_message_id, last_run_at, remembered_log
      FROM memory_retrospective_state
      ORDER BY last_run_at DESC
      LIMIT ?
    `,
    )
    .all(limit) as Array<{
    conversation_id: string;
    last_processed_message_id: string;
    last_run_at: number;
    remembered_log: string | null;
  }>;
  return rows.map((row) => ({
    conversationId: row.conversation_id,
    lastProcessedMessageId: row.last_processed_message_id,
    lastRunAt: row.last_run_at,
    rememberedLog: parseRememberedLog(row.remembered_log),
  }));
}

/**
 * Load the state row for a conversation, or `null` if no row exists.
 */
export function getRetrospectiveState(
  conversationId: string,
): MemoryRetrospectiveState | null {
  const raw = memorySqliteOrNull("getRetrospectiveState");
  if (!raw) return null;
  const row = raw
    .query(
      /*sql*/ `
      SELECT conversation_id, last_processed_message_id, last_run_at, remembered_log
      FROM memory_retrospective_state WHERE conversation_id = ?
    `,
    )
    .get(conversationId) as {
    conversation_id: string;
    last_processed_message_id: string;
    last_run_at: number;
    remembered_log: string | null;
  } | null;
  if (!row) return null;
  return {
    conversationId: row.conversation_id,
    lastProcessedMessageId: row.last_processed_message_id,
    lastRunAt: row.last_run_at,
    rememberedLog: parseRememberedLog(row.remembered_log),
  };
}

/**
 * Upsert both pointers atomically. Used on successful retrospective runs.
 *
 * `rememberedLog`, when provided, is written in the same statement so the
 * cumulative dedup log can never drift from the pointer it was computed
 * against. When omitted, the stored log is left untouched (and seeded NULL on
 * first insert).
 */
export async function upsertRetrospectiveState(
  args: Omit<MemoryRetrospectiveState, "rememberedLog"> & {
    rememberedLog?: string[];
  },
): Promise<void> {
  const raw = memorySqliteOrNull("upsertRetrospectiveState");
  if (!raw) return;
  const serializedLog =
    args.rememberedLog === undefined
      ? undefined
      : serializeRememberedLog(args.rememberedLog);
  // Only overwrite the stored log when the caller supplied one, so an
  // omitted `rememberedLog` leaves the existing value untouched (seeded NULL
  // on first insert).
  const logUpdate =
    serializedLog !== undefined
      ? ", remembered_log = excluded.remembered_log"
      : "";
  await withSqliteRetry(
    () =>
      raw
        .query(
          /*sql*/ `
          INSERT INTO memory_retrospective_state
            (conversation_id, last_processed_message_id, last_run_at, remembered_log)
          VALUES (?, ?, ?, ?)
          ON CONFLICT (conversation_id) DO UPDATE SET
            last_processed_message_id = excluded.last_processed_message_id,
            last_run_at = excluded.last_run_at${logUpdate}
        `,
        )
        .run(
          args.conversationId,
          args.lastProcessedMessageId,
          args.lastRunAt,
          serializedLog ?? null,
        ),
    {
      op: "upsertRetrospectiveState",
      context: { conversationId: args.conversationId },
    },
  );
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
 *   - source pointer is past the fork boundary (not in `forkedMessageIds`) →
 *     child pointer is the last copied message's mapped ID. All copied
 *     messages have already been retro'd by the source, so the child should
 *     wait for new post-fork messages before its first retro fires.
 *
 * `lastRunAt` is copied verbatim — the cooldown gate inherits from source.
 * `rememberedLog` is copied verbatim — the parent's saves remain the child's
 * dedup baseline.
 *
 * The row lives on the memory connection, so this reads/writes there rather
 * than on the main fork transaction's handle — the `database` arg is unused
 * now, and an unavailable memory database is a best-effort no-op.
 */
export function forkRetrospectiveState(args: {
  database: DrizzleDb;
  sourceConversationId: string;
  forkedConversationId: string;
  forkedMessageIds: Map<string, string>;
  lastCopiedSourceMessageId: string | null;
}): void {
  const {
    sourceConversationId,
    forkedConversationId,
    forkedMessageIds,
    lastCopiedSourceMessageId,
  } = args;

  try {
    const raw = memorySqliteOrNull("forkRetrospectiveState");
    if (!raw) return;

    const sourceRow = raw
      .query(
        /*sql*/ `
      SELECT last_processed_message_id, last_run_at, remembered_log
      FROM memory_retrospective_state WHERE conversation_id = ?
    `,
      )
      .get(sourceConversationId) as {
      last_processed_message_id: string;
      last_run_at: number;
      remembered_log: string | null;
    } | null;
    if (!sourceRow) return;

    let forkedPointer = "";
    if (sourceRow.last_processed_message_id !== "") {
      const mapped = forkedMessageIds.get(sourceRow.last_processed_message_id);
      if (mapped !== undefined) {
        forkedPointer = mapped;
      } else if (lastCopiedSourceMessageId !== null) {
        // Source pointer is past the fork boundary — everything copied has
        // already been processed by the source, so clamp to the last copied
        // message so the fork waits for new post-fork messages.
        forkedPointer = forkedMessageIds.get(lastCopiedSourceMessageId) ?? "";
      }
    }

    raw
      .query(
        /*sql*/ `
      INSERT INTO memory_retrospective_state
        (conversation_id, last_processed_message_id, last_run_at, remembered_log)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (conversation_id) DO UPDATE SET
        last_processed_message_id = excluded.last_processed_message_id,
        last_run_at = excluded.last_run_at,
        remembered_log = excluded.remembered_log
    `,
      )
      .run(
        forkedConversationId,
        forkedPointer,
        sourceRow.last_run_at,
        sourceRow.remembered_log,
      );
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
  const raw = memorySqliteOrNull("bumpRetrospectiveLastRunAt");
  if (!raw) return;
  await withSqliteRetry(
    () =>
      raw
        .query(
          /*sql*/ `
          INSERT INTO memory_retrospective_state
            (conversation_id, last_processed_message_id, last_run_at)
          VALUES (?, '', ?)
          ON CONFLICT (conversation_id) DO UPDATE SET
            last_run_at = excluded.last_run_at
        `,
        )
        .run(conversationId, lastRunAt),
    { op: "bumpRetrospectiveLastRunAt", context: { conversationId } },
  );
}
