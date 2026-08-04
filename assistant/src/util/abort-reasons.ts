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
