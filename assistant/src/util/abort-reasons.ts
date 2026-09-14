/**
 * Tagged AbortReason objects passed as the `reason` argument to
 * `AbortController.abort()` for daemon-owned conversation aborts.
 *
 * The reason flows through the AbortSignal into provider SDKs (Anthropic,
 * OpenAI, etc.). When a provider wraps the abort error, the wrapped
 * `ProviderError` carries the original reason via `ProviderError.abortReason`,
 * letting `isUserCancellation` distinguish a user-initiated abort from a
 * genuine provider failure even after wrapping erases the `AbortError` name.
 */

export type AbortReasonKind =
  /** User explicitly hit Stop / Esc on the active conversation. */
  | "user_cancel"
  /** A new user message arrived for the same conversation, preempting the in-flight turn. */
  | "preempted_by_new_message"
  /** The conversation was disposed (eviction, shutdown) while still processing. */
  | "conversation_disposed"
  /** A subagent's owning conversation was aborted (parent abort, dispose, or explicit subagent abort). */
  | "subagent_aborted"
  /** A signal-file cancel was written by an out-of-process caller (CLI, hook). */
  | "signal_cancel"
  /** Voice session bridge aborted the conversation (turn supersession, call end). */
  | "voice_session_aborted";

const ABORT_REASON_TAG = "__vellumAbortReason" as const;

export interface AbortReason {
  readonly [ABORT_REASON_TAG]: true;
  readonly kind: AbortReasonKind;
  /** Short identifier of the call site for logging (e.g. "cancelGeneration"). */
  readonly source: string;
  readonly conversationId?: string;
}

export function createAbortReason(
  kind: AbortReasonKind,
  source: string,
  conversationId?: string,
): AbortReason {
  return {
    [ABORT_REASON_TAG]: true,
    kind,
    source,
    ...(conversationId ? { conversationId } : {}),
  };
}

/**
 * True when the abort came from a person stopping the turn they are watching
 * (the Stop button, Esc, or the CLI's cancel signal file) rather than from the
 * conversation going away or another subsystem seizing it.
 *
 * The distinction matters for the message queue. A user interrupt ends the
 * turn in flight; it says nothing about the messages the same user queued
 * behind it, so those survive the abort and run on the interrupted turn's
 * drain. Every other kind (dispose, eviction, voice supersession, subagent
 * teardown) is the conversation or its owner disappearing, where a queued
 * message has nothing left to run on and is discarded.
 */
export function isUserInterruptAbort(reason: AbortReason | undefined): boolean {
  return reason?.kind === "user_cancel" || reason?.kind === "signal_cancel";
}

/**
 * Synthetic `tool_result` text for a tool call an ordinary cancel cut off.
 */
export const CANCELLED_TOOL_RESULT_TEXT = "Cancelled by user";

/**
 * The instruction both interrupt annotations end on: answer the message that
 * interrupted, then decide what happens to the work it cut off.
 *
 * Shared so the two annotations cannot drift. Resuming the work inline is the
 * trap the last clause closes: the reply the user is waiting for arrives only
 * once the resumed work finishes, so an interrupt that was meant to get their
 * question answered first buys nothing. A subagent carries the work in
 * parallel and leaves the conversation free.
 */
const INTERRUPT_PRIORITY_INSTRUCTION =
  "reply to it first, then decide whether to resume or abandon the work that was in progress, and if it is still wanted and too big to finish inline, hand it to a subagent so it continues in parallel instead of holding up the conversation. This is the normal way a conversation flows, not a problem: do not apologize, do not mention that anything was stopped or interrupted, and do not ask the user to wait.";

/**
 * Synthetic `tool_result` text for a tool call a newly arrived user message
 * cut off.
 *
 * Distinct from {@link CANCELLED_TOOL_RESULT_TEXT} because the model's next
 * decision is different. A plain cancel ends the work; a preemption means a
 * message is waiting, the abandoned call may well have taken effect on the
 * outside world before the abort landed, and the model has to answer the new
 * message before it decides what to do about the work it was doing.
 */
export const PREEMPTED_TOOL_RESULT_TEXT = `A new message from the user arrived, so this tool call was stopped early. It may still have completed; check before repeating it. Treat the new message as the priority: ${INTERRUPT_PRIORITY_INSTRUCTION}`;

/**
 * Annotation appended to the LLM-facing content of the user message that
 * interrupted a turn, for the interrupt that landed with no tool call in
 * flight.
 *
 * A preemption caught mid-tool tells the model what happened through the
 * synthetic {@link PREEMPTED_TOOL_RESULT_TEXT} result. An abort that lands
 * during the provider call has no `tool_use` to answer, so the history the
 * next turn reads is the abandoned turn followed by this message, with nothing
 * saying the plan behind it was cut off. Without the note the model answers
 * the new message and drops the work it had just committed to.
 *
 * Tagged rather than written as prose so it reads as a system annotation on
 * the message instead of something the user typed. It rides on the LLM-facing
 * content only: the persisted row stays exactly what the user sent, so no
 * client renders it.
 */
export const INTERRUPTED_TURN_NOTE_TEXT = `<interrupted_turn>This message arrived while the previous turn was still thinking, before it had made any tool call, so that turn ended here. Treat this message as the priority: ${INTERRUPT_PRIORITY_INSTRUCTION}</interrupted_turn>`;

/**
 * The synthetic `tool_result` text that matches why the turn was aborted.
 *
 * Takes the raw `AbortSignal.reason` (or any candidate) so call sites can hand
 * over whatever they hold without unwrapping it first; anything that is not a
 * tagged {@link AbortReason} reads as an ordinary cancel.
 */
export function abortedToolResultText(reasonCandidate: unknown): string {
  if (isPreemptedByNewMessage(reasonCandidate)) {
    return PREEMPTED_TOOL_RESULT_TEXT;
  }
  return CANCELLED_TOOL_RESULT_TEXT;
}

/**
 * Whether the abort hands the conversation straight to a new user message.
 * Work the turn had in flight is then the replacement turn's to resume or
 * abandon, so state that reads as "still going" (a progress card) stays as it
 * is instead of being settled as if the turn had ended.
 */
export function isPreemptedByNewMessage(reasonCandidate: unknown): boolean {
  return (
    isAbortReason(reasonCandidate) &&
    reasonCandidate.kind === "preempted_by_new_message"
  );
}

export function isAbortReason(value: unknown): value is AbortReason {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return (
    (value as Record<string, unknown>)[ABORT_REASON_TAG] === true &&
    typeof (value as Record<string, unknown>).kind === "string" &&
    typeof (value as Record<string, unknown>).source === "string"
  );
}
