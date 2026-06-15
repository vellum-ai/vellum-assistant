/**
 * Render-decision selectors derived from TurnState + UI context.
 *
 * These pure functions replace the ad-hoc boolean conditions that were
 * previously scattered across the component tree.
 */

import { type TurnPhase, isSending } from "@/domains/chat/turn-store";

// ---------------------------------------------------------------------------
// UI context — values provided by the component that are NOT part of the
// turn state machine but are needed for render decisions.
// ---------------------------------------------------------------------------

export interface UIContext {
  hasStreamingAssistantMessage: boolean;
  /** True when the live assistant row renders something the user can see —
   * non-blank text, reasoning content (the inline `SingleActivity` owns the
   * loading state then), a tool-call chip (including a streaming preview
   * block), or a surface. This is the single handoff gate for the standalone
   * thinking-dots row: the dots stay up for the entire window where the
   * response area would otherwise be empty, and yield only once a visible
   * element has actually replaced them. A live assistant bubble with no
   * renderable content (e.g. created by an aux LLM call that produced no
   * visible output) must NOT count — that was the "blank transcript while
   * generating" bug. */
  hasVisibleResponseContent: boolean;
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
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/**
 * Whether the "Thinking..." indicator should be visible.
 *
 * Invariant: while a turn is in flight, the response area is never empty.
 * The dots show for the entire window where nothing visible has rendered
 * yet, and yield only to actual visible content
 * (`hasVisibleResponseContent`) — streamed text, the inline reasoning
 * `SingleActivity`, a tool-call chip (including a streaming preview block),
 * or a surface. Gating on visible content rather than on bubble existence
 * or phase choreography keeps the dots up across mid-turn hiccups — e.g.
 * an aux LLM call's `message_complete` arriving while the real generation
 * is still pending, which previously killed the dots and left the
 * transcript blank for the rest of the model's time-to-first-token.
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
    !ctx.hasVisibleResponseContent &&
    activeToolCallCount === 0
  );
}

/**
 * Whether the active assistant turn can be cancelled.
 *
 * Web-originated sends drive `TurnState` directly, but external-channel
 * conversations (Slack, Telegram, phone) can stream into an already-open web
 * tab without the web app ever calling `requestSend()`. In that case the live
 * transcript or conversation processing marker is the only local proof that
 * there is an active turn to stop.
 */
export function canStopGeneration(
  phase: TurnPhase,
  ctx: UIContext,
): boolean {
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
