// Pure, leaf helpers for projecting and rendering a `DisplayMessage`'s ordered
// content. NO React/DOM imports so this can be exercised with `bun test` and
// imported by both the pure activity projection (`turn-activity.ts`) and the
// React render path (`transcript-message-body.tsx`) WITHOUT a circular
// dependency. This module is the single source of truth for the grouping /
// anchor / suppression logic so the projection and the rendered DOM anchors
// cannot drift.

import type {
  ConversationContentBlock,
  ConversationMessageToolCall,
} from "@vellumai/assistant-api";

// These union members aren't individually exported from @vellumai/assistant-api;
// narrow from the discriminated union instead.
type ConversationThinkingBlock = Extract<
  ConversationContentBlock,
  { type: "thinking" }
>;
type ConversationTextBlock = Extract<
  ConversationContentBlock,
  { type: "text" }
>;
type ConversationSurfaceBlock = Extract<
  ConversationContentBlock,
  { type: "surface" }
>;
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { DisplayMessage, Surface } from "@/domains/chat/types/types";

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
 * One item inside a blocks-driven `activity` run, reusing the server block
 * shapes rather than re-declaring them: a `thinking` item is the wire
 * `thinking` block (a contiguous reasoning run is pre-merged into one
 * synthesized block — text newline-joined, timing widened to the earliest
 * start / latest completion), and a `tool_use` item is the wire `tool_use`
 * block with its `toolCall` narrowed to the client `ChatMessageToolCall`. The
 * id is guaranteed at ingest, so the narrow happens once here and the render
 * body needs no per-item check.
 */
export type ContentBlockActivityItem =
  | ConversationThinkingBlock
  | { type: "tool_use"; toolCall: ChatMessageToolCall };

/**
 * Grouped content for the blocks-driven render body. Adjacent thinking +
 * tool_use blocks merge into one `activity` group (broken only by a `text` or
 * `surface` block); `text` and `surface` reuse the server block as-is. The
 * `activity` wrapper is the only shape with no wire analog — collapsing a run
 * of blocks into one card is a render concern. Pure — no React/DOM; the blocks
 * embed their referents, so unlike `groupMessageActivityRuns` this needs no
 * positional resolvers.
 */
export type ContentBlockGroup =
  | ConversationTextBlock
  | ConversationSurfaceBlock
  | { type: "activity"; items: ContentBlockActivityItem[] };

/**
 * Narrow a wire `ConversationMessageToolCall` to the client `ChatMessageToolCall`
 * by asserting its `id` is present. The daemon guarantees an id on every wire
 * tool call (>= v0.8.8) and the ingest boundary re-synthesizes one for older
 * daemons, so every tool_use block carries an id by the time it reaches render;
 * the guard is the cast-free way to surface that narrowing to the type system.
 */
function hasToolCallId(
  toolCall: ConversationMessageToolCall,
): toolCall is ChatMessageToolCall {
  return typeof toolCall.id === "string" && toolCall.id.length > 0;
}

/**
 * Group a message's unified `contentBlocks` into merged activity runs for the
 * blocks-driven (flag-ON) render path — the block-native counterpart to
 * `groupMessageActivityRuns`. A contiguous run of `thinking` + `tool_use`
 * blocks collapses into one `activity` group whose `items` preserve interleaved
 * order; consecutive `thinking` blocks merge into one item (text joined with
 * newlines, timing widened to the earliest start / latest completion), matching
 * macOS and the legacy walk. A `text` or `surface` block closes the open
 * activity group and passes through unchanged as its own group; the render
 * body reads the client-narrowed `Surface` (placement, orphaned binding) from
 * `message.surfaces` by the block's `surface.surfaceId`, exactly as the legacy
 * walk does. `attachment` blocks are skipped — attachments render in their own
 * region from `message.attachments`, mirroring the positional walk. Pure — no
 * React/DOM.
 */
export function groupContentBlocks(
  blocks: ConversationContentBlock[],
): ContentBlockGroup[] {
  const groups: ContentBlockGroup[] = [];
  let current: { type: "activity"; items: ContentBlockActivityItem[] } | null =
    null;

  const openActivity = () => {
    if (!current) {
      current = { type: "activity", items: [] };
      groups.push(current);
    }
    return current;
  };

  for (const block of blocks) {
    if (block.type === "thinking") {
      const activity = openActivity();
      const lastItem = activity.items[activity.items.length - 1];
      if (lastItem?.type === "thinking") {
        lastItem.thinking = lastItem.thinking
          ? `${lastItem.thinking}\n${block.thinking}`
          : block.thinking;
        if (block.startedAt != null) {
          lastItem.startedAt =
            lastItem.startedAt == null
              ? block.startedAt
              : Math.min(lastItem.startedAt, block.startedAt);
        }
        if (block.completedAt != null) {
          lastItem.completedAt =
            lastItem.completedAt == null
              ? block.completedAt
              : Math.max(lastItem.completedAt, block.completedAt);
        }
      } else {
        // Synthesize a fresh thinking block so the merge above never mutates a
        // block held by `message.contentBlocks`.
        activity.items.push({
          type: "thinking",
          thinking: block.thinking,
          startedAt: block.startedAt,
          completedAt: block.completedAt,
        });
      }
    } else if (block.type === "tool_use") {
      if (!hasToolCallId(block.toolCall)) {
        continue;
      }
      openActivity().items.push({
        type: "tool_use",
        toolCall: block.toolCall,
      });
    } else if (block.type === "text") {
      current = null;
      groups.push(block);
    } else if (block.type === "surface") {
      current = null;
      groups.push(block);
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
 *
 * Resolves each `thinking:i` contentOrder id to its reasoning text, preferring
 * the unified `contentBlocks` projection and falling back to the positional
 * `thinkingSegments` per index. Thinking blocks are built in lockstep with
 * `thinkingSegments`, so the i-th thinking block carries the same text as
 * `thinkingSegments[i]`. The per-index fallback covers rows that have no
 * `contentBlocks` projection yet — older daemons that never emit blocks and
 * in-flight streaming rows whose blocks have not been built.
 */
export function resolveThinkingContent(
  message: DisplayMessage,
  ids: string[],
): string {
  const thinkingBlocks = message.contentBlocks?.filter(
    (b): b is Extract<ConversationContentBlock, { type: "thinking" }> =>
      b.type === "thinking",
  );
  return ids
    .map((id) => {
      const idx = parseInt(id, 10);
      if (isNaN(idx)) {
        return undefined;
      }
      return thinkingBlocks?.[idx]?.thinking ?? message.thinkingSegments?.[idx];
    })
    .filter((s): s is string => Boolean(s))
    .join("\n");
}

/** Earliest start and latest completion (epoch ms) across a run of thinking blocks. */
export interface ThinkingTiming {
  startedAt?: number;
  completedAt?: number;
}

/**
 * Resolve the timing of a run of `thinking` contentOrder ids: the earliest
 * `startedAt` and latest `completedAt` across the referenced thinking blocks.
 * Rows without `contentBlocks` resolve to empty timing, and the UI then hides
 * the duration exactly as a tool call with no `startedAt` does.
 */
export function resolveThinkingTiming(
  message: DisplayMessage,
  ids: string[],
): ThinkingTiming {
  const thinkingBlocks = message.contentBlocks?.filter(
    (b): b is Extract<ConversationContentBlock, { type: "thinking" }> =>
      b.type === "thinking",
  );
  if (!thinkingBlocks) return {};
  let startedAt: number | undefined;
  let completedAt: number | undefined;
  for (const id of ids) {
    const idx = parseInt(id, 10);
    if (isNaN(idx)) continue;
    const block = thinkingBlocks[idx];
    if (!block) continue;
    if (block.startedAt != null) {
      startedAt =
        startedAt == null ? block.startedAt : Math.min(startedAt, block.startedAt);
    }
    if (block.completedAt != null) {
      completedAt =
        completedAt == null
          ? block.completedAt
          : Math.max(completedAt, block.completedAt);
    }
  }
  return { startedAt, completedAt };
}

/**
 * UI surface tools are rendered by the inline surface widget, not as tool-call
 * chips — unless they carry a pending confirmation, in which case the chip must
 * render so the inline confirmation card is visible.
 */
export function isSuppressedUiTool(tc: ChatMessageToolCall): boolean {
  return (
    !tc.pendingConfirmation &&
    (tc.name === "ui_show" ||
      tc.name === "ui_update" ||
      tc.name === "ui_dismiss")
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
  if (toolCall.name === "subagent_spawn") return true;
  if (toolCall.name !== "skill_execute") return false;
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
