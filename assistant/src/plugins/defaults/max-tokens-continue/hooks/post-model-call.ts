/**
 * Default `post-model-call` hook: when the provider truncates a user-facing
 * turn at its output token limit, resume it automatically instead of ending
 * the turn.
 *
 * A `max_tokens` stop means the model had more to say — the reply (often a
 * long generation such as a skill building an entire app) simply exceeded the
 * profile's output budget. Without intervention the loop ends the turn and
 * surfaces a continuation card the user must click, and a single click often
 * just truncates again — the turn can never finish. This hook keeps the
 * truncated turn in history, appends a continuation nudge, and sets
 * `decision: "continue"` so the next model call resumes with a fresh output
 * budget.
 *
 * Scope and bounds:
 *
 * - **Main-agent turns only.** Background, subagent, and compaction calls
 *   self-manage their budgets; per the post-model-call contract the hook
 *   gates on {@link PostModelCallContext.callSite}.
 * - **Bounded per run.** A long output legitimately spans a few
 *   continuations, but a turn that keeps truncating after
 *   `MAX_TOKENS_AUTO_CONTINUES` resumes is not converging; the hook lets it
 *   end so the continuation card surfaces for the user to drive. The sibling
 *   `stop` hook (see `./stop.ts`) clears the budget when the turn
 *   terminates.
 * - **Truncation-safe content only.** The agent loop strips unsafe blocks
 *   (truncated `tool_use` and friends) before running this hook; an entirely
 *   empty remainder leaves nothing to resume from, so the hook lets the turn
 *   end rather than pushing an empty assistant message the provider would
 *   reject.
 */

import {
  type HookFunction,
  INTERNAL_NUDGE_OUTPUT_SUPPRESSION,
  isMaxTokensStopReason,
  type PostModelCallContext,
} from "@vellumai/plugin-api";

import {
  consumeMaxTokensContinueBudget,
  hasMaxTokensContinueBudget,
} from "../continue-state-store.js";

/**
 * Continuation nudge appended after the truncated assistant turn. Shown to
 * the LLM, not the user — edits here affect model behavior, not end-user UX.
 */
export const MAX_TOKENS_CONTINUE_NUDGE_TEXT =
  "<system_notice>Your previous response was cut off because it reached the maximum output length. Continue exactly where you stopped — do not repeat content you already sent and do not start over." +
  INTERNAL_NUDGE_OUTPUT_SUPPRESSION +
  "</system_notice>";

const postModelCall: HookFunction<PostModelCallContext> = async (ctx) => {
  if (ctx.error) return;
  if (!isMaxTokensStopReason(ctx.stopReason)) return;
  if (ctx.callSite !== "mainAgent") return;
  // Nothing survived truncation-block stripping — there is no partial output
  // to resume from, so let the turn end terminally.
  if (ctx.content.length === 0) return;

  if (!hasMaxTokensContinueBudget(ctx.conversationId)) {
    ctx.logger.warn(
      { plugin: "max-tokens-continue", conversationId: ctx.conversationId },
      "Turn kept hitting the output token limit — auto-continue budget exhausted, ending the turn",
    );
    return;
  }

  consumeMaxTokensContinueBudget(ctx.conversationId);
  ctx.messages.push({
    role: "assistant",
    content: structuredClone(ctx.content),
  });
  ctx.messages.push({
    role: "user",
    content: [{ type: "text", text: MAX_TOKENS_CONTINUE_NUDGE_TEXT }],
  });
  ctx.decision = "continue";
  ctx.logger.warn(
    { plugin: "max-tokens-continue", conversationId: ctx.conversationId },
    "Turn truncated at the output token limit — auto-continuing",
  );
};

export default postModelCall;
