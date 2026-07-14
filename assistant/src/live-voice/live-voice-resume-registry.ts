/**
 * Per-conversation registry that lets an interactive surface completion resume
 * a live-voice conversation as a *spoken* turn instead of a silent text turn.
 *
 * The live-voice session (producer) registers a {@link VoiceResumeHandler} once
 * it adopts a stable conversation id, and the surface-action dispatcher
 * (consumer, in `daemon/conversation-surfaces.ts`) looks one up before falling
 * back to `processMessage`.
 *
 * This module deliberately imports nothing from `daemon/` or `calls/`: keeping
 * it a pure registry lets both the producer and the consumer depend on it
 * without forming a require cycle.
 */

/**
 * Per-turn overrides carried from an interactive-surface completion into the
 * resumed voice turn.
 *
 * `requestId` (when supplied) is the accepted surface-action request id. The
 * resumed turn adopts it as its own request id so `currentRequestId` lands in
 * the conversation's `surfaceActionRequestIds` set — otherwise a tool gated on
 * `ToolContext.triggeredBySurfaceAction` (e.g. archive-by-sender) would reject
 * the resumed turn even though the user clicked the surface.
 *
 * `displayContent` (when supplied) is the user-facing label the resumed turn
 * persists and echoes instead of the model-facing `content`, matching the text
 * path so the transcript shows the friendly label, not the raw
 * `[User action on …]` payload.
 *
 * `activeSurfaceId` (when supplied) is the completed surface's id. The resumed
 * turn adopts it as `conversation.currentActiveSurfaceId` so `runAgentLoop`
 * feeds it to `buildActiveSurfaceContext` and the model sees the active
 * `dynamic_page`/app HTML + schema it just acted on — parity with the text
 * path, which passes `activeSurfaceId` into `processMessage`.
 *
 * Voice trust is not carried here: a live-voice turn's trust is established
 * once on the conversation at session adoption, so a resumed turn inherits the
 * same trust context as any speech turn.
 */
export interface VoiceResumeOptions {
  displayContent?: string;
  requestId?: string;
  activeSurfaceId?: string;
}

export interface VoiceResumeHandler {
  /**
   * Run `content` as a spoken assistant turn on the live-voice session. The
   * turn is synthetic (no user speech): it is not echoed as a user utterance
   * and connection state is re-read at turn start.
   */
  resumeWithText(content: string, opts?: VoiceResumeOptions): void;
}

const handlers = new Map<string, VoiceResumeHandler>();

export function registerVoiceResumeHandler(
  conversationId: string,
  handler: VoiceResumeHandler,
): void {
  handlers.set(conversationId, handler);
}

/**
 * Remove the handler for a conversation, but only when the stored handler is
 * referentially the one passed. A newer session that adopted the same
 * conversation id must not have its handler dropped by an older session's
 * teardown (mirrors the identity-checked `pendingTurnTeardowns` guard in
 * `calls/voice-session-bridge.ts`).
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
