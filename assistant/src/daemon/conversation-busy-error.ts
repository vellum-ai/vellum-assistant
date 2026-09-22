/**
 * The processing-lock rejection, and the predicate that recognizes it.
 *
 * A leaf on purpose. The modules that have to tell "this conversation was
 * already running a turn" apart from a real failure are ingress and admission
 * paths (channel dispatch and its retry sweep, the CLI signal, the voice
 * bridge, `conversation-admission`), and a marker string is the whole of what
 * they need. Keeping it here rather than beside its thrower means asking the
 * question does not pull the message-persistence graph, and its transitive
 * credential and image modules, into an importer's static graph.
 */

/**
 * Thrown by user-message persistence when the conversation's processing lock
 * is held. Callers match on this exact string: keep it byte-stable.
 */
export const CONVERSATION_BUSY_MESSAGE =
  "Conversation is already processing a message";

/**
 * True when `err` is the {@link CONVERSATION_BUSY_MESSAGE} processing-lock
 * rejection thrown by `persistUserMessage` (and by
 * `prepareConversationForMessage`) while a turn is already in flight. Channel
 * ingress uses this to route a lock-contended turn to the retry sweep as a
 * retryable failure instead of letting it dead-letter as a fatal error.
 */
export function isConversationBusyError(err: unknown): boolean {
  return err instanceof Error && err.message === CONVERSATION_BUSY_MESSAGE;
}
