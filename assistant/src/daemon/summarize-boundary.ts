import { isToolResultOnlyUserMessage } from "../conversations/message-consolidation.js";
import type { MessageRow } from "../persistence/conversation-crud.js";
import { UserError } from "../util/errors.js";

/**
 * Whether a persisted message row starts a new conversation turn. A turn is
 * delimited by a "real" user message; assistant rows never start one, and a
 * user row whose content is exclusively tool_result (plus optional
 * system_notice) blocks is a continuation within the current turn — the agent
 * loop injects system_notice text alongside tool_results, and the
 * display/write-path consolidation suppresses those rows as continuations.
 * The block classification is delegated to {@link isToolResultOnlyUserMessage}
 * so this predicate stays aligned with that suppression rule. Mirrors the
 * turn-boundary definition used by `getAssistantMessageIdsInTurn`/
 * `getTurnTimeBounds` and the agent loop's per-turn `turnCount++`, so counting
 * these reconstructs `turnCount` on load.
 */
export function startsNewTurn(msg: MessageRow): boolean {
  if (msg.role !== "user") return false;
  return !isToolResultOnlyUserMessage(msg);
}

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
  while (snappedIndex >= 0 && !startsNewTurn(rows[snappedIndex])) {
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
