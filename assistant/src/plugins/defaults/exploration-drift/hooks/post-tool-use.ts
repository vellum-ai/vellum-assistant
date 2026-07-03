/**
 * Default `post-tool-use` hook: when a turn's exploration tool calls (bash,
 * code_search, file_read, file_list) show drift — a long unbroken run with no text sent to
 * the user, or the model re-issuing the exact same call — surface a notice
 * via `additionalContext` that coaches it to (a) give the user a brief
 * progress summary and (b) delegate the rest of the investigation to an
 * `investigator` subagent instead of continuing inline.
 *
 * Motivation: a root-cause request investigated inline ran 167 sequential
 * bash calls in a single turn with no user-facing text, overflowed the
 * conversation context before any findings were written up, and forced the
 * user into repeated "Continue?" turns that re-explored the same files (11 of
 * the 15 files read in the follow-up turn were re-reads). Delegation keeps
 * the digging in a disposable subagent context. The notices are advisory —
 * the model decides whether the current run is genuinely an investigation
 * worth delegating.
 *
 * Two triggers, sharing one trailing-run computation:
 *
 * 1. **Long dig** (all models): an unbroken run of
 *    {@link EXPLORATION_NUDGE_THRESHOLD} exploration calls with no user-facing
 *    text. Repeat nudges are spaced one full threshold apart.
 * 2. **Loop** (loop-prone models only, currently Kimi K2.6 and MiniMax M3):
 *    the current call
 *    is byte-identical (same tool, same input) to at least
 *    {@link EXPLORATION_LOOP_REPEAT_THRESHOLD}-1 prior calls within the
 *    trailing run. Re-issuing an identical read-only call inside an unbroken
 *    read-only run yields no new information — it is the earliest reliable
 *    sign the model is stuck, so this fires as soon as the repetition
 *    appears (potentially at call 3 of a run) rather than waiting for the
 *    long-dig threshold, and re-fires on every further duplicate while the
 *    model keeps looping. Gated by model so the aggressive trigger covers
 *    only models prone to this looping; the one legitimate identical-call pattern
 *    (polling an external process's output) is rare inside an unbroken
 *    read-only run and the nudge is advisory anyway.
 *
 * The trailing run is derived from conversation history on every call
 * (mirroring the tool-error plugin) so the signal survives mid-run compaction
 * rewriting the array. The run is bounded by:
 * - a real user message (turn boundary),
 * - any non-empty assistant text block (the model spoke to the user),
 * - any non-exploration tool result (the model did something besides read).
 *
 * Nudges dedupe via a per-conversation high-water mark of the streak length
 * at the last nudge: long-dig nudges require another full threshold of
 * growth, loop nudges require any growth (each additional duplicate call
 * re-nudges). The mark also dedupes parallel tool results of one batch (they
 * all observe identical history and compute the same streak). Entries are
 * dropped when the streak restarts.
 *
 * Subagent conversations are exempt: an investigator is *supposed* to dig at
 * length, and subagents cannot nest (`SUBAGENT_LIMITS.maxDepth`), so the
 * delegation advice would be wrong there. Subagents run under the
 * `subagentSpawn` call site, so the exemption is a cheap `ctx.callSite` read.
 */

import type {
  HookFunction,
  Message,
  PostToolUseContext,
} from "@vellumai/plugin-api";

/**
 * Canonical long-dig notice. Module-level constant so tests and wrapping
 * plugins can match it without duplicating the string. Shown to the model as
 * provider-only context, never to the user.
 */
export const EXPLORATION_DRIFT_NUDGE_TEXT =
  "<system_notice>You have made a long unbroken run of exploration tool calls (shell/file reads) without sending the user any text. Do two things now: (1) send the user a brief summary of what you have found so far — do not keep working silently; (2) if you are tracing a root cause or exploring code/logs at length, stop exploring inline and delegate the remainder to a subagent: call subagent_spawn with role 'investigator' and a precise objective. It will investigate in its own context window and return a compact root-cause report. Continuing inline floods this conversation's context and risks losing your findings before you can report them.</system_notice>";

/**
 * Canonical loop notice, parameterized on the repeated call. Firmer than the
 * long-dig text — by the time an identical read-only call repeats, the model
 * is demonstrably not gaining information.
 */
export function explorationLoopNudgeText(
  toolName: string,
  repeatCount: number,
): string {
  return `<system_notice>You have issued this exact ${toolName} call ${repeatCount} times in the current run of exploration tool calls. Repeating an identical read-only call yields no new information — you are likely stuck. Do two things now: (1) send the user a brief summary of what you have found so far and what you are still missing — do not keep working silently; (2) stop exploring inline and delegate the remaining investigation to a subagent: call subagent_spawn with role 'investigator' and a precise objective that includes what you have already checked and ruled out. It will investigate in its own context window and return a compact root-cause report. Do not re-issue this call again.</system_notice>`;
}

/**
 * Exploration streak length that triggers the first long-dig nudge; repeat
 * long-dig nudges fire each time the streak grows by another full threshold.
 */
export const EXPLORATION_NUDGE_THRESHOLD = 25;

/**
 * Number of byte-identical exploration calls (tool name + input) within one
 * trailing run that triggers the loop nudge on loop-prone models. The count
 * includes the current call, so 3 means "the current call is the third
 * identical issue of this command".
 */
export const EXPLORATION_LOOP_REPEAT_THRESHOLD = 3;

/**
 * Models that get the early loop trigger: Kimi K2.6 and MiniMax M3, matched
 * across provider naming conventions (Fireworks spells the dot as `p`, e.g.
 * `accounts/fireworks/models/kimi-k2p6`; OpenRouter reports
 * `moonshotai/kimi-k2.6` and `minimax/minimax-m3`). Extend the pattern as
 * other models exhibit the same re-exploration looping.
 */
const LOOP_PRONE_MODEL_PATTERN = /kimi-k2[p.]6|minimax-m3/i;

/** Read-only exploration tools whose unbroken runs indicate inline drift. */
const EXPLORATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  "bash",
  "code_search",
  "file_read",
  "file_list",
]);

/**
 * Streak length at the last nudge (either kind), per conversation. A
 * high-water mark rather than a flag so long-dig nudges stay one full
 * threshold apart, loop nudges fire only when the streak has grown since the
 * last nudge, and parallel results of one batch (same observed history, same
 * computed streak) dedupe to a single notice. Entries are dropped when the
 * streak restarts.
 */
const lastNudgedStreakByConversation = new Map<string, number>();

/** Test-only: clear the per-conversation nudge high-water marks. */
export function resetExplorationDriftStateForTests(): void {
  lastNudgedStreakByConversation.clear();
}

/** A `tool_use` block's invocation: tool name plus its raw input. */
interface ToolInvocation {
  readonly name: string;
  readonly input: unknown;
}

/** Map every `tool_use` block id in history to its invocation. */
function toolUsesById(
  messages: ReadonlyArray<Message>,
): Map<string, ToolInvocation> {
  const uses = new Map<string, ToolInvocation>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type === "tool_use") {
        uses.set(block.id, { name: block.name, input: block.input });
      }
    }
  }
  return uses;
}

/**
 * Deterministic JSON encoding with object keys sorted recursively, so two
 * semantically identical tool inputs hash to the same signature regardless of
 * key order.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(",")}}`;
}

/**
 * The trailing unbroken run of exploration tool results in history: its
 * length and the `tool_use` ids of the calls in it. Walks backwards from the
 * most recent message and stops at a real user message, a non-empty assistant
 * text block, or a non-exploration tool result. Text blocks inside
 * tool-result user rows (e.g. coaching notices appended by other hooks) do
 * not break the run — they are system notices, not the model speaking to the
 * user.
 */
function trailingExplorationRun(
  messages: ReadonlyArray<Message>,
  usesById: ReadonlyMap<string, ToolInvocation>,
): { streak: number; toolUseIds: string[] } {
  const toolUseIds: string[] = [];
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
      const use = usesById.get(block.tool_use_id);
      if (use === undefined || !EXPLORATION_TOOL_NAMES.has(use.name)) {
        return { streak: toolUseIds.length, toolUseIds };
      }
      toolUseIds.push(block.tool_use_id);
    }
  }
  return { streak: toolUseIds.length, toolUseIds };
}

/**
 * How many times the current call (tool name + input) has been issued within
 * the trailing run, including the current call itself. Signatures are only
 * computed for same-named calls, and only on the loop-prone-model path, to
 * keep the per-tool-result cost bounded.
 */
function currentCallRepeatCount(
  current: ToolInvocation,
  runToolUseIds: ReadonlyArray<string>,
  usesById: ReadonlyMap<string, ToolInvocation>,
): number {
  const currentSignature = stableStringify(current.input);
  let count = 1;
  for (const id of runToolUseIds) {
    const use = usesById.get(id);
    if (
      use !== undefined &&
      use.name === current.name &&
      stableStringify(use.input) === currentSignature
    ) {
      count++;
    }
  }
  return count;
}

const postToolUse: HookFunction<PostToolUseContext> = async (ctx) => {
  const usesById = toolUsesById(ctx.messages);
  const currentUse = usesById.get(ctx.toolResponse.tool_use_id);
  if (currentUse === undefined || !EXPLORATION_TOOL_NAMES.has(currentUse.name))
    return;

  // The current result is not in history yet — count it explicitly.
  const run = trailingExplorationRun(ctx.messages, usesById);
  const streak = run.streak + 1;

  let lastNudged = lastNudgedStreakByConversation.get(ctx.conversationId) ?? 0;
  if (streak < lastNudged) {
    // The streak restarted (new turn, intervening text, or compaction) since
    // the last nudge — drop the stale high-water mark.
    lastNudgedStreakByConversation.delete(ctx.conversationId);
    lastNudged = 0;
  }

  const longDigNudge = streak - lastNudged >= EXPLORATION_NUDGE_THRESHOLD;

  // Loop detection: only on loop-prone models, and only when the streak has
  // grown since the last nudge (dedupes parallel batches; re-fires on each
  // further duplicate). Keyed to the *current* call's signature so the nudge
  // stops as soon as the model moves on to fresh calls.
  let loopRepeatCount = 0;
  if (
    !longDigNudge &&
    streak > lastNudged &&
    LOOP_PRONE_MODEL_PATTERN.test(ctx.model)
  ) {
    loopRepeatCount = currentCallRepeatCount(
      currentUse,
      run.toolUseIds,
      usesById,
    );
  }
  const loopNudge = loopRepeatCount >= EXPLORATION_LOOP_REPEAT_THRESHOLD;

  if (!longDigNudge && !loopNudge) return;

  // Subagent conversations are exempt — see module doc. Subagents run under
  // the `subagentSpawn` call site.
  if (ctx.callSite === "subagentSpawn") return;

  lastNudgedStreakByConversation.set(ctx.conversationId, streak);
  const nudgeText = loopNudge
    ? explorationLoopNudgeText(currentUse.name, loopRepeatCount)
    : EXPLORATION_DRIFT_NUDGE_TEXT;
  ctx.logger.info(
    {
      plugin: "exploration-drift",
      streak,
      toolName: currentUse.name,
      trigger: loopNudge ? "loop" : "long-dig",
      ...(loopNudge ? { repeatCount: loopRepeatCount } : {}),
    },
    "Exploration drift detected — nudging summary + investigator delegation",
  );
  ctx.additionalContext = ctx.additionalContext
    ? `${ctx.additionalContext}\n${nudgeText}`
    : nudgeText;
};

export default postToolUse;
