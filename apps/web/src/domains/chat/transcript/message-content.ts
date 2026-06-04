// Pure, leaf helpers for projecting and rendering a `DisplayMessage`'s ordered
// content. NO React/DOM imports so this can be exercised with `bun test` and
// imported by both the pure activity projection (`turn-activity.ts`) and the
// React render path (`transcript-message-body.tsx`) WITHOUT a circular
// dependency. This module is the single source of truth for the grouping /
// anchor / suppression logic so the projection and the rendered DOM anchors
// cannot drift.

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { Surface } from "@/domains/chat/types/types";
import type { DisplayMessage } from "@/domains/chat/utils/reconcile";

/**
 * One item inside an `activity` run for the merged activity-summary grouping.
 * A `thinking` item carries the contentOrder ids of a contiguous reasoning
 * run; a `tool` item carries a single tool-call/contentOrder id.
 */
export type ActivityRunItem =
  | { kind: "thinking"; ids: string[] }
  | { kind: "tool"; id: string };

/**
 * Grouped content shape for the merged activity-summary render branch. Adjacent
 * thinking + tool entries merge into one `activity` group (broken only by a
 * `text` or `surface` entry); `text`/`surface` pass through individually.
 */
export type MergedContentGroup =
  | { type: "text"; id: string }
  | { type: "surface"; id: string }
  | { type: "activity"; items: ActivityRunItem[] };

/**
 * Group `message.contentOrder` into merged activity runs for the
 * activity-summary (flag-ON) render path. A contiguous run of `thinking` +
 * `toolCall`/`tool` entries collapses into a single `activity` group whose
 * `items` preserve interleaved order; consecutive `thinking` entries merge
 * into one thinking item's `ids`. A `text` or `surface` entry closes the open
 * activity group and passes through as its own group. Pure — no React/DOM.
 */
export function groupMessageActivityRuns(
  message: DisplayMessage,
): MergedContentGroup[] {
  const groups: MergedContentGroup[] = [];
  let current: { type: "activity"; items: ActivityRunItem[] } | null = null;

  for (const entry of message.contentOrder ?? []) {
    if (entry.type === "thinking") {
      if (!current) {
        current = { type: "activity", items: [] };
        groups.push(current);
      }
      const lastItem = current.items[current.items.length - 1];
      if (lastItem?.kind === "thinking") {
        lastItem.ids.push(entry.id);
      } else {
        current.items.push({ kind: "thinking", ids: [entry.id] });
      }
    } else if (entry.type === "toolCall" || entry.type === "tool") {
      if (!current) {
        current = { type: "activity", items: [] };
        groups.push(current);
      }
      current.items.push({ kind: "tool", id: entry.id });
    } else if (entry.type === "text") {
      current = null;
      groups.push({ type: "text", id: entry.id });
    } else if (entry.type === "surface") {
      current = null;
      groups.push({ type: "surface", id: entry.id });
    }
  }

  return groups;
}

/**
 * Resolve a tool call from a contentOrder id — find by `id`, else parse-int the
 * id into a positional index of `message.toolCalls`.
 */
export function resolveToolCall(
  message: DisplayMessage,
  id: string,
): ChatMessageToolCall | undefined {
  const tc = message.toolCalls?.find((t) => t.id === id);
  if (tc) {
    return tc;
  }
  const idx = parseInt(id, 10);
  if (!isNaN(idx) && message.toolCalls && idx < message.toolCalls.length) {
    return message.toolCalls[idx];
  }
  return undefined;
}

/**
 * Join the reasoning segments referenced by a run of `thinking` contentOrder
 * ids into a single markdown string (mirrors macOS, which joins adjacent
 * reasoning indices with newlines).
 */
export function resolveThinkingContent(
  message: DisplayMessage,
  ids: string[],
): string {
  return ids
    .map((id) => {
      const idx = parseInt(id, 10);
      return !isNaN(idx) ? message.thinkingSegments?.[idx] : undefined;
    })
    .filter((s): s is string => Boolean(s))
    .join("\n");
}

/**
 * UI surface tools are rendered by the inline surface widget, not as tool-call
 * chips — unless they carry a pending confirmation, in which case the chip must
 * render so the inline confirmation card is visible.
 */
export function isSuppressedUiTool(tc: ChatMessageToolCall): boolean {
  return (
    !tc.pendingConfirmation &&
    (tc.toolName === "ui_show" ||
      tc.toolName === "ui_update" ||
      tc.toolName === "ui_dismiss")
  );
}

/**
 * Detect whether a tool call is a `subagent_spawn` invocation. The daemon
 * exposes `subagent_spawn` as a bundled-skill tool, which means the LLM
 * actually emits a `skill_execute` call with `input.tool === "subagent_spawn"`
 * — the daemon's `skill_execute` interceptor (see
 * `assistant/src/daemon/conversation-tool-setup.ts`) re-dispatches to the
 * real executor, but the `tool_use_start` event the frontend receives still
 * carries `toolName: "skill_execute"`. Matching on the raw `toolName` would
 * miss every spawn and leave inline subagent cards unrendered.
 */
export function isSubagentSpawnCall(toolCall: ChatMessageToolCall): boolean {
  if (toolCall.toolName === "subagent_spawn") return true;
  if (toolCall.toolName !== "skill_execute") return false;
  const input = toolCall.input;
  if (input == null || typeof input !== "object") return false;
  return (input as Record<string, unknown>).tool === "subagent_spawn";
}

/**
 * Detect a task-progress card surface — `template === "task_progress"` with a
 * non-empty `steps` array. Single source of truth shared by `CardSurface`'s
 * render-detection and the activity-summary path's hoist-detection so the two
 * decisions cannot drift.
 */
export function isTaskProgressSurface(surface: Surface): boolean {
  const data = surface.data as
    | { template?: string; templateData?: { steps?: unknown } }
    | undefined;
  return (
    data?.template === "task_progress" &&
    Array.isArray(data.templateData?.steps) &&
    (data.templateData!.steps as unknown[]).length > 0
  );
}
