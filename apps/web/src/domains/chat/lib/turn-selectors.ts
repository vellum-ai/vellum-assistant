/**
 * Render-decision selectors derived from TurnState + UI context.
 *
 * These pure functions replace the ad-hoc boolean conditions that were
 * previously scattered across the component tree.
 */

import { type TurnState, isSending, isThinking } from "@/domains/messaging/turn-store.js";

// ---------------------------------------------------------------------------
// UI context — values provided by the component that are NOT part of the
// turn state machine but are needed for render decisions.
// ---------------------------------------------------------------------------

export interface UIContext {
  hasStreamingAssistantMessage: boolean;
  hasPendingSecret: boolean;
  hasPendingConfirmation: boolean;
  hasUncompletedVisibleSurface: boolean;
  /** True when the active conversation is known to be processing even though
   * the local turn reducer was reset by a conversation switch. */
  activeConversationIsProcessing?: boolean;
  /** True when the latest non-queued user message has no following assistant
   * message yet. Used with `activeConversationIsProcessing` to restore the
   * thinking indicator after switching back to an in-flight conversation. */
  hasPendingAssistantResponse?: boolean;
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/**
 * Whether the "Thinking..." indicator should be visible.
 *
 * Mirrors macOS TranscriptProjector.wouldShowThinking:
 *   isSending && (isThinking || !lastVisible.isStreaming) && !hasActiveToolCall
 *
 * Show the dots whenever the turn is actively processing, no assistant
 * text is streaming yet, and no tool call is in-flight. The fallback
 * `!hasStreamingAssistantMessage` keeps the dots visible even after the
 * phase moves past "thinking" (e.g. after a tool call completes before
 * any text arrives).
 *
 * Excluded during `awaiting_user_input` — secret prompts, confirmation
 * prompts, and interactive surfaces render their own UI and should not
 * compete with a "Thinking…" indicator. On macOS the equivalent events
 * clear the `isThinking` boolean, achieving the same suppression.
 */
export function shouldShowThinkingIndicator(
  state: TurnState,
  ctx: UIContext,
): boolean {
  const restoredProcessing =
    ctx.activeConversationIsProcessing === true &&
    ctx.hasPendingAssistantResponse === true;

  return (
    (isSending(state) || restoredProcessing) &&
    state.phase !== "awaiting_user_input" &&
    !ctx.hasPendingSecret &&
    !ctx.hasPendingConfirmation &&
    !ctx.hasUncompletedVisibleSurface &&
    (isThinking(state) || restoredProcessing || !ctx.hasStreamingAssistantMessage) &&
    state.activeToolCallCount === 0
  );
}

/**
 * Whether an assistant text bubble should be shown for a given message.
 *
 * Mirrors macOS render precedence: hide assistant text bubbles when active
 * inline surfaces are present, UNLESS all visible surfaces have completed.
 * This prevents the assistant's text response from competing with an
 * interactive surface for the user's attention.
 *
 * When no active inline surfaces exist (or all are completed), the bubble
 * is always visible.
 */
export function shouldShowAssistantBubble(
  _state: TurnState,
  ctx: UIContext,
): boolean {
  // If there are uncompleted visible surfaces, suppress the assistant
  // text bubble so the surface has the user's full attention.
  if (ctx.hasUncompletedVisibleSurface) {
    return false;
  }
  return true;
}

/**
 * Label to display alongside the thinking indicator (e.g. "Processing
 * bash results", "Compacting context"). Returns `null` when no label
 * should be shown — callers should fall back to a default like
 * "Thinking" at the render layer.
 *
 * Mirrors macOS `effectiveStatusText`, which is projected from the
 * daemon's `assistant_activity_state.statusText` field.
 */
export function getThinkingStatusText(state: TurnState): string | null {
  return state.statusText;
}

/**
 * Sending is blocked only by prompts with a dedicated cancel UI (secret,
 * confirmation). Visible surfaces don't block — sending implicitly dismisses
 * them in `AssistantPageClient.sendMessage`.
 */
export function isSendDisabled(
  _state: TurnState,
  ctx: UIContext,
): boolean {
  return ctx.hasPendingSecret || ctx.hasPendingConfirmation;
}
