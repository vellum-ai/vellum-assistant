/**
 * Atomic terminal cleanup for an in-flight assistant turn.
 *
 * A turn's "complete" state is split across two stores:
 *
 *   - `turn-store.phase` — the active turn's lifecycle (one per tab)
 *   - `conversation-store.processingConversationIds` — the sidebar's
 *     view of "which conversations are processing" (multi-conversation;
 *     includes background conversations from Slack, Telegram, etc.)
 *
 * Both must transition on every terminal event. Without this coordinator
 * each terminal site (SSE handlers, error handlers, polling rescue) had
 * to remember to call into both stores, and "forget the second call"
 * was the canonical bug: `canStopGeneration` and the sidebar dot would
 * stay lit after the assistant message rendered.
 *
 * `endTurn` makes the two-store transition a single call. New terminal
 * paths can't accidentally skip the conversation-store cleanup — there
 * is only one call to make.
 *
 * The five terminal reasons map 1:1 onto turn-store's terminal actions:
 *
 *   reason            | turn-store action       | extra args
 *   ------------------|-------------------------|------------------------
 *   "complete"        | completeTurn()          | —
 *   "cancelled"       | cancelGeneration()      | —
 *   "error"           | onStreamError()         | —
 *   "session_error"   | onSessionError()        | —
 *   "rescued"         | onPollReconciled(id)    | rescuedTurnId (required)
 */

import { useConversationStore } from "@/stores/conversation-store";
import { useTurnStore } from "@/stores/turn-store";

export type TurnTerminalReason =
  | "complete"
  | "cancelled"
  | "error"
  | "session_error"
  | "rescued";

export interface EndTurnArgs {
  /**
   * Conversation whose processing key should be cleared. Optional
   * because some terminal events (e.g. stream errors with no surviving
   * stream context) can't identify the conversation; the turn-store
   * still transitions, the processing-key clear is skipped.
   */
  conversationId: string | null | undefined;
  /** Why the turn ended — selects the matching turn-store action. */
  reason: TurnTerminalReason;
  /**
   * Required when `reason === "rescued"`. Scopes the polling-rescue
   * dispatch to a specific turn id so a rescue resolved during a
   * follow-up turn can't accidentally idle the new active turn.
   */
  rescuedTurnId?: string | null;
}

export function endTurn(args: EndTurnArgs): void {
  const turn = useTurnStore.getState();
  switch (args.reason) {
    case "complete":
      turn.completeTurn();
      break;
    case "cancelled":
      turn.cancelGeneration();
      break;
    case "error":
      turn.onStreamError();
      break;
    case "session_error":
      turn.onSessionError();
      break;
    case "rescued":
      turn.onPollReconciled(args.rescuedTurnId ?? undefined);
      break;
  }
  if (args.conversationId) {
    useConversationStore
      .getState()
      .removeProcessingConversationId(args.conversationId);
  }
}
