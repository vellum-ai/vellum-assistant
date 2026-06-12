// ---------------------------------------------------------------------------
// Memory retrospective — per-conversation state CRUD.
// ---------------------------------------------------------------------------
//
// Two pointers move independently:
//   - `lastProcessedMessageId` advances ONLY when a retrospective run
//     completes successfully (correctness invariant — failures must
//     re-process the same messages on the next attempt).
//   - `lastRunAt` advances on EVERY job end (success or failure). Drives the
//     per-conversation cooldown gate in the trigger-check helper so failing
//     jobs can't loop in tight retries across trigger types.
//
// A third column rides along with the success-path pointer write:
//   - `rememberedLog` (JSON array of strings) — the cumulative `remember`
//     contents saved across retrospective passes. The job's
//     `<already_remembered>` dedup block reads from this log so dedup context
//     survives GC of superseded retrospective conversations and spans more
//     than the last pass. Capped — see `appendToRememberedLog`.
//
// The schema enforces the foreign key with ON DELETE CASCADE, so deleting a
// conversation collects its state row automatically.

import { eq } from "drizzle-orm";

import { type DrizzleDb, getDb } from "./db-connection.js";
import { memoryRetrospectiveState } from "./schema.js";

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
 * Load the state row for a conversation, or `null` if no row exists.
 */
export function getRetrospectiveState(
  conversationId: string,
): MemoryRetrospectiveState | null {
  const row = getDb()
    .select()
    .from(memoryRetrospectiveState)
    .where(eq(memoryRetrospectiveState.conversationId, conversationId))
    .get();
  if (!row) return null;
  return {
    conversationId: row.conversationId,
    lastProcessedMessageId: row.lastProcessedMessageId,
    lastRunAt: row.lastRunAt,
    rememberedLog: parseRememberedLog(row.rememberedLog),
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
export function upsertRetrospectiveState(
  args: Omit<MemoryRetrospectiveState, "rememberedLog"> & {
    rememberedLog?: string[];
  },
): void {
  const db = getDb();
  const serializedLog =
    args.rememberedLog === undefined
      ? undefined
      : serializeRememberedLog(args.rememberedLog);
  db.insert(memoryRetrospectiveState)
    .values({
      conversationId: args.conversationId,
      lastProcessedMessageId: args.lastProcessedMessageId,
      lastRunAt: args.lastRunAt,
      rememberedLog: serializedLog ?? null,
    })
    .onConflictDoUpdate({
      target: memoryRetrospectiveState.conversationId,
      set: {
        lastProcessedMessageId: args.lastProcessedMessageId,
        lastRunAt: args.lastRunAt,
        ...(serializedLog !== undefined
          ? { rememberedLog: serializedLog }
          : {}),
      },
    })
    .run();
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

  const sourceRow = database
    .select()
    .from(memoryRetrospectiveState)
    .where(eq(memoryRetrospectiveState.conversationId, sourceConversationId))
    .get();
  if (!sourceRow) return;

  let forkedPointer = "";
  if (sourceRow.lastProcessedMessageId !== "") {
    const mapped = forkedMessageIds.get(sourceRow.lastProcessedMessageId);
    if (mapped !== undefined) {
      forkedPointer = mapped;
    } else if (lastCopiedSourceMessageId !== null) {
      // Source pointer is past the fork boundary — everything copied has
      // already been processed by the source, so clamp to the last copied
      // message so the fork waits for new post-fork messages.
      forkedPointer = forkedMessageIds.get(lastCopiedSourceMessageId) ?? "";
    }
  }

  database
    .insert(memoryRetrospectiveState)
    .values({
      conversationId: forkedConversationId,
      lastProcessedMessageId: forkedPointer,
      lastRunAt: sourceRow.lastRunAt,
      rememberedLog: sourceRow.rememberedLog,
    })
    .onConflictDoUpdate({
      target: memoryRetrospectiveState.conversationId,
      set: {
        lastProcessedMessageId: forkedPointer,
        lastRunAt: sourceRow.lastRunAt,
        rememberedLog: sourceRow.rememberedLog,
      },
    })
    .run();
}

/**
 * Advance only `lastRunAt`. Used on every failure path so the cooldown gate
 * applies to subsequent trigger-driven enqueues. If no row exists yet (first
 * attempt failed), seed `lastProcessedMessageId` to the empty string — a
 * sentinel meaning "nothing successfully processed yet" that subsequent
 * `getMessagesSince(...)` queries treat the same as a missing row. An
 * existing row's `rememberedLog` is left untouched.
 */
export function bumpRetrospectiveLastRunAt(
  conversationId: string,
  lastRunAt: number,
): void {
  const db = getDb();
  db.insert(memoryRetrospectiveState)
    .values({
      conversationId,
      lastProcessedMessageId: "",
      lastRunAt,
    })
    .onConflictDoUpdate({
      target: memoryRetrospectiveState.conversationId,
      set: { lastRunAt },
    })
    .run();
}
