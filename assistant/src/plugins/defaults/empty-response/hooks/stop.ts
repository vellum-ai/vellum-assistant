/**
 * Default `stop` hook: when the model yields a turn with no tool calls, decide
 * whether to let the turn end or re-query the model with a nudge.
 *
 * Two cases warrant a nudge:
 *
 * 1. **Refusal stop.** The provider returned `stopReason === "refusal"` with no
 *    visible text (Anthropic's safety classifier zeroed the response). Nudged
 *    even on the first model call of the run — a refusal there guarantees no
 *    organic text exists yet, so without intervening the loop would persist an
 *    empty assistant bubble to the user. Uses `REFUSAL_NUDGE_TEXT`.
 * 2. **Empty turn after tool use.** The turn produced no visible text, follows
 *    at least one prior assistant turn this run, and no earlier turn this run
 *    already delivered visible text. Uses `NUDGE_TEXT`.
 *
 * Every other case leaves the decision at `"stop"` (the model said its piece,
 * or there is nothing to nudge about). The retry cap is owned by the agent
 * loop: this hook always asks to continue when a nudge is warranted, and the
 * loop stops anyway once the run's nudge budget is spent.
 *
 * Both prior-turn signals are derived from the current response cycle — the
 * messages after the last genuine user prompt (a user turn that isn't purely
 * tool results). Scoping this way keeps prior conversation turns from polluting
 * the signals, and deriving the boundary from history content rather than an
 * index means mid-run compaction (which rewrites the array in place) can't
 * invalidate it. A prior assistant turn this cycle implies a completed tool-use
 * iteration (an empty turn nudges-and-continues without pushing an assistant
 * message), so "a prior assistant turn exists" is the equivalent of "this is
 * not the first model call".
 *
 * Defaults register before any user plugin, so this hook runs at the front of
 * the `stop` chain — later hooks see (and may override) its decision.
 */

import type { PluginHookFn, StopContext } from "@vellumai/plugin-api";

import type { ContentBlock, Message } from "../../../../providers/types.js";

/**
 * Canonical nudge text for an empty turn after tool use. Must stay verbatim so
 * a plugin that wraps the default sees a stable string.
 *
 * Wire-compat note: this is shown to the LLM, not the user. Edits here affect
 * model behavior but not end-user UX directly.
 */
export const NUDGE_TEXT =
  "<system_notice>Your previous response was empty. You must respond to the user with a summary of what you found or did. Do not use any tools — just respond with text.</system_notice>";

/**
 * Refusal-specific nudge. Used when the provider stops with `"refusal"` and no
 * visible text — i.e. the safety classifier zeroed the response. Kept distinct
 * from `NUDGE_TEXT` so the model gets context-appropriate guidance (no "summary
 * of what you found or did" — there is no tool trail to summarize on a refusal).
 *
 * Wire-compat note: this is shown to the LLM, not the user. Edits here affect
 * retry behavior but not end-user UX directly.
 */
export const REFUSAL_NUDGE_TEXT =
  '<system_notice>Your previous response was empty because the upstream provider returned stop_reason="refusal". Please answer the user\'s last message directly with a plain-text response. Do not use any tools — just respond with text.</system_notice>';

function hasVisibleText(content: ReadonlyArray<ContentBlock>): boolean {
  return content.some(
    (block) => block.type === "text" && block.text.trim().length > 0,
  );
}

function isAssistantTurn(message: Message): boolean {
  return message.role === "assistant";
}

/** A user-role message carrying only tool results, not a fresh prompt. */
function isToolResultMessage(message: Message): boolean {
  return (
    message.role === "user" &&
    message.content.length > 0 &&
    message.content.every((block) => block.type === "tool_result")
  );
}

/**
 * Messages belonging to the current response cycle: everything after the last
 * genuine user prompt. Falls back to the whole history when none is found.
 */
function currentCycleMessages(
  messages: ReadonlyArray<Message>,
): ReadonlyArray<Message> {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "user" && !isToolResultMessage(message)) {
      return messages.slice(i + 1);
    }
  }
  return messages;
}

const stop: PluginHookFn<StopContext> = async (ctx) => {
  const turnHasVisibleText = hasVisibleText(ctx.responseContent);

  const appendNudge = (text: string): void => {
    ctx.messages.push({ role: "user", content: [{ type: "text", text }] });
    ctx.decision = "continue";
  };

  if (ctx.stopReason === "refusal" && !turnHasVisibleText) {
    appendNudge(REFUSAL_NUDGE_TEXT);
    return;
  }

  const cycleMessages = currentCycleMessages(ctx.messages);
  const priorAssistantTurns = cycleMessages.filter(isAssistantTurn);
  const hadPriorAssistantTurn = priorAssistantTurns.length > 0;
  const priorAssistantHadVisibleText = priorAssistantTurns.some((message) =>
    hasVisibleText(message.content),
  );

  const isEmptyTurnAfterTools =
    !turnHasVisibleText &&
    hadPriorAssistantTurn &&
    !priorAssistantHadVisibleText;

  if (isEmptyTurnAfterTools) {
    appendNudge(NUDGE_TEXT);
  }
};

export default stop;
