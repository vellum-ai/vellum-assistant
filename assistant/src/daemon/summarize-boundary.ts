import type { MessageRow } from "../persistence/conversation-crud.js";
import { UserError } from "../util/errors.js";
import { startsNewTurn } from "./conversation.js";

/**
 * Resolves a client-addressed message id to a turn-snapped row boundary for
 * "summarize up to here". The boundary snaps back to the start of the turn
 * containing `beforeMessageId`, so the selected message's whole turn survives
 * verbatim and the kept tail always begins with a real user message (the
 * summary message is assistant-role, and history must alternate).
 *
 * Rows `[0, boundaryRowIndex)` are the summarize range in row-space.
 *
 * Throws {@link UserError} (messages are user-facing) when the id is unknown,
 * when there is nothing before the snapped turn to summarize, or when the
 * snapped boundary falls inside the already-compacted prefix
 * (`[0, contextCompactedMessageCount)`).
 */
export function resolveSummarizeBoundary(
  rows: MessageRow[],
  beforeMessageId: string,
  contextCompactedMessageCount: number,
): { boundaryRowIndex: number } {
  const targetIndex = rows.findIndex((row) => row.id === beforeMessageId);
  if (targetIndex === -1) {
    throw new UserError(
      `Message ${beforeMessageId} does not belong to this conversation`,
    );
  }

  let snappedIndex = targetIndex;
  while (
    snappedIndex >= 0 &&
    !startsNewTurn(rows[snappedIndex].role, rows[snappedIndex].content)
  ) {
    snappedIndex--;
  }

  if (snappedIndex <= 0) {
    throw new UserError("Nothing to summarize before this message");
  }
  if (snappedIndex <= contextCompactedMessageCount) {
    throw new UserError("Already summarized up to this point");
  }

  return { boundaryRowIndex: snappedIndex };
}
