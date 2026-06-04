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
  /**
   * Transitional internal hook. Fires once per user turn at the early
   * "prompt submitted, before context assembly" moment — before memory/PKB
   * injection and overflow reduction — so memory retrieval can produce the
   * turn-state those transforms consume. Distinct from `user-prompt-submit`
   * (which fires late, after those transforms) until compaction is cleared
   * from the gap between the two moments, at which point it folds into
   * `user-prompt-submit`. Not part of the stable external hook surface.
   */
  USER_PROMPT_SUBMIT_TEMP: "user-prompt-submit-temp",
  /** Fires once per tool result, after the tool returns and before the result is sent to the provider. */
  POST_TOOL_USE: "post-tool-use",
  /** Fires when the model yields a response with no tool calls — the run's stop boundary. Decides whether to stop or continue with a follow-up turn. */
  STOP: "stop",
} as const;

/** Union of every hook name declared in {@link HOOKS}. */
export type HookName = (typeof HOOKS)[keyof typeof HOOKS];
