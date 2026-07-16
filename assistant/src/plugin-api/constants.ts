/**
 * Public hook-name constants.
 *
 * Plugin authors reference hooks by name in two places: the keys on
 * `Plugin.hooks` and the daemon's `runHook(name, ctx)` call sites.
 * Centralizing the string literals here keeps the typo surface minimal
 * and lets call sites import a typed constant instead of repeating a
 * free-form string.
 *
 * New hooks land here as additional `HOOKS.*` entries. The runtime
 * `runHook(name, ctx)` accepts any string (so test fixtures and
 * forward-compat hooks can still chain through), but call sites in
 * first-party code should always reach for a `HOOKS.*` constant.
 */

export const HOOKS = {
  /** Plugin bootstrap. Fires once when the daemon loads the plugin. */
  INIT: "init",
  /** Plugin teardown. Fires once when the daemon unloads the plugin. */
  SHUTDOWN: "shutdown",
  /** Fires once per user turn, immediately before the agent loop receives `runMessages`. */
  USER_PROMPT_SUBMIT: "user-prompt-submit",
  /** Fires immediately before each provider call. A hook may edit the outbound request (e.g. the system prompt), route the call to a different inference profile, and opt the turn into deferred output streaming. */
  PRE_MODEL_CALL: "pre-model-call",
  /** Fires once per tool result, after the tool returns and before the result is sent to the provider. */
  POST_TOOL_USE: "post-tool-use",
  /** Fires once per run when the loop has committed to ending — the definitive terminal hook for teardown. Cannot continue the loop; reports how the turn ended via `exitReason`. */
  STOP: "stop",
  /** Fires at every model-call outcome (finalized reply or provider rejection), before the message is persisted/streamed-final. A hook may transform the content and owns the continue/retry decision. */
  POST_MODEL_CALL: "post-model-call",
  /** Fires after the loop successfully compacts a conversation mid-turn. */
  POST_COMPACT: "post-compact",
  /** Fires once per deleted conversation, after its rows are removed. Fire-and-forget cleanup signal — hooks run async with no ordering guarantee relative to the caller. */
  CONVERSATION_DELETED: "conversation-deleted",
} as const;

/** Union of every hook name declared in {@link HOOKS}. */
export type HookName = (typeof HOOKS)[keyof typeof HOOKS];

/**
 * Appended (inside the `<system_notice>` wrapper) to the internal continuation /
 * completion nudge strings that re-query the model. Those notices are injected
 * as user-role turns; weaker models without a separate reasoning channel
 * otherwise narrate or answer the notice as visible text, leaking agent-loop
 * scaffolding into the user-facing reply. This clause forbids that narration
 * without licensing an empty reply — each nudge's own instruction still drives
 * the expected output (summary / final reply / continuation).
 */
export const INTERNAL_NUDGE_OUTPUT_SUPPRESSION =
  " This notice is internal: do not repeat, quote, describe, or acknowledge it, and do not narrate whether you will continue or whether the turn is done. Reply with only the content the user should see.";
