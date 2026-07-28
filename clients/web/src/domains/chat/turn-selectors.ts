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
  /** Legacy (pre-0.8.8) conversation-processing signal — the conversation-row
   * `isProcessing` flag OR'd with the client optimistic mirror. Consulted ONLY
   * when `snapshotProcessing` is `undefined` (older daemons / cold snapshot),
   * where there is no server-folded flag; on 0.8.8+ the seq-folded
   * `snapshotProcessing` is authoritative and this is ignored. */
  activeConversationIsProcessing?: boolean;
  /** The daemon's authoritative per-conversation `processing` flag, seq-folded
   * onto the rolling snapshot (`rolling-snapshot.ts:nextProcessingState`) from
   * the live stream and reseeded by every `/messages` page. It owns the turn
   * CLOSE: `false` settles the turn — but only when the snapshot is
   * authoritative (see {@link isActiveTurnLive} and `streamAheadOfServer`).
   * `true` means the server considers a turn live. `undefined` (older daemons /
   * cold snapshot) means "no server signal", so liveness falls back to `phase`. */
  snapshotProcessing?: boolean;
  /** True when the live SSE stream has advanced this conversation past the
   * durable `/messages` snapshot (`L > S`; see
   * `server-seq.isStreamAheadOfServerSnapshot`). While true the snapshot — and
   * its `snapshotProcessing` flag — predates events the stream already applied,
   * so a stale `snapshotProcessing: false` must NOT close a genuinely live turn.
   * This is the seq arbiter that also covers the just-sent window (sending
   * advances the local frontier past the server's). */
  streamAheadOfServer?: boolean;
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/**
 * Whether an assistant turn is live on the active conversation — the single
 * liveness source both the avatar/stop selector and the thinking indicator
 * derive from.
 *
 * Ownership is a handoff between the client and the server, and that handoff
 * is what retired the old three-signal reconciliation (a client `phase`, the
 * conversation-row `isProcessing`, and a snapshot close-gate that could
 * disagree):
 *
 *   - The optimistic client `phase` owns the OPEN. The spinner shows the
 *     instant you send — before the server has round-tripped a single event —
 *     because `isSending(phase)` flips on the local send.
 *   - The server's seq-folded `snapshotProcessing` owns the CLOSE. A
 *     `processing: false` settles the turn even if `phase` is stuck (a terminal
 *     SSE event dropped on a disconnect) — BUT only when the snapshot is
 *     authoritative, i.e. the live stream has NOT advanced past the durable
 *     `/messages` snapshot (`!streamAheadOfServer`). While the stream is ahead,
 *     the snapshot predates the live turn, so its `false` is stale and the
 *     optimistic `phase` keeps leading. `streamAheadOfServer` is the seq arbiter
 *     (`L > S`) and also covers the just-sent window — sending advances the
 *     local frontier past the server's on its own.
 *
 * `snapshotProcessing === undefined` (pre-0.8.8 / cold snapshot) carries no
 * server signal, so liveness is `phase` alone.
 */
export function isActiveTurnLive(
  phase: TurnPhase,
  ctx: Pick<
    UIContext,
    "snapshotProcessing" | "streamAheadOfServer" | "activeConversationIsProcessing"
  >,
): boolean {
  if (ctx.snapshotProcessing === undefined) {
    // Pre-0.8.8 / cold snapshot: no server-folded flag, so fall back to the
    // legacy union of the optimistic client `phase` and the conversation-row
    // processing signal (the only local proof of an external-channel turn).
    return isSending(phase) || ctx.activeConversationIsProcessing === true;
  }
  if (ctx.snapshotProcessing === true) {
    return true;
  }
  if (!ctx.streamAheadOfServer) {
    // Server-authoritative close: the snapshot says idle and has caught up to
    // everything the stream applied. The turn is over regardless of `phase`.
    return false;
  }
  // `false` while the stream is ahead of the snapshot (stale close): the
  // optimistic client `phase` is the only fresh signal, so it leads.
  return isSending(phase);
}

/**
 * Whether the "Thinking..." indicator should be visible.
 *
 * Mirrors macOS TranscriptProjector.wouldShowThinking:
 *   isSending && (isThinking || !hasStreamingAssistantMessage) && !hasActiveToolCall
 *
 * Show the indicator whenever a turn is live ({@link isActiveTurnLive}), no
 * assistant text is streaming yet, and no tool call is in-flight. The fallback
 * `!hasStreamingAssistantMessage` keeps it visible even after the phase
 * moves past "thinking" (e.g. after a tool call completes before any text
 * arrives).
 *
 * Unlike macOS, this standalone row hands off to the inline
 * {@link SingleActivity} as soon as the live assistant message carries
 * reasoning content (`hasStreamingAssistantThinking`) — that link renders the
 * same shimmering "Thinking" loading state inline and is clickable to open the
 * streaming reasoning. So the standalone row is scoped to the pre-reasoning
 * window (no assistant bubble yet, or a bubble that hasn't emitted reasoning)
 * to avoid two competing thinking indicators.
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
  return (
    isActiveTurnLive(phase, ctx) &&
    !ctx.hasPendingSecret &&
    !ctx.hasPendingConfirmation &&
    !ctx.hasPendingQuestion &&
    !ctx.hasPendingContactRequest &&
    !ctx.hasUncompletedVisibleSurface &&
    (isThinking(phase) || !ctx.hasStreamingAssistantMessage) &&
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
 * should be shown. Otherwise busy tracks {@link isActiveTurnLive} directly, so
 * the same seq-arbitrated close that settles the thinking dots settles the
 * spinner and stop button — no independent close condition to drift.
 *
 * External-channel conversations (Slack, Telegram, phone) can stream into an
 * already-open web tab without the web app ever calling `requestSend()`. That
 * case is covered because the server's `snapshotProcessing` (folded from the
 * incoming stream) marks the turn live even though the local `phase` never left
 * idle — {@link isActiveTurnLive} returns true on `snapshotProcessing === true`.
 */
export function isAssistantBusy(
  phase: TurnPhase,
  ctx: UIContext,
): boolean {
  // Only an actually-pending prompt or interactive surface suppresses busy —
  // the `phase` can lag at `awaiting_user_input` after a prompt resolves while
  // the turn keeps streaming, so it must not gate this on its own.
  if (
    ctx.hasPendingSecret ||
    ctx.hasPendingConfirmation ||
    ctx.hasPendingQuestion ||
    ctx.hasPendingContactRequest ||
    ctx.hasUncompletedVisibleSurface
  ) {
    return false;
  }

  return isActiveTurnLive(phase, ctx);
}

/**
 * Sending is blocked only by prompts with a dedicated cancel UI (secret,
 * confirmation). Visible surfaces don't block — sending implicitly dismisses
 * them in `useSendMessage`.
 */
export function isSendDisabled(ctx: UIContext): boolean {
  return ctx.hasPendingSecret || ctx.hasPendingConfirmation;
}
