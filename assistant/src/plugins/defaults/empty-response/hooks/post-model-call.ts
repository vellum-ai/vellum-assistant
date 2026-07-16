/**
 * Default `post-model-call` hook: when the model yields a turn with no tool
 * calls, decide whether to let the turn end, rewrite it for the user, or
 * re-query the model.
 *
 * Two cases warrant intervention:
 *
 * 1. **Refusal stop.** The provider returned `stopReason === "refusal"` with no
 *    visible text (Anthropic's safety classifier zeroed the response) and no
 *    earlier turn this run already delivered visible text. The hook rewrites
 *    the turn into a plain-text apology (`REFUSAL_FALLBACK_TEXT`) by replacing
 *    {@link PostModelCallContext.content} and lets the turn end. A retry is
 *    deliberately not attempted: a safety-classifier refusal re-fires on a
 *    re-query, so the canned message is the intended terminal response.
 * 2. **Empty turn after tool use.** The turn produced no visible text, follows
 *    at least one prior assistant turn this run, and no earlier turn this run
 *    already delivered visible text. The hook re-queries the model with
 *    `NUDGE_TEXT` (a tool trail exists to summarize, so a retry can recover a
 *    real answer). Main-agent turns only: background, subagent, and compaction
 *    calls have no user awaiting a summary, so per the post-model-call contract
 *    the nudge self-gates on {@link PostModelCallContext.callSite}. The retry is
 *    bounded to one pass per run by a one-shot per-conversation mark this hook
 *    sets; the sibling `stop` hook (see `./stop.ts`) clears it when the turn
 *    terminates, so the next run nudges afresh.
 *
 * Every other case leaves the decision at `"stop"` (the model said its piece,
 * or there is nothing to act on).
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
 * the `post-model-call` chain — later hooks see (and may override) its
 * decision.
 *
 * Only a finalized, no-tool reply is actionable. A provider rejection carries
 * no turn content to assess (a recovery hook like history-repair owns that),
 * and a tool-bearing turn continues naturally — the loop runs the tools and
 * ignores the decision — so the hook returns early for both.
 */

import {
  type ContentBlock,
  type HookFunction,
  INTERNAL_NUDGE_OUTPUT_SUPPRESSION,
  type Message,
  type PostModelCallContext,
} from "@vellumai/plugin-api";

import {
  isEmptyResponseNudged,
  markEmptyResponseNudged,
} from "../nudge-state-store.js";
import {
  isToolResultMessage,
  REFUSAL_FALLBACK_TEXT,
} from "../refusal-quarantine.js";

// Re-exported so existing importers (tests, sibling hooks) keep resolving
// REFUSAL_FALLBACK_TEXT from this module; the definition lives in
// refusal-quarantine.ts alongside its detector (single source of truth).
export { REFUSAL_FALLBACK_TEXT };

/**
 * Canonical nudge text for an empty turn after tool use. Must stay verbatim so
 * a plugin that wraps the default sees a stable string.
 *
 * Wire-compat note: this is shown to the LLM, not the user. Edits here affect
 * model behavior but not end-user UX directly.
 */
export const NUDGE_TEXT =
  "<system_notice>Your previous response was empty. You must respond to the user with a summary of what you found or did. Do not use any tools — just respond with text." +
  INTERNAL_NUDGE_OUTPUT_SUPPRESSION +
  "</system_notice>";

function hasVisibleText(content: ReadonlyArray<ContentBlock>): boolean {
  return content.some(
    (block) => block.type === "text" && block.text.trim().length > 0,
  );
}

function hasToolUse(content: ReadonlyArray<ContentBlock>): boolean {
  return content.some((block) => block.type === "tool_use");
}

function isAssistantTurn(message: Message): boolean {
  return message.role === "assistant";
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

const postModelCall: HookFunction<PostModelCallContext> = async (ctx) => {
  // A provider rejection carries no turn content to assess (a recovery hook
  // owns the rejection); the sibling `stop` hook clears the mark when the turn
  // terminates.
  if (ctx.error) return;
  // A tool-bearing turn continues mid-run — the loop runs the tools — so leave
  // the mark intact to keep the one-nudge-per-run bound across tool iterations.
  if (hasToolUse(ctx.content)) return;

  const turnHasVisibleText = hasVisibleText(ctx.content);

  const cycleMessages = currentCycleMessages(ctx.messages);
  const priorAssistantTurns = cycleMessages.filter(isAssistantTurn);
  const hadPriorAssistantTurn = priorAssistantTurns.length > 0;
  const priorAssistantHadVisibleText = priorAssistantTurns.some((message) =>
    hasVisibleText(message.content),
  );

  // Refusal stop: rewrite the empty turn into a user-facing apology and let it
  // end. Skipped when an earlier turn this run already replied, so the apology
  // never lands beneath a real answer.
  if (
    ctx.stopReason === "refusal" &&
    !turnHasVisibleText &&
    !priorAssistantHadVisibleText
  ) {
    ctx.content = [{ type: "text", text: REFUSAL_FALLBACK_TEXT }];
    return;
  }

  const isEmptyTurnAfterTools =
    !turnHasVisibleText &&
    hadPriorAssistantTurn &&
    !priorAssistantHadVisibleText;

  if (isEmptyTurnAfterTools) {
    // Only the user-facing reply gets the re-query nudge. Background, subagent,
    // and compaction calls have no user awaiting a summary, and the
    // post-model-call contract requires self-gating on call site to avoid
    // re-querying them. The refusal-rewrite above is a user-facing terminal
    // fallback, not a re-query, so it stays ungated.
    if (ctx.callSite !== "mainAgent") return;

    // Re-query once to recover a real answer. The one-shot per-conversation
    // mark makes the hook self-limiting: a second empty turn this run finds the
    // mark already set and lets the turn end rather than nudging again.
    if (!isEmptyResponseNudged(ctx.conversationId)) {
      markEmptyResponseNudged(ctx.conversationId);
      ctx.messages.push({
        role: "user",
        content: [{ type: "text", text: NUDGE_TEXT }],
      });
      ctx.decision = "continue";
      ctx.logger.warn(
        { plugin: "empty-response", conversationId: ctx.conversationId },
        "Model returned empty response after tool results — retrying",
      );
      return;
    }

    ctx.logger.error(
      { plugin: "empty-response", conversationId: ctx.conversationId },
      "Model returned empty response after tool results — retries exhausted",
    );
  }
};

export default postModelCall;
