/**
 * Apply a message-array update to wherever the row actually lives.
 *
 * A row the user acts on (a tool call awaiting confirmation, a surface awaiting
 * a click) can be in either source: the in-flight turn while its turn streams,
 * or the persisted history cache once the turn-idle handoff has pruned it.
 * A writer that targets only the live turn silently drops the change when the
 * row has already moved to history — the bug class two PR reviewers flagged on
 * the confirmation- and surface-action paths.
 *
 * `patchTranscriptMessages` applies the updater to BOTH the live turn and the
 * history cache. The updater must be a no-op (return its input array) for rows
 * it doesn't match — the confirmation/surface cleanups already are — so the
 * write touches only the source that holds the row.
 *
 * The history half needs the request-scoped `QueryClient` and the active
 * conversation's query key, which only a mounted hook has. `useConversationHistory`
 * registers that writer here (the same module-backed-by-a-hook pattern as
 * `turn-coordinator`'s `endTurn`); it is null when no conversation is active,
 * in which case only the live turn is patched.
 */

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import type { DisplayMessage } from "@/domains/chat/types/types";

export type MessagesUpdater = (messages: DisplayMessage[]) => DisplayMessage[];

let historyCachePatcher: ((updater: MessagesUpdater) => void) | null = null;

export function registerHistoryCachePatcher(
  fn: ((updater: MessagesUpdater) => void) | null,
): void {
  historyCachePatcher = fn;
}

export function patchTranscriptMessages(updater: MessagesUpdater): void {
  useChatSessionStore.getState().setLiveTurn(updater);
  historyCachePatcher?.(updater);
}
