/**
 * Per-process index of in-flight agent-loop turns, keyed by conversation id,
 * exposing each turn's flushed-content seq watermark.
 *
 * A turn registers here for the span it streams content into a conversation
 * (see `conversation-agent-loop`), so a daemon-side caller that only knows a
 * conversation id can tell whether a turn is streaming and, if so, how far its
 * content has been flushed to durable rows. The worker → daemon persist
 * hand-off (`ipc/routes/conversation-sync-ipc-routes`) reads it to cap the
 * snapshot anchor it records: the daemon's live seq counter runs ahead of the
 * content it has flushed, so anchoring at the counter while a turn streams
 * would advertise in-flight content the durable rows do not yet hold.
 *
 * Leaf module: imports `EventHandlerState` as a type only, so it can be read
 * from any layer without pulling in the agent-loop value graph.
 */

import type { EventHandlerState } from "./conversation-agent-loop-handlers.js";

const inflightTurns = new Map<string, EventHandlerState>();

/** Register a turn's live state for the span it streams into `conversationId`. */
export function registerInflightTurn(
  conversationId: string,
  state: EventHandlerState,
): void {
  inflightTurns.set(conversationId, state);
}

/**
 * Remove a turn's registration. Guards against clobbering a newer turn for the
 * same conversation by only deleting when the stored entry is still this state.
 */
export function unregisterInflightTurn(
  conversationId: string,
  state: EventHandlerState,
): void {
  if (inflightTurns.get(conversationId) === state) {
    inflightTurns.delete(conversationId);
  }
}

/**
 * The flushed-content seq ceiling for a conversation the daemon may be
 * streaming, or `undefined` when no turn is in flight for it.
 *
 * While a turn streams, the value is the highest seq whose content has been
 * flushed to durable rows (`EventHandlerState.lastPersistedContentSeq`), or `0`
 * when the turn has flushed no content yet. A caller recording a snapshot
 * anchor caps at this value so the anchor never claims content the live seq
 * counter has served but no flush has written; the `0` case is a monotonic
 * no-op in `recordConversationPersistedSeq`, leaving the existing anchor intact.
 */
export function getInflightFlushedContentSeq(
  conversationId: string,
): number | undefined {
  const state = inflightTurns.get(conversationId);
  if (state === undefined) {
    return undefined;
  }
  return state.lastPersistedContentSeq ?? 0;
}
