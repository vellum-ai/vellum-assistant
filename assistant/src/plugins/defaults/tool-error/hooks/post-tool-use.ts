/**
 * Default `post-tool-use` hook: when a tool result carries `is_error`, set
 * `additionalContext` with a system-notice that coaches the model to either
 * retry with corrected parameters (for recoverable errors) or report the
 * failure to the user (for unrecoverable ones).
 *
 * The coaching is delivered via `additionalContext`, not by mutating the tool
 * result's `content`. The loop appends it to the provider-bound history as a
 * separate block after the tool_result event is emitted, so the model sees the
 * guidance while the client-facing and persisted tool output stay the tool's
 * actual result. This mirrors how Claude Code (`additionalContext`) and Codex
 * (`additional_contexts`) surface PostToolUse feedback as separate context
 * rather than rewriting the tool response.
 *
 * The coaching is bounded per tool: once a single tool has failed
 * `MAX_CONSECUTIVE_ERROR_NUDGES` times in a row the notice is dropped — the
 * error is likely not something the model can fix on its own, and continuing
 * to coach a retry only burns tokens. The consecutive-failure count is derived
 * from the conversation history (the trailing run of error results for this
 * tool name, plus the current one) rather than a loop-held counter, so the
 * guard survives mid-run compaction rewriting the history array. A successful
 * result for the tool resets its streak.
 */

import type {
  HookFunction,
  Message,
  PostToolUseContext,
} from "@vellumai/plugin-api";

/**
 * Canonical tool-error coaching text. Kept as a module-level constant so tests
 * and plugins that wrap the default can match it without duplicating the
 * string.
 *
 * This is shown to the model as provider-only context, not the user. Edits
 * here affect retry behavior but not end-user UX directly.
 */
export const TOOL_ERROR_NUDGE_TEXT =
  "<system_notice>This tool call returned an error. If the error looks recoverable (e.g. missing or invalid parameters), fix the parameters and retry. If the error is clearly unrecoverable (e.g. a service is down, a resource does not exist, or a permission is permanently denied), report it to the user.</system_notice>";

/**
 * Number of back-to-back failures of a single tool to coach before giving up.
 * Coaching fires on the 1st through Nth consecutive failure and is dropped from
 * the (N+1)th onward.
 */
const MAX_CONSECUTIVE_ERROR_NUDGES = 3;

/** Map every `tool_use` block id in history to the tool name it invoked. */
function toolNamesById(messages: ReadonlyArray<Message>): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type === "tool_use") names.set(block.id, block.name);
    }
  }
  return names;
}

/**
 * Trailing run of consecutive error results for `toolName` already in history.
 * Walks the tool's results in chronological order and counts back from the most
 * recent until a successful result breaks the streak. The current result is not
 * yet in history, so callers add it themselves.
 */
function priorConsecutiveErrors(
  messages: ReadonlyArray<Message>,
  toolName: string,
  namesById: ReadonlyMap<string, string>,
): number {
  const isErrorByOrder: boolean[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const block of message.content) {
      if (block.type !== "tool_result") continue;
      if (namesById.get(block.tool_use_id) !== toolName) continue;
      isErrorByOrder.push(block.is_error === true);
    }
  }

  let streak = 0;
  for (let i = isErrorByOrder.length - 1; i >= 0; i--) {
    if (!isErrorByOrder[i]) break;
    streak++;
  }
  return streak;
}

const postToolUse: HookFunction<PostToolUseContext> = async (ctx) => {
  if (ctx.toolResponse.is_error !== true) return;

  const namesById = toolNamesById(ctx.messages);
  const toolName = namesById.get(ctx.toolResponse.tool_use_id);

  // Prior failures of this tool plus the current one. An unresolved name (the
  // current turn's tool_use is always in history, so this is defensive) falls
  // back to coaching this lone failure.
  const consecutiveErrors =
    (toolName === undefined
      ? 0
      : priorConsecutiveErrors(ctx.messages, toolName, namesById)) + 1;

  if (consecutiveErrors > MAX_CONSECUTIVE_ERROR_NUDGES) {
    ctx.logger.info(
      {
        plugin: "tool-error",
        toolName,
        toolUseId: ctx.toolResponse.tool_use_id,
        consecutiveErrors,
      },
      "Skipping tool-error coaching after repeated consecutive failures",
    );
    return;
  }

  ctx.additionalContext = TOOL_ERROR_NUDGE_TEXT;
};

export default postToolUse;
