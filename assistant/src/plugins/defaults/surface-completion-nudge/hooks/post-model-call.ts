/**
 * Default `post-model-call` hook: when a user-facing turn is about to end with a
 * progress surface the model showed but never closed, nudge the model — once
 * per run — to complete or dismiss it, then re-query so it can act.
 *
 * Motivation: the model can call `ui_show` with a `task_progress` card (or a
 * `work_result` in an `in_progress` state) to show live progress, but weaker
 * models often never advance it to a terminal status or `ui_dismiss` it. The
 * surface then renders a spinner forever, long after the work finished. Static
 * prompt guidance is easy to ignore; a reminder injected at the moment the turn
 * would otherwise end — with a concrete "you left this open" signal — is far
 * more salient.
 *
 * The nudge is strictly best-effort and self-targeting:
 * - It fires at most once per run (no looping if the model declines).
 * - It is advisory — the model may leave the surface open if the work it
 *   represents is genuinely still running.
 * - A model that already completed or dismissed its surfaces is never nudged,
 *   so capable models that close their surfaces pay nothing.
 *
 * Only a finalized, no-tool, main-agent reply is actionable:
 * - A provider rejection carries no turn content to assess (a recovery hook
 *   like history-repair owns that).
 * - A tool-bearing turn continues naturally — the loop runs the tools and the
 *   model gets another chance to close the surface — so we leave it alone.
 * - Background call sites (wake, title-gen, memory) have no live user watching
 *   a spinner, so the nudge would only burn a model round.
 *
 * No subagent guard is needed: the `ui-surface` tools are gated on a connected
 * client (see `conversation-tool-setup.ts`), and subagents have none — so a
 * subagent can never create a surface and so can never trigger this hook.
 *
 * The dangling-surface signal is derived from the current response cycle (the
 * messages after the last genuine user prompt) by correlating each progress
 * `ui_show` with its `surface_id` result and folding in later `ui_update` /
 * `ui_dismiss` calls. Deriving the cycle boundary from history content rather
 * than an index means mid-run compaction (which rewrites the array in place)
 * can't invalidate it.
 *
 * The one-shot bound is split across two hooks: this hook marks the
 * conversation when it nudges, and the sibling `stop` hook clears the mark when
 * the turn terminates, so the next run nudges afresh.
 *
 * Defaults register before any user plugin, so this hook runs at the front of
 * the `post-model-call` chain — later hooks see (and may override) its decision.
 */

import type {
  ContentBlock,
  HookFunction,
  Message,
  PostModelCallContext,
} from "@vellumai/plugin-api";

import {
  isSurfaceCompletionNudged,
  markSurfaceCompletionNudged,
} from "../nudge-state-store.js";

/**
 * Canonical nudge text. Shown to the model as provider-only context, never to
 * the user. Kept verbatim so a plugin that wraps the default sees a stable
 * string. Deliberately soft: the model may leave the surface open if the work
 * is genuinely still running.
 */
export const SURFACE_COMPLETION_NUDGE_TEXT =
  '<system_notice>You showed the user a progress surface this turn (a task_progress card or a work_result) and are about to end the turn with it still marked in_progress. If that work is finished, advance it to a terminal state now — call ui_update to set its status to "completed" (or "failed"), or ui_dismiss it — so the user is not left watching a card spin forever. Do this only if the work it represents is actually done; if it is genuinely still running, leave it. Then give your final reply.</system_notice>';

/**
 * Surface statuses that mean the progress surface has reached a terminal state
 * and needs no completion nudge. Covers both `task_progress`
 * (`completed`/`failed`) and `work_result` (`completed`/`partial`/`failed`),
 * plus `cancelled` for tolerance.
 */
const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "partial",
  "cancelled",
]);

function hasToolUse(content: ReadonlyArray<ContentBlock>): boolean {
  return content.some((block) => block.type === "tool_use");
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Pull a surface status out of a `ui_show` / `ui_update` input, tolerating the
 * shapes the server-side normalization accepts: nested under
 * `data.templateData` (task_progress), under `data` (work_result), or at the
 * top level. Returns a lowercased status, or `undefined` when none is present.
 */
function extractStatus(input: Record<string, unknown>): string | undefined {
  const data = asRecord(input.data);
  const templateData =
    asRecord(data?.templateData) ?? asRecord(input.templateData);
  const raw = templateData?.status ?? data?.status ?? input.status;
  return typeof raw === "string" ? raw.trim().toLowerCase() : undefined;
}

/**
 * Whether a `ui_show` input describes a surface with a progress lifecycle: a
 * `task_progress` card or a `work_result`. Returns the initial status when so.
 */
function progressShowInfo(input: Record<string, unknown>): {
  isProgress: boolean;
  status: string | undefined;
} {
  const surfaceType = input.surface_type;
  if (surfaceType === "work_result") {
    return { isProgress: true, status: extractStatus(input) };
  }
  if (surfaceType === "card") {
    const data = asRecord(input.data);
    const template = data?.template ?? input.template;
    if (template === "task_progress") {
      return { isProgress: true, status: extractStatus(input) };
    }
  }
  return { isProgress: false, status: undefined };
}

function surfaceIdOf(input: Record<string, unknown>): string | undefined {
  return typeof input.surface_id === "string" ? input.surface_id : undefined;
}

/** Parse the `{ surfaceId }` JSON a successful `ui_show` returns. */
function parseSurfaceId(content: string): string | undefined {
  try {
    const parsed = JSON.parse(content) as unknown;
    const record = asRecord(parsed);
    return typeof record?.surfaceId === "string" ? record.surfaceId : undefined;
  } catch {
    return undefined;
  }
}

interface SurfaceState {
  /** Latest known status, lowercased; `undefined` when never set explicitly. */
  status: string | undefined;
  dismissed: boolean;
}

function isNonTerminal(state: SurfaceState): boolean {
  if (state.dismissed) return false;
  return state.status === undefined || !TERMINAL_STATUSES.has(state.status);
}

/**
 * True when the current response cycle left at least one progress surface
 * (a `task_progress` card or `work_result`) open: shown but neither advanced to
 * a terminal status nor dismissed.
 *
 * Each progress `ui_show` is correlated to its `surface_id` via the matching
 * tool result (the result lands in the next message; updates and dismisses
 * arrive in later messages, after the model has the id in hand). Later
 * `ui_update` / `ui_dismiss` calls fold their status / dismissal onto the
 * tracked surface.
 */
function hasDanglingProgressSurface(messages: ReadonlyArray<Message>): boolean {
  const surfaces = new Map<string, SurfaceState>();
  // tool_use_id -> initial status of a progress ui_show awaiting its result id.
  const pendingShows = new Map<string, string | undefined>();

  for (const message of currentCycleMessages(messages)) {
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type !== "tool_use") continue;
        if (block.name === "ui_show") {
          const info = progressShowInfo(block.input);
          if (info.isProgress) pendingShows.set(block.id, info.status);
        } else if (block.name === "ui_update") {
          const id = surfaceIdOf(block.input);
          const status = extractStatus(block.input);
          if (id && status !== undefined) {
            const existing = surfaces.get(id);
            if (existing) existing.status = status;
            else surfaces.set(id, { status, dismissed: false });
          }
        } else if (block.name === "ui_dismiss") {
          const id = surfaceIdOf(block.input);
          if (id) {
            const existing = surfaces.get(id);
            if (existing) existing.dismissed = true;
            else surfaces.set(id, { status: undefined, dismissed: true });
          }
        }
      }
      continue;
    }
    if (message.role !== "user") continue;
    for (const block of message.content) {
      // guard:allow-tool-result-only — only the local tool executor's
      // `tool_result` carries a `ui_show` `surfaceId` to correlate. A
      // `web_search_tool_result` comes from a `server_tool_use`, never a
      // `ui_show`, so it can never match a pending show and is correctly skipped.
      if (block.type !== "tool_result") continue;
      if (!pendingShows.has(block.tool_use_id)) continue;
      const initialStatus = pendingShows.get(block.tool_use_id);
      pendingShows.delete(block.tool_use_id);
      const id = parseSurfaceId(block.content);
      if (!id) continue;
      const existing = surfaces.get(id);
      // A later update/dismiss can register the id before its show result is
      // scanned only if history was reordered; guard so we never clobber a
      // known terminal/dismissed state with the initial status.
      if (existing) {
        if (existing.status === undefined && !existing.dismissed) {
          existing.status = initialStatus;
        }
      } else {
        surfaces.set(id, { status: initialStatus, dismissed: false });
      }
    }
  }

  for (const state of surfaces.values()) {
    if (isNonTerminal(state)) return true;
  }
  return false;
}

const postModelCall: HookFunction<PostModelCallContext> = async (ctx) => {
  // A provider rejection carries no turn content to assess (a recovery hook
  // owns the rejection).
  if (ctx.error) return;
  // A tool-bearing turn continues mid-run — the loop runs the tools and the
  // model gets another chance to close the surface — so leave it alone.
  if (hasToolUse(ctx.content)) return;
  // Only nudge the user-facing reply: background call sites have no live user
  // watching a spinner.
  if (ctx.callSite !== "mainAgent") return;
  // One nudge per run; the sibling `stop` hook clears the mark on terminal stop.
  if (isSurfaceCompletionNudged(ctx.conversationId)) return;

  if (!hasDanglingProgressSurface(ctx.messages)) return;

  markSurfaceCompletionNudged(ctx.conversationId);
  ctx.messages.push({
    role: "user",
    content: [{ type: "text", text: SURFACE_COMPLETION_NUDGE_TEXT }],
  });
  ctx.decision = "continue";
  ctx.logger.info(
    { plugin: "surface-completion-nudge", conversationId: ctx.conversationId },
    "Turn ending with an open progress surface — nudging the model to complete or dismiss it",
  );
};

export default postModelCall;
