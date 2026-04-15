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
  | "voice_session_aborted"
  /** A scheduled work item run was cancelled or its conversation reset. */
  | "work_item_aborted";

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

export function isAbortReason(value: unknown): value is AbortReason {
  if (typeof value !== "object" || value === null) return false;
  return (
    (value as Record<string, unknown>)[ABORT_REASON_TAG] === true &&
    typeof (value as Record<string, unknown>).kind === "string" &&
    typeof (value as Record<string, unknown>).source === "string"
  );
}
