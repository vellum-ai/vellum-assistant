/**
 * Registry that lets the HTTP surface-action path (`daemon/conversation-surfaces.ts`)
 * hand a surface-completion follow-up back to the live-voice session that owns a
 * conversation, so the resumed reply is SPOKEN (runs through the session's TTS
 * pipeline) instead of being run silently through the text pipeline (JARVIS-1287).
 *
 * It is a pure module-level map with no imports from `daemon/` or `calls/`: the
 * producer (`live-voice-session.ts`) and the consumer (`conversation-surfaces.ts`)
 * both reference this module, and neither imports the other — avoiding a require
 * cycle between the live-voice session and the daemon surface handler.
 */
export interface VoiceResumeHandler {
  resumeWithText(
    content: string,
    opts?: { displayContent?: string; sourceActorPrincipalId?: string },
  ): void;
}

const handlers = new Map<string, VoiceResumeHandler>();

export function registerVoiceResumeHandler(
  conversationId: string,
  handler: VoiceResumeHandler,
): void {
  handlers.set(conversationId, handler);
}

/**
 * Identity-checked removal: a session only clears the slot if it still holds its
 * own handler. A newer session that adopted the same conversationId (e.g. after a
 * reconnect) is never evicted by a stale session's teardown.
 */
export function unregisterVoiceResumeHandler(
  conversationId: string,
  handler: VoiceResumeHandler,
): void {
  if (handlers.get(conversationId) === handler) {
    handlers.delete(conversationId);
  }
}

export function getVoiceResumeHandler(
  conversationId: string,
): VoiceResumeHandler | undefined {
  return handlers.get(conversationId);
}
