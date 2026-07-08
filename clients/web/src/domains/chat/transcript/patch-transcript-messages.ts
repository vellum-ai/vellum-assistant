/**
 * Apply a per-row message-array update to both transcript sources.
 *
 * Imperative cleanups the user triggers (clearing a pending confirmation,
 * dismissing a superseded surface) must reach the target row wherever it lives.
 * The materialized snapshot is what the transcript renders, but it is reseeded
 * from the history cache on every committed fetch — so a clear written only to
 * the snapshot would reappear the moment a refetch reseeds it from a stale
 * cache page.
 *
 * `patchTranscriptMessages` applies the updater to BOTH the materialized
 * snapshot and the history cache. The updater must be a no-op (return its input
 * array) for rows it doesn't match — the confirmation/surface cleanups already
 * are — so the write touches only the rows that hold the target.
 *
 * The history half needs the request-scoped `QueryClient` and the active
 * conversation's query key, which only a mounted hook has. `useConversationHistory`
 * registers that writer here (the same module-backed-by-a-hook pattern as
 * `turn-coordinator`'s `endTurn`); it is null when no conversation is active,
 * in which case only the snapshot is patched.
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
  useChatSessionStore.getState().patchSnapshotMessages(updater);
  historyCachePatcher?.(updater);
}
