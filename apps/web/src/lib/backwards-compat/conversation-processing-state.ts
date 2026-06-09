/**
 * Backwards-compat gate: source of truth for a conversation's
 * "assistant is responding" (processing) state.
 *
 * Vellum Assistant 0.8.8 makes the daemon's `Conversation.isProcessing()`
 * flag the single source of truth on the wire: it ships on every
 * conversation row as `isProcessing`, and the web app keeps that cached
 * value fresh from the SSE turn lifecycle — patched `true` on
 * `assistant_turn_start` / the first `assistant_text_delta` and `false`
 * on the terminal complete / cancelled / error events (see
 * `domains/chat/utils/stream-handlers/message-handlers.ts`).
 * Reconnect/resume catch-up refetches the row, so a dropped terminal
 * event self-heals instead of latching the indicator on.
 *
 * Assistants on 0.8.7 or older may omit `isProcessing` on the wire, so
 * the web app also maintains a client-side optimistic mirror
 * (`processingConversationIds` in `conversation-store`) marked from the
 * same SSE turn events. That mirror has to be hand-cleared on every
 * terminal path; a single missed clear latches the loading spinner on
 * forever — the exact bug class this gate retires for 0.8.8+.
 *
 * Once 0.8.8 is the minimum supported assistant version, delete this
 * module along with `processingConversationIds` and its writers/clearers,
 * and read `conversation.isProcessing` directly.
 */
import { useAssistantSupports } from "@/lib/backwards-compat/utils";

const MIN_VERSION = "0.8.8";

export interface ConversationProcessingInputs {
  /** Server-seeded `Conversation.isProcessing()` from the cached row. */
  serverIsProcessing: boolean | undefined;
  /**
   * Whether the client-side optimistic mirror currently marks this
   * conversation as processing. Only consulted for assistants older than
   * {@link MIN_VERSION}.
   */
  isMarkedProcessingLocally: boolean;
}

/**
 * Resolve whether the active conversation is processing.
 *
 * - `>= 0.8.8`: trust the server flag alone.
 * - `< 0.8.8` (or version not yet hydrated): OR the server flag with the
 *   client optimistic mirror, preserving the legacy belt-and-suspenders
 *   behavior for daemons that may not surface `isProcessing` on the wire.
 */
export function useConversationIsProcessing({
  serverIsProcessing,
  isMarkedProcessingLocally,
}: ConversationProcessingInputs): boolean {
  const serverOwnsProcessingState = useAssistantSupports(MIN_VERSION);
  if (serverOwnsProcessingState) {
    return serverIsProcessing === true;
  }
  return isMarkedProcessingLocally || serverIsProcessing === true;
}
