/**
 * Default `post-tool-use` hook: when a turn's exploration tool calls (bash,
 * file_read, file_list) show drift — a long unbroken run with no text sent to
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
 * Three triggers:
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
 * 3. **Empty-input escalation** (loop-prone models only): the current call is a
 *    `skill_execute` whose resolved inner input is empty and that errored, for
 *    the {@link EMPTY_INPUT_ESCALATE_THRESHOLD}-th time in the trailing run
 *    against the same inner tool. A weak model that emits an empty `input`
 *    cannot serialize the call's parameters, and the existing remediation text
 *    has demonstrably failed (it repeated the empty call up to nine times in
 *    one doc-writer incident). Prose from the same weak model is not the fix,
 *    so this branch consults a stronger advisor model (Pragun's `consultAdvisor`)
 *    once per streak and injects its concrete guidance. Unlike triggers 1–2 the
 *    detection ignores the envelope's `activity` field (which the model varies
 *    every call, defeating byte-identical matching) and keys on the resolved
 *    inner tool. The advisor consult is an LLM call, so it is tightly gated:
 *    loop-prone model, errored empty call, threshold reached, advisor enabled,
 *    and at most once per streak.
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
 * delegation advice would be wrong there. The check is a lazy import on the
 * rare nudge path so the subagent manager's module graph stays out of the
 * per-tool-result hot path.
 */

import type { PluginHookFn, PostToolUseContext } from "@vellumai/plugin-api";

import type { Message } from "../../../../providers/types.js";

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
  "file_read",
  "file_list",
]);

/** The dispatch wrapper whose empty inner input signals a stuck weak model. */
const SKILL_EXECUTE_TOOL_NAME = "skill_execute";

/**
 * Number of consecutive empty-input `skill_execute` calls against the same
 * inner tool (including the current one) that triggers an advisor escalation
 * on loop-prone models. Empty input means the model dropped the call's
 * parameters entirely — a cleaner stuck signal than a byte-identical repeat,
 * so it fires one step sooner than {@link EXPLORATION_LOOP_REPEAT_THRESHOLD}.
 */
export const EMPTY_INPUT_ESCALATE_THRESHOLD = 2;

/**
 * Notice wrapping the advisor's guidance after an empty-input escalation. The
 * advice comes from a stronger model that reviewed the conversation; the model
 * is told to act on it and stop sending empty calls.
 */
export function emptyInputEscalationText(
  innerTool: string,
  repeatCount: number,
  advice: string,
): string {
  return `<system_notice>You have called ${innerTool} with empty parameters ${repeatCount} times in a row and it keeps failing — the parameters are not reaching the tool. A stronger advisor model reviewed this conversation and provided guidance:\n\n${advice}\n\nAct on it now: re-issue ${innerTool} once with every required field filled in. Do not send another empty call.</system_notice>`;
}

/**
 * Deterministic fallback when the advisor is unavailable or returns nothing.
 * Zero-cost and firm: stop repeating the empty call, fill the parameters, or
 * tell the user plainly.
 */
export function emptyInputNudgeText(
  innerTool: string,
  repeatCount: number,
): string {
  return `<system_notice>You have called ${innerTool} with empty parameters ${repeatCount} times in a row and it keeps failing — the parameters are not reaching the tool. Stop repeating the empty call. Re-issue ${innerTool} once with every required field filled in (the skill's instructions from skill_load list them). If you cannot produce the parameters, tell the user plainly instead of retrying.</system_notice>`;
}

/**
 * Streak length at the last nudge (either kind), per conversation. A
 * high-water mark rather than a flag so long-dig nudges stay one full
 * threshold apart, loop nudges fire only when the streak has grown since the
 * last nudge, and parallel results of one batch (same observed history, same
 * computed streak) dedupe to a single notice. Entries are dropped when the
 * streak restarts.
 */
const lastNudgedStreakByConversation = new Map<string, number>();

/**
 * Empty-input streak length at the last escalation, per conversation. The
 * advisor consult is an LLM call, so it must fire at most once per streak: we
 * escalate when the streak first reaches the threshold and not again until it
 * drops back below it (the model recovered or the turn boundary moved). Entries
 * reset to 0 when the streak falls below the threshold.
 */
const lastEscalatedEmptyStreakByConversation = new Map<string, number>();

/** Test-only: clear the per-conversation nudge high-water marks. */
export function resetExplorationDriftStateForTests(): void {
  lastNudgedStreakByConversation.clear();
  lastEscalatedEmptyStreakByConversation.clear();
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

/** Envelope keys consumed by `skill_execute` itself, never inner-tool params. */
const SKILL_EXECUTE_ENVELOPE_KEYS: ReadonlySet<string> = new Set([
  "tool",
  "input",
  "activity",
]);

/**
 * The inner tool name and emptiness of a `skill_execute` envelope. Mirrors the
 * emptiness verdict of `resolveSkillExecuteInput` (in `tools/skills/execute.ts`)
 * without importing it — keeping this lightweight history hook off the tool
 * registry's module graph. A call counts as non-empty when `input` is a
 * populated object, a non-empty string (the resolver JSON-parses it), or when
 * inner parameters are spread as siblings of `tool`/`activity`. Everything else
 * — including the empty-string `input: ""` shape weak models emit — is empty. A
 * non-`skill_execute` invocation reports an empty tool name and never matches.
 */
function innerSkillExecute(invocation: ToolInvocation): {
  tool: string;
  empty: boolean;
} {
  const envelope = invocation.input;
  if (
    envelope === null ||
    typeof envelope !== "object" ||
    Array.isArray(envelope)
  ) {
    return { tool: "", empty: true };
  }
  const env = envelope as Record<string, unknown>;
  const tool = typeof env.tool === "string" ? env.tool : "";
  const raw = env.input;
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    if (Object.keys(raw as Record<string, unknown>).length > 0) {
      return { tool, empty: false };
    }
  } else if (typeof raw === "string" && raw.trim() !== "") {
    return { tool, empty: false };
  }
  const hasSiblingParams = Object.keys(env).some(
    (key) => !SKILL_EXECUTE_ENVELOPE_KEYS.has(key),
  );
  return { tool, empty: !hasSiblingParams };
}

/**
 * Count empty-input `skill_execute` calls against `innerTool` in the trailing
 * run — the stretch of history since the model last sent the user text or a
 * real user message arrived. Unlike {@link trailingExplorationRun} this does
 * not break on intervening non-matching tool results: an empty-input loop is
 * still a loop even if a stray successful call sits between two empties. The
 * envelope's `activity` field is ignored (the model varies it every call), so
 * matching keys only on the resolved inner tool + emptiness.
 */
function trailingEmptyInputRepeatCount(
  messages: ReadonlyArray<Message>,
  usesById: ReadonlyMap<string, ToolInvocation>,
  innerTool: string,
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
    for (const block of message.content) {
      if (block.type !== "tool_result") continue;
      const use = usesById.get(block.tool_use_id);
      if (use === undefined || use.name !== SKILL_EXECUTE_TOOL_NAME) continue;
      const inner = innerSkillExecute(use);
      if (inner.empty && inner.tool === innerTool) count++;
    }
  }
  return count;
}

/**
 * Trigger 3: escalate a weak model stuck issuing empty-input `skill_execute`
 * calls to a stronger advisor. Returns `true` when it handled the call (so the
 * caller stops), `false` when this branch does not apply.
 */
async function maybeEscalateEmptyInput(
  ctx: PostToolUseContext,
  usesById: ReadonlyMap<string, ToolInvocation>,
  currentUse: ToolInvocation,
): Promise<boolean> {
  if (currentUse.name !== SKILL_EXECUTE_TOOL_NAME) return false;
  // Only models known to drop tool parameters, and only when the call errored —
  // a rare tool that legitimately takes no parameters succeeds and is skipped.
  if (!LOOP_PRONE_MODEL_PATTERN.test(ctx.model)) return false;
  if (ctx.toolResponse.is_error !== true) return false;

  const inner = innerSkillExecute(currentUse);
  if (!inner.empty || inner.tool === "") return false;

  // The current result is not in history yet — count it explicitly.
  const repeatCount =
    trailingEmptyInputRepeatCount(ctx.messages, usesById, inner.tool) + 1;

  const lastEscalated =
    lastEscalatedEmptyStreakByConversation.get(ctx.conversationId) ?? 0;
  if (repeatCount < EMPTY_INPUT_ESCALATE_THRESHOLD) {
    // Streak hasn't reached the threshold (or restarted) — clear any stale mark
    // so a later loop can escalate again.
    if (lastEscalated !== 0) {
      lastEscalatedEmptyStreakByConversation.delete(ctx.conversationId);
    }
    return false;
  }
  // Escalate at most once per streak.
  if (lastEscalated >= EMPTY_INPUT_ESCALATE_THRESHOLD) return true;
  lastEscalatedEmptyStreakByConversation.set(ctx.conversationId, repeatCount);

  // Heavy imports (provider graph, config) stay off the per-tool-result hot
  // path — pulled in only on the rare escalation.
  const { advisorEnabledForProfile } =
    await import("../../advisor/advisor-gate.js");
  let advice = "";
  if (advisorEnabledForProfile(null)) {
    const { consultAdvisor } = await import("../../advisor/consult.js");
    advice = await consultAdvisor({
      systemPrompt: null,
      messages: ctx.messages,
    });
  }
  const escalated = advice.trim().length > 0 && !advice.startsWith("(advisor");
  const nudgeText = escalated
    ? emptyInputEscalationText(inner.tool, repeatCount, advice)
    : emptyInputNudgeText(inner.tool, repeatCount);

  ctx.logger.info(
    {
      plugin: "exploration-drift",
      trigger: "empty-input-escalation",
      innerTool: inner.tool,
      repeatCount,
      escalated,
    },
    "Empty-input skill_execute loop — escalating to advisor",
  );
  ctx.additionalContext = ctx.additionalContext
    ? `${ctx.additionalContext}\n${nudgeText}`
    : nudgeText;
  return true;
}

const postToolUse: PluginHookFn<PostToolUseContext> = async (ctx) => {
  const usesById = toolUsesById(ctx.messages);
  const currentUse = usesById.get(ctx.toolResponse.tool_use_id);
  if (currentUse === undefined) return;

  // Trigger 3 handles skill_execute; triggers 1–2 handle exploration tools.
  if (await maybeEscalateEmptyInput(ctx, usesById, currentUse)) return;

  if (!EXPLORATION_TOOL_NAMES.has(currentUse.name)) return;

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

  // Subagent conversations are exempt — see module doc.
  const { getSubagentManager } = await import("../../../../subagent/index.js");
  if (getSubagentManager().getParentInfo(ctx.conversationId) !== undefined) {
    return;
  }

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
