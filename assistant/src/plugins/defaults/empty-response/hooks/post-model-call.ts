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
  isToolResultMessage,
  type Message,
  type PostModelCallContext,
  REFUSAL_FALLBACK_TEXT,
} from "@vellumai/plugin-api";

import {
  isEmptyResponseNudged,
  markEmptyResponseNudged,
} from "../nudge-state-store.js";

// Re-exported so existing importers (tests, sibling hooks) keep resolving
// REFUSAL_FALLBACK_TEXT from this module; the definition lives in the host's
// `context/refusal-quarantine.ts` alongside its detector (single source of
// truth).
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

/**
 * Canonical nudge text for a turn that ended without reaching the user through
 * `send_user_message`. Shown to the LLM, not the user.
 */
export const SEND_USER_MESSAGE_NUDGE_TEXT =
  "<system_notice>Nothing you wrote reached the user. Call send_user_message with a 1 to 3 sentence reply now." +
  INTERNAL_NUDGE_OUTPUT_SUPPRESSION +
  "</system_notice>";

/**
 * LLM-facing name of the tool a suppressed run's reply travels on. Spelled
 * here as a literal, like the memory block keys the storage schema names, so
 * the plugin stays self-contained: it reads its own turn content and imports
 * nothing from the host. The host's declaration is
 * `config/send-user-message-gate.ts`.
 */
const SEND_USER_MESSAGE_TOOL_NAME = "send_user_message";

/** Whether the content carries a `send_user_message` call with real text. */
function hasSendUserMessageCall(content: ReadonlyArray<ContentBlock>): boolean {
  return content.some(
    (block) =>
      block.type === "tool_use" &&
      block.name === SEND_USER_MESSAGE_TOOL_NAME &&
      typeof (block.input as { message?: unknown })?.message === "string" &&
      (block.input as { message: string }).message.trim().length > 0,
  );
}

/**
 * Whether the user has been told the OUTCOME of this cycle's work, not merely
 * that work started.
 *
 * The signal is the LAST assistant response that called any tool. A response
 * whose only tool calls are `send_user_message` reported on everything before
 * it; a response that sends a message alongside other tool calls is a progress
 * update, and what those tools found has not reached the user. A cycle with no
 * tool-bearing response at all told the user nothing.
 */
function userWasToldOutcome(cycleMessages: ReadonlyArray<Message>): boolean {
  for (let i = cycleMessages.length - 1; i >= 0; i--) {
    const message = cycleMessages[i];
    if (!isAssistantTurn(message) || !hasToolUse(message.content)) {
      continue;
    }
    const toolCalls = message.content.filter(
      (block) => block.type === "tool_use",
    );
    return (
      hasSendUserMessageCall(message.content) &&
      toolCalls.every((block) => block.name === SEND_USER_MESSAGE_TOOL_NAME)
    );
  }
  return false;
}

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
  if (ctx.error) {
    return;
  }
  // A tool-bearing turn continues mid-run — the loop runs the tools — so leave
  // the mark intact to keep the one-nudge-per-run bound across tool iterations.
  if (hasToolUse(ctx.content)) {
    return;
  }

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

  // Tool-gated reply surface: nothing the model wrote as plain text reaches
  // the user, so the turn is only answered when a `send_user_message` call
  // reported the OUTCOME. This response holds no tool call at all (the guard
  // above), so it is the terminal one: if the last tool-bearing response was
  // work rather than a report — a progress update sent alongside that work
  // counts as work — the turn is ending in silence. Nudge once for a real
  // reply, and after that let the turn end; the loop then surfaces this
  // response's raw text as the fallback rather than delivering nothing.
  //
  // Owned entirely here: the legacy empty-turn nudge below asks for plain
  // text, which is exactly what the gate makes invisible.
  if (
    ctx.callSite === "mainAgent" &&
    ctx.assistantTextSuppressed === true &&
    !userWasToldOutcome(cycleMessages)
  ) {
    if (!isEmptyResponseNudged(ctx.conversationId)) {
      markEmptyResponseNudged(ctx.conversationId);
      ctx.messages.push({
        role: "user",
        content: [{ type: "text", text: SEND_USER_MESSAGE_NUDGE_TEXT }],
      });
      ctx.decision = "continue";
      ctx.logger.warn(
        { plugin: "empty-response", conversationId: ctx.conversationId },
        "Turn ended without a send_user_message call — nudging for a reply",
      );
      return;
    }
    ctx.logger.warn(
      { plugin: "empty-response", conversationId: ctx.conversationId },
      "Turn ended without a send_user_message call after a nudge — surfacing the raw reply",
    );
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
    if (ctx.callSite !== "mainAgent") {
      return;
    }

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
