/**
 * Terminal handler for the default `emptyResponse` pipeline.
 *
 * This module is side-effect free: importing it does not register any plugin.
 * The terminal is wired in as the pipeline's `terminal` argument by the
 * `runPipeline` call site in `agent/loop.ts`. Wiring the terminal at the call
 * site (rather than relying on the plugin to be registered) means the loop's
 * nudge/accept behavior survives configurations that boot without the default
 * plugin — e.g. unit tests that skip `bootstrapPlugins()`.
 *
 * The terminal inspects the turn snapshot and returns one of:
 *
 * 1. `"nudge"`  — the turn produced no visible text, no tool calls, follows
 *                 at least one prior tool-use turn, no earlier turn in this
 *                 run() has already delivered visible text, AND the retry
 *                 counter is below `maxEmptyResponseRetries`. The loop
 *                 appends `nudgeText` (the `<system_notice>…` message below)
 *                 as a `user` turn and re-queries the model.
 * 2. `"accept"` — every other case. The turn either legitimately ended
 *                 (model said its piece earlier), is still in progress
 *                 (tool calls pending), or exhausted its retry budget. The
 *                 loop pushes the assistant message and continues normally.
 *
 * The default never returns `"error"` — that action is an escape hatch for
 * downstream plugins (e.g. a circuit breaker) that want to surface an
 * explicit error instead of silently absorbing an empty turn.
 *
 * `MAX_EMPTY_RESPONSE_RETRIES` lives in `agent/loop.ts` and is threaded into
 * the pipeline via `EmptyResponseArgs.maxEmptyResponseRetries` so the cap is
 * declared in one place only.
 */

import type { EmptyResponseArgs, EmptyResponseResult } from "../../types.js";

/**
 * Canonical nudge text. Must stay verbatim so a plugin that wraps the
 * default cannot accidentally see a different string.
 *
 * Wire-compat note: this is shown to the LLM, not the user. Edits here
 * affect model behavior but not end-user UX directly.
 */
const NUDGE_TEXT =
  "<system_notice>Your previous response was empty. You must respond to the user with a summary of what you found or did. Do not use any tools — just respond with text.</system_notice>";

/**
 * Terminal handler for the `emptyResponse` pipeline. Exported so tests can
 * verify default behavior directly without going through `runPipeline`, and
 * so `agent/loop.ts` can pass it as the `terminal` argument to `runPipeline`.
 */
export function defaultEmptyResponseTerminal(
  args: EmptyResponseArgs,
): EmptyResponseResult {
  const hasVisibleText = args.responseContent.some(
    (block) =>
      block.type === "text" &&
      typeof (block as { text?: unknown }).text === "string" &&
      (block as { text: string }).text.trim().length > 0,
  );

  const isEmptyTurn =
    !hasVisibleText &&
    args.toolUseBlocksLength === 0 &&
    args.toolUseTurns > 0 &&
    !args.priorAssistantHadVisibleText;

  if (isEmptyTurn && args.emptyResponseRetries < args.maxEmptyResponseRetries) {
    return { action: "nudge", nudgeText: NUDGE_TEXT };
  }
  return { action: "accept" };
}
