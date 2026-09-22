// ---------------------------------------------------------------------------
// Memory retrospective: cursor timestamp backfill.
// ---------------------------------------------------------------------------
//
// State rows written before `last_processed_created_at` existed carry an
// id-only cursor, which stops bounding reads the moment its row is deleted
// (see `memory-retrospective-state.ts`). This pass copies `createdAt` from
// each such row's message while the message still exists. Rows whose message
// is already gone stay NULL: nothing remains to recover, and they are counted
// so the stall is visible in the log. Runs detached at daemon init (ahead of
// any client regenerating a reply) and again at memory-worker startup;
// idempotent, keyset-paginated by conversation id, and yielding between pages.

import { and, asc, eq, gt, isNull, ne } from "drizzle-orm";

import { messageCreatedAtByIds } from "../../../persistence/message-reads.js";
import { memoryRetrospectiveState } from "../../../persistence/schema/index.js";
import { withSqliteRetry } from "./host-utils.js";
import { getLogger } from "./logging.js";
import { memoryDbOrNull } from "./memory-db.js";
import { ensureRetrospectiveCursorColumn } from "./memory-retrospective-state.js";

const log = getLogger("memory-retrospective-cursor-backfill");

const DEFAULT_PAGE_SIZE = 500;

export interface CursorBackfillResult {
  /** Rows with a cursor id but no timestamp. */
  scanned: number;
  /** Rows whose message still exists and received its `createdAt`. */
  backfilled: number;
  /** Rows whose cursor message no longer exists; left NULL. */
  unrecoverable: number;
}

/**
 * Fill `last_processed_created_at` on every state row that has a cursor id
 * but no timestamp. Best-effort: a missing memory connection or column is a
 * no-op, and a row the job rewrites mid-pass is skipped by the update's
 * `IS NULL` guard rather than stomped. Pages by conversation id so a large
 * backlog never materializes at once or holds the event loop.
 */
export async function backfillRetrospectiveCursorTimestamps(opts?: {
  pageSize?: number;
}): Promise<CursorBackfillResult> {
  const pageSize = opts?.pageSize ?? DEFAULT_PAGE_SIZE;
  const result: CursorBackfillResult = {
    scanned: 0,
    backfilled: 0,
    unrecoverable: 0,
  };
  const context = "backfillRetrospectiveCursorTimestamps";
  const mdb = memoryDbOrNull(context);
  if (!mdb || !ensureRetrospectiveCursorColumn(context)) {
    return result;
  }

  let afterConversationId = "";
  for (;;) {
    const page = mdb
      .select({
        conversationId: memoryRetrospectiveState.conversationId,
        messageId: memoryRetrospectiveState.lastProcessedMessageId,
      })
      .from(memoryRetrospectiveState)
      .where(
        and(
          isNull(memoryRetrospectiveState.lastProcessedCreatedAt),
          ne(memoryRetrospectiveState.lastProcessedMessageId, ""),
          gt(memoryRetrospectiveState.conversationId, afterConversationId),
        ),
      )
      .orderBy(asc(memoryRetrospectiveState.conversationId))
      .limit(pageSize)
      .all();
    if (page.length === 0) {
      break;
    }
    afterConversationId = page[page.length - 1]!.conversationId;
    result.scanned += page.length;

    const createdAtById = messageCreatedAtByIds(
      page.map((row) => row.messageId),
    );
    const recoverable = page.flatMap((row) => {
      const createdAt = createdAtById.get(row.messageId);
      return createdAt === undefined ? [] : [{ ...row, createdAt }];
    });
    result.unrecoverable += page.length - recoverable.length;

    if (recoverable.length > 0) {
      await withSqliteRetry(
        () => {
          mdb.transaction((tx) => {
            for (const row of recoverable) {
              tx.update(memoryRetrospectiveState)
                .set({ lastProcessedCreatedAt: row.createdAt })
                .where(
                  and(
                    eq(
                      memoryRetrospectiveState.conversationId,
                      row.conversationId,
                    ),
                    eq(
                      memoryRetrospectiveState.lastProcessedMessageId,
                      row.messageId,
                    ),
                    isNull(memoryRetrospectiveState.lastProcessedCreatedAt),
                  ),
                )
                .run();
            }
          });
        },
        { op: context, context: { afterConversationId } },
      );
      result.backfilled += recoverable.length;
    }
    await Bun.sleep(0);
  }

  if (result.backfilled > 0 || result.unrecoverable > 0) {
    log.info(result, "Retrospective cursor timestamps backfilled");
  }
  return result;
}
