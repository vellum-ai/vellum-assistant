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
  ConversationSurfaceBlock,
  ConversationTextBlock,
  ConversationThinkingBlock,
} from "@vellumai/assistant-api";

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { Surface } from "@/domains/chat/types/types";
import {
  containsInlineThinkingTag,
  parseInlineThinkingTags,
} from "@/domains/chat/utils/parse-inline-thinking";

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
 * embed their referents, so there are no positional resolvers.
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

export interface GroupContentBlocksOptions {
  /**
   * Split inline `<thinking>`/`<think>` tags out of text blocks into
   * synthesized thinking blocks before grouping, so tag-emitted reasoning
   * renders through the same activity path as native thinking blocks
   * (matching macOS). Pass for assistant messages only — user-typed tags must
   * render verbatim.
   */
  splitInlineThinking?: boolean;
}

/**
 * Expand text blocks containing inline `<thinking>`/`<think>` tags into
 * interleaved thinking + text blocks. Returns the input array untouched when
 * no text block carries a tag (the common case).
 */
function splitInlineThinkingBlocks(
  blocks: ConversationContentBlock[],
): ConversationContentBlock[] {
  if (
    !blocks.some((b) => b.type === "text" && containsInlineThinkingTag(b.text))
  ) {
    return blocks;
  }
  return blocks.flatMap((block): ConversationContentBlock[] => {
    const segments =
      block.type === "text" ? parseInlineThinkingTags(block.text) : null;
    if (!segments) return [block];
    return segments.map((seg) =>
      seg.type === "thinking"
        ? { type: "thinking", thinking: seg.thinking }
        : { type: "text", text: seg.text },
    );
  });
}

/**
 * Group a message's unified `contentBlocks` into merged activity runs for the
 * render path. A contiguous run of `thinking` + `tool_use`
 * blocks collapses into one `activity` group whose `items` preserve interleaved
 * order; consecutive `thinking` blocks merge into one item (text joined with
 * newlines, timing widened to the earliest start / latest completion), matching
 * macOS. A `text` or `surface` block closes the open
 * activity group and passes through unchanged as its own group; the render
 * body reads the surface straight off the block's `surface`, narrowed to the
 * display `Surface` at render. `attachment` blocks are skipped — attachments
 * render in their own region from `message.attachments`. Pure — no React/DOM.
 */
export function groupContentBlocks(
  blocks: ConversationContentBlock[],
  options?: GroupContentBlocksOptions,
): ContentBlockGroup[] {
  const walked = options?.splitInlineThinking
    ? splitInlineThinkingBlocks(blocks)
    : blocks;

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

  for (const block of walked) {
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
 * Tool calls that never render as transcript chips because another element
 * carries their outcome: UI surface tools render as the inline surface
 * widget, and `send_reaction` renders as the reaction chip on the target
 * message. A pending confirmation always forces the chip so the inline
 * confirmation card stays visible.
 */
export function isSuppressedToolChip(tc: ChatMessageToolCall): boolean {
  return (
    !tc.pendingConfirmation &&
    (tc.name === "ui_show" ||
      tc.name === "ui_update" ||
      tc.name === "ui_dismiss" ||
      tc.name === "send_reaction")
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
 * Detect whether a tool call is a `run_workflow` invocation. Like
 * `subagent_spawn`, the daemon exposes `run_workflow` as a bundled-skill tool,
 * so the LLM emits a `skill_execute` call with `input.tool === "run_workflow"`
 * — the `tool_use_start` event the frontend receives still carries
 * `toolName: "skill_execute"`. Matching on the raw `toolName` alone would miss
 * every launch and leave the inline workflow card unrendered.
 */
export function isRunWorkflowCall(toolCall: ChatMessageToolCall): boolean {
  if (toolCall.name === "run_workflow") return true;
  if (toolCall.name !== "skill_execute") return false;
  const input = toolCall.input;
  if (input == null || typeof input !== "object") return false;
  return (input as Record<string, unknown>).tool === "run_workflow";
}

/**
 * Detect whether a tool call is an `acp_spawn` invocation. Like
 * `subagent_spawn`/`run_workflow`, the daemon exposes `acp_spawn` as a
 * bundled-skill tool, so the LLM emits a `skill_execute` call with
 * `input.tool === "acp_spawn"` — the `tool_use_start` event the frontend
 * receives still carries `toolName: "skill_execute"`. Matching on the raw
 * `toolName` alone would miss every spawn and leave the inline ACP run card
 * unrendered.
 */
export function isAcpSpawnCall(toolCall: ChatMessageToolCall): boolean {
  if (toolCall.name === "acp_spawn") return true;
  if (toolCall.name !== "skill_execute") return false;
  const input = toolCall.input;
  if (input == null || typeof input !== "object") return false;
  return (input as Record<string, unknown>).tool === "acp_spawn";
}

/**
 * Detect whether a tool call is a backgrounded `bash`/`host_bash` invocation.
 * Unlike the subagent/workflow/ACP triad, background bash is not a
 * `skill_execute` envelope — it's an `input.background === true` flag on the
 * real `bash`/`host_bash` tool, so we match the raw tool name plus the flag.
 */
export function isBackgroundBashCall(toolCall: ChatMessageToolCall): boolean {
  if (toolCall.name !== "bash" && toolCall.name !== "host_bash") return false;
  const input = toolCall.input;
  if (input == null || typeof input !== "object") return false;
  return (input as Record<string, unknown>).background === true;
}

/**
 * Detect a task-progress card surface — `template === "task_progress"` with a
 * non-empty `steps` array. Used by the activity-summary hoist-detection path.
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
