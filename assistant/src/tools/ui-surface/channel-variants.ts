/**
 * Per-channel projections of the UI surface tool definitions.
 *
 * Slack renders exactly one surface — the task_progress card (everything else
 * is rejected at execution; see `isSlackTaskProgressUiException` in
 * `daemon/conversation-surfaces.ts`) — so Slack conversations get a `ui_show`
 * variant documenting only that shape instead of the full multi-surface docs.
 *
 * Projection contract: shared definition objects are never mutated (variants
 * are module-level constants swapped in via spread-copy), and the projected
 * set is a pure function of per-conversation-stable channel state, so a
 * conversation's tools+system prompt-cache prefix stays stable across turns.
 */

import type { ToolDefinition } from "../../providers/types.js";
import { TASK_PROGRESS_TEMPLATE_SHAPE } from "./surface-shape-docs.js";

const SLACK_UI_SHOW_DESCRIPTION = `Show a live task-progress card for the current work — the only surface this channel renders. data: { template: "task_progress", templateData: ${TASK_PROGRESS_TEMPLATE_SHAPE} }. Show it early on multi-step turns and advance step statuses via ui_update as work progresses.`;

const SLACK_UI_SHOW_INPUT_SCHEMA = {
  type: "object",
  properties: {
    surface_type: {
      type: "string",
      enum: ["card"],
      description: "Always card on this channel",
    },
    title: {
      type: "string",
      description: "Optional surface title",
    },
    data: {
      type: "object",
      description:
        'Card data: { template: "task_progress", templateData: { title, status, steps } }',
    },
  },
  required: ["surface_type", "data"],
};

/**
 * Swap UI surface tool definitions for channel-appropriate variants. Returns
 * the input array unchanged (same identity) for channels without a variant.
 */
export function projectUiToolsForChannel(
  definitions: ToolDefinition[],
  channel: string | undefined,
): ToolDefinition[] {
  if (channel !== "slack") {
    return definitions;
  }
  return definitions.map((def) =>
    def.name === "ui_show"
      ? {
          ...def,
          description: SLACK_UI_SHOW_DESCRIPTION,
          input_schema: SLACK_UI_SHOW_INPUT_SCHEMA,
        }
      : def,
  );
}
