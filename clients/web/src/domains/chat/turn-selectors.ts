/**
 * Render-decision selectors derived from TurnState + UI context.
 *
 * These pure functions replace the ad-hoc boolean conditions that were
 * previously scattered across the component tree.
 */

import { type TurnPhase, isSending, isThinking } from "@/domains/chat/turn-store";

// ---------------------------------------------------------------------------
// UI context — values provided by the component that are NOT part of the
// turn state machine but are needed for render decisions.
// ---------------------------------------------------------------------------

export interface UIContext {
  hasStreamingAssistantMessage: boolean;
  /** True when the live assistant message already carries reasoning/thinking
   * content — i.e. an inline `SingleActivity` is showing it (and owning the
   * streaming "Thinking" state). Gates off the standalone thinking-dots row so
   * the two don't both render; the dots stay only for the pre-message window. */
  hasStreamingAssistantThinking: boolean;
  hasPendingSecret: boolean;
  hasPendingConfirmation: boolean;
  hasPendingQuestion: boolean;
  hasPendingContactRequest: boolean;
  hasUncompletedVisibleSurface: boolean;
  /** True when the active conversation is known to be processing even though
   * the local turn reducer was reset by a conversation switch. */
  activeConversationIsProcessing?: boolean;
  /** True when the latest non-queued user message has no following assistant
   * message yet. Used with `activeConversationIsProcessing` to restore the
   * thinking indicator after switching back to an in-flight conversation. */
  hasPendingAssistantResponse?: boolean;
  /** The daemon's authoritative per-conversation `processing` flag, carried on
   * the rolling snapshot (`PaginatedHistoryResult.processing`) and refreshed by
   * every `/messages` reseed. Consumed as an authoritative CLOSE-gate: `false`
   * means the server considers the turn over, so a `phase` left stuck by a
   * dropped terminal SSE event stops driving the indicator. `undefined` (older
   * daemons, or a cold snapshot) leaves phase-only behavior untouched. */
  snapshotProcessing?: boolean;
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/**
 * Whether the "Thinking..." indicator should be visible.
 *
 * Mirrors macOS TranscriptProjector.wouldShowThinking:
 *   isSending && (isThinking || !hasStreamingAssistantMessage) && !hasActiveToolCall
 *
 * Show the dots whenever the turn is actively processing, no assistant
 * text is streaming yet, and no tool call is in-flight. The fallback
 * `!hasStreamingAssistantMessage` keeps the dots visible even after the
 * phase moves past "thinking" (e.g. after a tool call completes before
 * any text arrives).
 *
 * Unlike macOS, this standalone row hands off to the inline
 * {@link SingleActivity} as soon as the live assistant message carries
 * reasoning content (`hasStreamingAssistantThinking`) — that link renders the
 * same three-dot "Thinking" loading state inline and is clickable to open the
 * streaming reasoning. So the dots row is scoped to the pre-reasoning window
 * (no assistant bubble yet, or a bubble that hasn't emitted reasoning) to avoid
 * two competing thinking indicators.
 *
 * Each potentially-competing UI surface has its own explicit gate:
 * pending secret/confirmation/question/contact prompts, and any
 * still-interactive transcript surface. When a user resolves one of
 * those prompts via the composer (e.g. typing "yes please" instead of
 * clicking a Confirmation card button), the corresponding gate goes
 * false and the dots reappear during the in-flight gap — even if the
 * turn reducer hasn't yet transitioned `phase` out of
 * `awaiting_user_input`. This keeps the user informed that their reply
 * is being processed.
 */
export function shouldShowThinkingIndicator(
  phase: TurnPhase,
  activeToolCallCount: number,
  ctx: UIContext,
): boolean {
  // Authoritative close: when the daemon reports this conversation idle
  // (`snapshotProcessing === false`, 0.8.8+) the turn is over — even if the
  // local `phase` never saw the terminal SSE event (dropped while the stream
  // was disconnected). Guarded by `hasPendingAssistantResponse` so the window
  // right after a send — before the first token, where the snapshot still
  // legitimately reads the prior idle — keeps showing the dots. `undefined`
  // (older daemons / cold snapshot) leaves the phase-driven behavior untouched.
  if (ctx.snapshotProcessing === false && !ctx.hasPendingAssistantResponse) {
    return false;
  }

  const restoredProcessing =
    ctx.activeConversationIsProcessing === true &&
    ctx.hasPendingAssistantResponse === true;

  return (
    (isSending(phase) || restoredProcessing) &&
    !ctx.hasPendingSecret &&
    !ctx.hasPendingConfirmation &&
    !ctx.hasPendingQuestion &&
    !ctx.hasPendingContactRequest &&
    !ctx.hasUncompletedVisibleSurface &&
    (isThinking(phase) || restoredProcessing || !ctx.hasStreamingAssistantMessage) &&
    // Inline SingleActivity owns the loading state once reasoning is present.
    !ctx.hasStreamingAssistantThinking &&
    activeToolCallCount === 0
  );
}

/**
 * Whether the assistant is actively working (not waiting for user input).
 *
 * Single source of truth for the avatar loading spinner and the stop button.
 * When the assistant is waiting for the user to resolve a prompt (secret,
 * confirmation, question, contact request) or an interactive surface, it is
 * not busy — the prompt IS the UI, and neither a spinner nor a stop button
 * should be shown.
 *
 * External-channel conversations (Slack, Telegram, phone) can stream into an
 * already-open web tab without the web app ever calling `requestSend()`. In
 * that case the live transcript or conversation processing marker is the only
 * local proof that there is an active turn.
 *
 * Authoritative close-gate: `snapshotProcessing === false` means the daemon
 * says the turn is done, even if `phase` is stuck. The
 * `hasPendingAssistantResponse` guard keeps the window right after a send
 * (before the first token) covered.
 */
export function isAssistantBusy(
  phase: TurnPhase,
  ctx: UIContext,
): boolean {
  if (ctx.snapshotProcessing === false && !ctx.hasPendingAssistantResponse) {
    return false;
  }

  if (
    phase === "awaiting_user_input" ||
    ctx.hasPendingSecret ||
    ctx.hasPendingConfirmation ||
    ctx.hasPendingQuestion ||
    ctx.hasPendingContactRequest ||
    ctx.hasUncompletedVisibleSurface
  ) {
    return false;
  }

  return (
    isSending(phase) ||
    ctx.hasStreamingAssistantMessage ||
    ctx.activeConversationIsProcessing === true
  );
}

/**
 * Sending is blocked only by prompts with a dedicated cancel UI (secret,
 * confirmation). Visible surfaces don't block — sending implicitly dismisses
 * them in `useSendMessage`.
 */
export function isSendDisabled(ctx: UIContext): boolean {
  return ctx.hasPendingSecret || ctx.hasPendingConfirmation;
}
