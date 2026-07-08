/**
 * Default `post-tool-use` hook: when an interactive turn accumulates several
 * tool-call rounds without the model having shown a `task_progress` card,
 * surface a soft notice via `additionalContext` reminding it to show progress.
 *
 * Motivation: the system prompt and the `ui_show` tool description both ask
 * the model to show a `task_progress` card on long multi-step turns, but
 * weaker models (e.g. MiniMax M3) disregard the static instruction and run
 * 30+ tool calls with no user-visible progress. A reminder injected mid-turn,
 * right after a tool result, is far more salient than static prompt text.
 *
 * The nudge is strictly best-effort:
 * - It fires at most once per turn (no nagging).
 * - It is advisory — the model may decline if it is about to finish or judges
 *   a card unnecessary.
 * - A failed or ignored card never blocks the turn.
 *
 * It is scoped to weaker open-weight model families (the plugin's own list,
 * {@link NUDGE_TARGET_MODEL_PATTERN}) that disregard the static progress-card
 * instruction; models that follow the prompt are never reminded. It also
 * self-targets: a model that already showed a card this turn is never nudged.
 *
 * The turn state is derived from conversation history on every call (mirroring
 * the tool-error and exploration-drift plugins) so the signal survives
 * mid-turn compaction rewriting the array. The current turn is the trailing
 * window bounded by the last genuine user message (a user row with no
 * tool_result blocks). Within it we count tool-use rounds and detect whether a
 * `ui_show` task_progress card was issued.
 *
 * Gating (cheap `ctx` reads, checked up front so the hot path short-circuits
 * before scanning history):
 * - mainAgent call site only — background turns (wake, title-gen, memory) run
 *   under their own call sites and subagents under `subagentSpawn`, none of
 *   which have a live user watching a progress card.
 * - the client must support dynamic UI surfaces — on channels that lack it
 *   (SMS, phone, email, most chat bridges) `ui_show` is filtered out of the
 *   tool set, so the nudge would only coach the model toward a tool it cannot
 *   call.
 * - a weaker open-weight model family ({@link NUDGE_TARGET_MODEL_PATTERN});
 *   models that follow the static prompt never need the reminder.
 *
 * Dedup uses a per-conversation high-water mark of the round count at the last
 * nudge: a non-zero mark means "already nudged this turn", which also dedupes
 * the parallel tool results of one batch (they observe identical history and
 * compute the same round count). The mark resets when the round count drops
 * below it (a new turn restarts counting low).
 */

import type {
  ContentBlock,
  HookFunction,
  Message,
  PostToolUseContext,
} from "@vellumai/plugin-api";

/**
 * Canonical nudge notice. Module-level constant so tests and wrapping plugins
 * can match it without duplicating the string. Shown to the model as
 * provider-only context, never to the user. Deliberately soft: coarse steps
 * are fine and the model may skip it when wrapping up.
 */
export const TASK_PROGRESS_NUDGE_TEXT =
  '<system_notice>You are several tool calls into this turn with no progress card shown. A card is optional, not required: if the turn is wrapping up, is not really multi-step, or you cannot form clean steps, skip it and keep working — a one-line note of what you are doing is a fine substitute, and proceeding with no card is also fine. Only if a live step tracker would genuinely help the user, show it with a SINGLE self-contained ui_show call that already contains the steps: ui_show({ surface_type: "card", data: { template: "task_progress", templateData: { title: "<what you are doing>", status: "in_progress", steps: [{ label: "<step 1>", status: "in_progress" }, { label: "<step 2>", status: "pending" }] } } }). Coarse steps are fine. Do not call ui_show with an empty `data: {}` and fill it in afterward — an empty card renders as a blank box; either include the steps now or skip the card. Advance it later with ui_update under `data.templateData`. Never let the card interrupt the actual work; if one ever looks wrong, just dismiss it and move on. You will not be nudged about this again this turn.</system_notice>';

/**
 * Number of tool-use rounds in a turn, with no task_progress card shown, that
 * triggers the nudge. Tuned conservatively: a turn of one or two rounds (the
 * common simple case) is never touched; only a clearly multi-step turn is
 * nudged, and only once. Lower from telemetry if cards still arrive too late.
 */
export const TASK_PROGRESS_NUDGE_ROUND_THRESHOLD = 3;

/**
 * Weaker open-weight model families (Kimi, DeepSeek, MiniMax, GLM) that tend to
 * disregard the static progress-card instruction and so benefit from the
 * mid-turn nudge. This is the plugin's own coaching policy, kept local and
 * matched against `ctx.model` rather than read off a shared context flag —
 * "weak" / "needs steering" is a judgement specific to this nudge, not a
 * general property of the turn, and the set is the plugin owner's to tune.
 */
const NUDGE_TARGET_MODEL_PATTERN = /kimi|deepseek|minimax|glm/i;

/**
 * Round count at the last nudge, per conversation. A non-zero entry means the
 * turn has already been nudged; it resets when the round count drops below the
 * mark (a new turn). Mirrors the exploration-drift high-water mark so parallel
 * results of one batch dedupe to a single notice.
 */
const lastNudgedRoundsByConversation = new Map<string, number>();

/** Test-only: clear the per-conversation nudge high-water marks. */
export function resetTaskProgressNudgeStateForTests(): void {
  lastNudgedRoundsByConversation.clear();
}

/**
 * True when a `ui_show` tool input shows a `task_progress` card — accepting the
 * template either at the top level or nested under `data`, mirroring the
 * server-side normalization tolerance.
 */
function isTaskProgressShowInput(input: unknown): boolean {
  if (input === null || typeof input !== "object") return false;
  const record = input as Record<string, unknown>;
  if (record.template === "task_progress") return true;
  const data = record.data;
  return (
    data !== null &&
    typeof data === "object" &&
    (data as Record<string, unknown>).template === "task_progress"
  );
}

/**
 * Scan the trailing turn (walking back to the last genuine user message) for
 * the number of tool-use rounds and whether a task_progress card was shown.
 * The current round's assistant tool_use is already in history; its result is
 * not, so the count includes the current round.
 */
function scanTurn(messages: ReadonlyArray<Message>): {
  rounds: number;
  taskProgressShown: boolean;
} {
  let rounds = 0;
  let taskProgressShown = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "user") {
      const carriesToolResult = message.content.some(
        (block: ContentBlock) =>
          block.type === "tool_result" ||
          block.type === "web_search_tool_result",
      );
      if (!carriesToolResult) break; // genuine user prompt — turn boundary
      continue;
    }
    if (message.role !== "assistant") continue;
    let hasToolUse = false;
    for (const block of message.content) {
      if (block.type !== "tool_use") continue;
      hasToolUse = true;
      if (block.name === "ui_show" && isTaskProgressShowInput(block.input)) {
        taskProgressShown = true;
      }
    }
    if (hasToolUse) rounds++;
  }
  return { rounds, taskProgressShown };
}

const postToolUse: HookFunction<PostToolUseContext> = async (ctx) => {
  // These gates are cheap ctx reads, so short-circuit before scanning history:
  // act only on a live user-facing main-agent turn (subagents run under
  // `subagentSpawn`, background work under its own call sites), on a client
  // that can actually render the card, driven by a model family this nudge
  // targets.
  if (ctx.callSite !== "mainAgent") return;
  if (!ctx.supportsDynamicUi) return;
  if (!NUDGE_TARGET_MODEL_PATTERN.test(ctx.model)) return;

  const { rounds, taskProgressShown } = scanTurn(ctx.messages);

  let lastNudged = lastNudgedRoundsByConversation.get(ctx.conversationId) ?? 0;
  if (rounds < lastNudged) {
    // New turn (round count restarted low) — drop the stale mark.
    lastNudgedRoundsByConversation.delete(ctx.conversationId);
    lastNudged = 0;
  }

  // A card now exists this turn: clear any stale mark and never nudge.
  if (taskProgressShown) {
    if (lastNudged !== 0) {
      lastNudgedRoundsByConversation.delete(ctx.conversationId);
    }
    return;
  }

  if (rounds < TASK_PROGRESS_NUDGE_ROUND_THRESHOLD) return;
  if (lastNudged !== 0) return; // already nudged this turn

  lastNudgedRoundsByConversation.set(ctx.conversationId, rounds);
  ctx.logger.info(
    { plugin: "task-progress-nudge", rounds },
    "Multi-step turn with no task_progress card — nudging the model to show progress",
  );
  ctx.additionalContext = ctx.additionalContext
    ? `${ctx.additionalContext}\n${TASK_PROGRESS_NUDGE_TEXT}`
    : TASK_PROGRESS_NUDGE_TEXT;
};

export default postToolUse;
