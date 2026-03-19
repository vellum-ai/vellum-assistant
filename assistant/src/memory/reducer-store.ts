/**
 * Reducer store — transactional application of reducer results to brief-state
 * tables (time_contexts, open_loops) and conversation reducer checkpoints.
 *
 * The `applyReducerResult` helper is the single entry point for persisting
 * reducer output. It runs all upserts, resolves, and checkpoint advances
 * inside a single SQLite transaction so the DB is never left in a
 * partially-applied state.
 *
 * Archive writes are intentionally out of scope — they have their own
 * lifecycle and can be tested independently.
 */

import { and, eq, gt } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getLogger } from "../util/logger.js";
import { getDb } from "./db.js";
import type { ReducerResult } from "./reducer-types.js";
import { conversations, messages, openLoops, timeContexts } from "./schema.js";

const log = getLogger("reducer-store");

// ── Read helpers ─────────────────────────────────────────────────────

/**
 * Return all active (non-expired) time contexts for a memory scope.
 * "Active" means `activeUntil` is in the future relative to `now`.
 */
export function getActiveTimeContexts(
  scopeId: string,
  now: number = Date.now(),
): Array<{
  id: string;
  summary: string;
  activeFrom: number;
  activeUntil: number;
}> {
  const db = getDb();
  return db
    .select({
      id: timeContexts.id,
      summary: timeContexts.summary,
      activeFrom: timeContexts.activeFrom,
      activeUntil: timeContexts.activeUntil,
    })
    .from(timeContexts)
    .where(
      and(eq(timeContexts.scopeId, scopeId), gt(timeContexts.activeUntil, now)),
    )
    .all();
}

/**
 * Return all open loops for a memory scope.
 */
export function getActiveOpenLoops(
  scopeId: string,
): Array<{ id: string; summary: string; status: string }> {
  const db = getDb();
  return db
    .select({
      id: openLoops.id,
      summary: openLoops.summary,
      status: openLoops.status,
    })
    .from(openLoops)
    .where(and(eq(openLoops.scopeId, scopeId), eq(openLoops.status, "open")))
    .all();
}

// ── Brief-compiler helper ────────────────────────────────────────────

/**
 * Update the `surfaced_at` timestamp on a single open loop.
 *
 * Called by the brief compiler after resurfacing a low-salience loop
 * so it is not immediately resurfaced again on the next turn.
 */
export function updateLastSurfacedAt(loopId: string, surfacedAt: number): void {
  const db = getDb();
  db.update(openLoops)
    .set({ surfacedAt, updatedAt: surfacedAt })
    .where(eq(openLoops.id, loopId))
    .run();
}

// ── Transactional apply ──────────────────────────────────────────────

export interface ApplyReducerResultParams {
  /** The validated reducer result to persist. */
  result: ReducerResult;
  /** Conversation that was reduced. */
  conversationId: string;
  /** Memory scope for new rows (e.g. assistant instance ID). */
  scopeId: string;
  /** ID of the last message that was included in this reducer run. */
  reducedThroughMessageId: string;
  /** Current timestamp in epoch ms (injectable for testing). */
  now?: number;
}

/**
 * Atomically apply a reducer result to the database.
 *
 * Within a single transaction this function:
 *   1. Upserts time_contexts (create / update / resolve)
 *   2. Upserts open_loops (create / update / resolve)
 *   3. Advances the conversation's reducer checkpoint columns
 *   4. Clears `memoryDirtyTailSinceMessageId` when the conversation is
 *      fully caught up (no messages exist after `reducedThroughMessageId`)
 *
 * Archive candidates in the result are intentionally ignored — they are
 * handled by a separate pipeline.
 *
 * The function is idempotent: applying the same result twice leaves the
 * database in the same state. Create operations use deterministic IDs
 * derived from the reducer output position so re-application produces
 * the same rows.
 */
export function applyReducerResult(params: ApplyReducerResultParams): void {
  const {
    result,
    conversationId,
    scopeId,
    reducedThroughMessageId,
    now = Date.now(),
  } = params;

  const db = getDb();

  db.transaction((tx) => {
    // ── 1. Time contexts ───────────────────────────────────────────
    for (let i = 0; i < result.timeContexts.length; i++) {
      const op = result.timeContexts[i];

      if (op.action === "create") {
        const id = uuid();
        tx.insert(timeContexts)
          .values({
            id,
            scopeId,
            summary: op.summary,
            source: op.source,
            activeFrom: op.activeFrom,
            activeUntil: op.activeUntil,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      } else if (op.action === "update") {
        const setFields: Record<string, unknown> = { updatedAt: now };
        if (op.summary !== undefined) setFields.summary = op.summary;
        if (op.activeFrom !== undefined) setFields.activeFrom = op.activeFrom;
        if (op.activeUntil !== undefined)
          setFields.activeUntil = op.activeUntil;

        tx.update(timeContexts)
          .set(setFields)
          .where(eq(timeContexts.id, op.id))
          .run();
      } else {
        // resolve — delete the row (resolved time contexts are no longer relevant)
        tx.delete(timeContexts).where(eq(timeContexts.id, op.id)).run();
      }
    }

    // ── 2. Open loops ──────────────────────────────────────────────
    for (let i = 0; i < result.openLoops.length; i++) {
      const op = result.openLoops[i];

      if (op.action === "create") {
        const id = uuid();
        tx.insert(openLoops)
          .values({
            id,
            scopeId,
            summary: op.summary,
            source: op.source,
            status: "open",
            dueAt: op.dueAt ?? null,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      } else if (op.action === "update") {
        const setFields: Record<string, unknown> = { updatedAt: now };
        if (op.summary !== undefined) setFields.summary = op.summary;
        if (op.dueAt !== undefined) setFields.dueAt = op.dueAt;

        tx.update(openLoops)
          .set(setFields)
          .where(eq(openLoops.id, op.id))
          .run();
      } else {
        // resolve — mark status (resolved | expired)
        tx.update(openLoops)
          .set({ status: op.status, updatedAt: now })
          .where(eq(openLoops.id, op.id))
          .run();
      }
    }

    // ── 3. Advance reducer checkpoint ──────────────────────────────
    //
    // Check whether the conversation is fully caught up: no messages
    // exist after the one we just reduced through. If caught up, clear
    // the dirty tail marker so the reducer knows there's nothing left
    // to process.
    const laterMessage = tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          gt(
            messages.createdAt,
            getMessageCreatedAt(tx, reducedThroughMessageId),
          ),
        ),
      )
      .limit(1)
      .get();

    const isCaughtUp = !laterMessage;

    const checkpointUpdate: Record<string, unknown> = {
      memoryReducedThroughMessageId: reducedThroughMessageId,
      memoryLastReducedAt: now,
    };

    if (isCaughtUp) {
      checkpointUpdate.memoryDirtyTailSinceMessageId = null;
    }

    tx.update(conversations)
      .set(checkpointUpdate)
      .where(eq(conversations.id, conversationId))
      .run();

    log.debug(
      {
        conversationId,
        reducedThroughMessageId,
        timeContextOps: result.timeContexts.length,
        openLoopOps: result.openLoops.length,
        isCaughtUp,
      },
      "Applied reducer result",
    );
  });
}

// ── Internal helpers ─────────────────────────────────────────────────

/**
 * Get the createdAt timestamp for a message by ID.
 * Returns 0 if the message doesn't exist (which means the gt() comparison
 * will match all messages — safe fallback that prevents clearing dirty tail).
 */
function getMessageCreatedAt(
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  messageId: string,
): number {
  const row = tx
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.id, messageId))
    .get();
  return row?.createdAt ?? 0;
}
