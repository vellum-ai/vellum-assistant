// ---------------------------------------------------------------------------
// Memory retrospective: the cursor a state row hands to the messages-after
// reads.
// ---------------------------------------------------------------------------

import type { MessageCursor } from "../../../persistence/message-cursor.js";

/**
 * The `(createdAt, id)` cursor a retrospective state row carries, or null
 * when nothing has been processed yet (no row, or the `""` sentinel left by
 * failure-only attempts). The timestamp lets the reads keep their bound after
 * the cursor's row is deleted, which is what a regenerated reply does to the
 * latest assistant message the cursor usually sits on.
 */
export function retrospectiveCursor(
  state: {
    lastProcessedMessageId: string;
    lastProcessedCreatedAt?: number | null;
  } | null,
): MessageCursor | null {
  if (!state || state.lastProcessedMessageId === "") {
    return null;
  }
  return {
    id: state.lastProcessedMessageId,
    createdAt: state.lastProcessedCreatedAt ?? null,
  };
}
