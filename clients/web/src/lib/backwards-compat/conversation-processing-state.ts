/**
 * Backwards-compat gate: source of truth for the active conversation's
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
import { useActiveConversation } from "@/domains/chat/hooks/use-active-conversation";
import { useAssistantSupports } from "@/lib/backwards-compat/utils";
import { useConversationStore } from "@/stores/conversation-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

const MIN_VERSION = "0.8.8";

/**
 * Resolve whether the active conversation is processing.
 *
 * - `>= 0.8.8`: trust the server flag alone.
 * - `< 0.8.8` (or version not yet hydrated): OR the server flag with the
 *   client optimistic mirror, preserving the legacy belt-and-suspenders
 *   behavior for daemons that may not surface `isProcessing` on the wire.
 */
export function useActiveConversationIsProcessing(): boolean {
  const serverOwnsProcessingState = useAssistantSupports(MIN_VERSION);

  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const activeConversationId = useConversationStore.use.activeConversationId();
  const processingConversationIds =
    useConversationStore.use.processingConversationIds();

  // Cache-only read (`enabled: false`): the chat view owns the fetch via
  // its own `useActiveConversation` call; here we only subscribe to the
  // row the SSE turn lifecycle keeps fresh.
  const serverIsProcessing = useActiveConversation(
    assistantId,
    activeConversationId,
    false,
  )?.isProcessing;

  if (serverOwnsProcessingState) {
    return serverIsProcessing === true;
  }

  const isMarkedProcessingLocally =
    activeConversationId != null &&
    processingConversationIds.has(activeConversationId);
  return isMarkedProcessingLocally || serverIsProcessing === true;
}
