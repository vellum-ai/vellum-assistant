// ---------------------------------------------------------------------------
// Memory retrospective: keep the cursor's timestamp when its row is deleted.
// ---------------------------------------------------------------------------
//
// The cursor normally sits on the latest assistant reply, and the retry route
// deletes exactly that row when the user regenerates it. A cursor written
// before the timestamp column existed carries only the id, so once the row is
// gone nothing can place it. The `message-deleted` hook delivers each deleted
// row's `(createdAt, id)` here: when the conversation's cursor is among the
// rows and has no timestamp yet, the row's `createdAt` is recorded. The
// timestamps travel in the call, so the write does not need the rows to
// still exist.

import { and, eq, isNull } from "drizzle-orm";

import { memoryRetrospectiveState } from "../../../persistence/schema/index.js";
import { withSqliteRetry } from "./host-utils.js";
import { getLogger } from "./logging.js";
import { memoryDbOrNull } from "./memory-db.js";
import { ensureRetrospectiveCursorColumn } from "./memory-retrospective-state.js";

const log = getLogger("memory-retrospective-cursor-preserve");

/**
 * Record `createdAt` on the conversation's retrospective cursor when it points
 * at one of `rows` and has no timestamp yet. Best-effort: an unavailable
 * memory connection or column is a no-op, and a cursor the job has moved
 * since the caller read it is skipped by the `IS NULL` guard.
 */
export async function preserveRetrospectiveCursorTimestamps(
  conversationId: string,
  rows: ReadonlyArray<{ id: string; createdAt: number }>,
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  const context = "preserveRetrospectiveCursorTimestamps";
  try {
    const mdb = memoryDbOrNull(context);
    if (!mdb || !ensureRetrospectiveCursorColumn(context)) {
      return;
    }
    const state = mdb
      .select({
        messageId: memoryRetrospectiveState.lastProcessedMessageId,
        createdAt: memoryRetrospectiveState.lastProcessedCreatedAt,
      })
      .from(memoryRetrospectiveState)
      .where(eq(memoryRetrospectiveState.conversationId, conversationId))
      .get();
    if (!state || state.createdAt !== null) {
      return;
    }
    const row = rows.find((candidate) => candidate.id === state.messageId);
    if (!row) {
      return;
    }
    await withSqliteRetry(
      () =>
        mdb
          .update(memoryRetrospectiveState)
          .set({ lastProcessedCreatedAt: row.createdAt })
          .where(
            and(
              eq(memoryRetrospectiveState.conversationId, conversationId),
              eq(memoryRetrospectiveState.lastProcessedMessageId, row.id),
              isNull(memoryRetrospectiveState.lastProcessedCreatedAt),
            ),
          )
          .run(),
      { op: context, context: { conversationId } },
    );
  } catch (err) {
    log.warn(
      { err, conversationId },
      "could not preserve the retrospective cursor timestamp before its row was deleted",
    );
  }
}
