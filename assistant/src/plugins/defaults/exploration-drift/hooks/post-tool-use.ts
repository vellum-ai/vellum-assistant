/**
 * Default `post-tool-use` hook: when the model accumulates a long unbroken
 * run of exploration tool calls (bash, file_read, file_list) without sending
 * the user any text, surface a notice via `additionalContext` that coaches it
 * to (a) give the user a brief progress summary and (b) delegate the rest of
 * the investigation to an `investigator` subagent instead of continuing
 * inline.
 *
 * Motivation: a root-cause request investigated inline ran 167 sequential
 * bash calls in a single turn with no user-facing text, overflowed the
 * conversation context before any findings were written up, and forced the
 * user into repeated "Continue?" turns that re-explored the same files.
 * Delegation keeps the digging in a disposable subagent context. The notice
 * is advisory — the model decides whether the current run is genuinely an
 * investigation worth delegating.
 *
 * The streak is derived from conversation history on every call (mirroring
 * the tool-error plugin) so the signal survives mid-run compaction rewriting
 * the array. The trailing run is bounded by:
 * - a real user message (turn boundary),
 * - any non-empty assistant text block (the model spoke to the user),
 * - any non-exploration tool result (the model did something besides read).
 *
 * Repeat nudges are spaced one full threshold apart via a per-conversation
 * high-water mark, which also dedupes parallel tool results of one batch
 * (they all observe the same history and would compute the same streak).
 *
 * Subagent conversations are exempt: an investigator is *supposed* to dig at
 * length, and subagents cannot nest (`SUBAGENT_LIMITS.maxDepth`), so the
 * delegation advice would be wrong there. The check is a lazy import on the
 * rare nudge path so the subagent manager's module graph stays out of the
 * per-tool-result hot path.
 */

import type { PluginHookFn, PostToolUseContext } from "@vellumai/plugin-api";

import type { Message } from "../../../../providers/types.js";

/**
 * Canonical exploration-drift notice. Module-level constant so tests and
 * wrapping plugins can match it without duplicating the string. Shown to the
 * model as provider-only context, never to the user.
 */
export const EXPLORATION_DRIFT_NUDGE_TEXT =
  "<system_notice>You have made a long unbroken run of exploration tool calls (shell/file reads) without sending the user any text. Do two things now: (1) send the user a brief summary of what you have found so far — do not keep working silently; (2) if you are tracing a root cause or exploring code/logs at length, stop exploring inline and delegate the remainder to a subagent: call subagent_spawn with role 'investigator' and a precise objective. It will investigate in its own context window and return a compact root-cause report. Continuing inline floods this conversation's context and risks losing your findings before you can report them.</system_notice>";

/**
 * Exploration streak length that triggers the first nudge; repeat nudges fire
 * each time the streak grows by another full threshold.
 */
export const EXPLORATION_NUDGE_THRESHOLD = 25;

/** Read-only exploration tools whose unbroken runs indicate inline drift. */
const EXPLORATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  "bash",
  "file_read",
  "file_list",
]);

/**
 * Streak length at the last nudge, per conversation. A high-water mark rather
 * than a flag so repeat nudges stay one full threshold apart and parallel
 * results of one batch (same observed history, same computed streak) dedupe
 * to a single notice. Entries are dropped when the streak restarts.
 */
const lastNudgedStreakByConversation = new Map<string, number>();

/** Test-only: clear the per-conversation nudge high-water marks. */
export function resetExplorationDriftStateForTests(): void {
  lastNudgedStreakByConversation.clear();
}

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
 * Length of the trailing unbroken run of exploration tool results in history.
 * Walks backwards from the most recent message and stops at a real user
 * message, a non-empty assistant text block, or a non-exploration tool
 * result. Text blocks inside tool-result user rows (e.g. coaching notices
 * appended by other hooks) do not break the run — they are system notices,
 * not the model speaking to the user.
 */
function trailingExplorationStreak(
  messages: ReadonlyArray<Message>,
  namesById: ReadonlyMap<string, string>,
): number {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "assistant") {
      const spokeToUser = message.content.some(
        (block) => block.type === "text" && block.text.trim().length > 0,
      );
      if (spokeToUser) break;
      continue;
    }
    if (message.role !== "user") continue;
    const hasToolResult = message.content.some(
      (block) => block.type === "tool_result",
    );
    if (!hasToolResult) break;
    for (let j = message.content.length - 1; j >= 0; j--) {
      const block = message.content[j];
      if (block.type !== "tool_result") continue;
      const toolName = namesById.get(block.tool_use_id);
      if (toolName === undefined || !EXPLORATION_TOOL_NAMES.has(toolName)) {
        return count;
      }
      count++;
    }
  }
  return count;
}

const postToolUse: PluginHookFn<PostToolUseContext> = async (ctx) => {
  const namesById = toolNamesById(ctx.messages);
  const toolName = namesById.get(ctx.toolResponse.tool_use_id);
  if (toolName === undefined || !EXPLORATION_TOOL_NAMES.has(toolName)) return;

  // The current result is not in history yet — count it explicitly.
  const streak = trailingExplorationStreak(ctx.messages, namesById) + 1;

  let lastNudged = lastNudgedStreakByConversation.get(ctx.conversationId) ?? 0;
  if (streak < lastNudged) {
    // The streak restarted (new turn, intervening text, or compaction) since
    // the last nudge — drop the stale high-water mark.
    lastNudgedStreakByConversation.delete(ctx.conversationId);
    lastNudged = 0;
  }
  if (streak - lastNudged < EXPLORATION_NUDGE_THRESHOLD) return;

  // Subagent conversations are exempt — see module doc.
  const { getSubagentManager } = await import("../../../../subagent/index.js");
  if (getSubagentManager().getParentInfo(ctx.conversationId) !== undefined) {
    return;
  }

  lastNudgedStreakByConversation.set(ctx.conversationId, streak);
  ctx.logger.info(
    { plugin: "exploration-drift", streak, toolName },
    "Exploration drift detected — nudging summary + investigator delegation",
  );
  ctx.additionalContext = ctx.additionalContext
    ? `${ctx.additionalContext}\n${EXPLORATION_DRIFT_NUDGE_TEXT}`
    : EXPLORATION_DRIFT_NUDGE_TEXT;
};

export default postToolUse;
