/**
 * Default `emptyResponse` behavior: decides whether an empty assistant turn
 * should be nudged (re-queried) or accepted.
 *
 * This module is side-effect free: importing it does not register any plugin.
 *
 * The handler inspects the turn snapshot and returns one of:
 *
 * 1. `"nudge"`  — fired in two distinct shapes:
 *                 (a) **Post-tool empty.** The turn produced no visible text,
 *                     no tool calls, follows at least one prior tool-use turn,
 *                     no earlier turn in this run() has already delivered
 *                     visible text, AND the retry counter is below
 *                     `maxEmptyResponseRetries`. Uses `NUDGE_TEXT`.
 *                 (b) **Refusal stop.** The provider returned
 *                     `stopReason === "refusal"` with no visible text and no
 *                     tool calls (Anthropic's safety classifier). Nudges even
 *                     on turn 0 / before any tool use, because a refusal on
 *                     the first model call of the run is a hard guarantee
 *                     that no organic text exists yet — without intervening
 *                     we'd persist an empty assistant bubble to the user.
 *                     Uses the refusal-specific `REFUSAL_NUDGE_TEXT`. The
 *                     retry cap still applies; after `maxEmptyResponseRetries`
 *                     refusals in a row the terminal falls through to accept.
 *                 The loop appends the chosen `nudgeText` as a `user` turn
 *                 and re-queries the model.
 * 2. `"accept"` — every other case. The turn either legitimately ended
 *                 (model said its piece earlier), is still in progress
 *                 (tool calls pending), or exhausted its retry budget. The
 *                 loop pushes the assistant message and continues normally.
 *
 * The default never returns `"error"` — that action is an escape hatch for
 * downstream plugins (e.g. a circuit breaker) that want to surface an
 * explicit error instead of silently absorbing an empty turn.
 *
 * `MAX_EMPTY_RESPONSE_RETRIES` lives in `agent/loop.ts` and is passed in via
 * `EmptyResponseArgs.maxEmptyResponseRetries` so the cap is declared in one
 * place only.
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
 * Refusal-specific nudge. Used when the provider stops with `"refusal"`
 * before any tool use — i.e. the safety classifier zeroed the response.
 * Kept distinct from `NUDGE_TEXT` so the model gets context-appropriate
 * guidance (no "summary of what you found or did" — there is no tool
 * trail to summarize on a turn-0 refusal).
 *
 * Wire-compat note: this is shown to the LLM, not the user. Edits here
 * affect retry behavior but not end-user UX directly.
 */
export const REFUSAL_NUDGE_TEXT =
  '<system_notice>Your previous response was empty because the upstream provider returned stop_reason="refusal". Please answer the user\'s last message directly with a plain-text response. Do not use any tools — just respond with text.</system_notice>';

/**
 * Decide whether an empty turn should be nudged or accepted. Exported so the
 * agent loop can call it directly and tests can verify the decision logic.
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

  // Refusal stop with zero usable content — the provider's safety
  // classifier zeroed the response. Nudge regardless of toolUseTurns or
  // priorAssistantHadVisibleText: a `"refusal"` stop with no visible
  // text and no tool calls IS the failure mode this branch exists to
  // catch (otherwise we persist an empty assistant bubble to the user).
  // Still respect the retry cap so a persistent classifier doesn't
  // burn turns indefinitely.
  const isRefusal =
    args.stopReason === "refusal" &&
    !hasVisibleText &&
    args.toolUseBlocksLength === 0;

  if (isRefusal && args.emptyResponseRetries < args.maxEmptyResponseRetries) {
    return { action: "nudge", nudgeText: REFUSAL_NUDGE_TEXT };
  }

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
