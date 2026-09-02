import { z } from "zod";

import { RiskLevel } from "../../permissions/types.js";
import {
  invalidToolInputResult,
  toToolInputSchema,
} from "../shared/zod-tool-schema.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../types.js";

/**
 * How a watch retrospective hands its report to the daemon.
 *
 * **The card cannot come from `ui_show`.** A retrospective runs as a
 * `clientless` wake, which pins the turn non-interactive, and
 * `conversation-tool-setup` gates the whole `ui_surface` tool family on a
 * client being present (`return channelCapabilities?.supportsDynamicUi ??
 * !hasNoClient`). So `ui_show` is not merely denied in this turn, it is absent
 * from the tool set, and a retrospective told to call it can only report that
 * it cannot. This tool is an ordinary one and passes that gate untouched.
 *
 * **It records; it does not render.** The executor validates the payload and
 * returns, and nothing here writes to the conversation. What makes the card is
 * `watch-retro.ts` reading this call back out of the turn's own history once
 * the turn has finished, and appending the `ui_surface` block itself. Two
 * reasons for the split. A surface appended from inside the turn can land
 * between a persisted `tool_use` and its `tool_result`, which is the ordering
 * hazard the memory retrospective's skill card defers around
 * (`memory-retrospective-skill-card.ts`); waiting until the turn is over avoids
 * it rather than detecting it. And the report is then held in the one place
 * that survives a crash between the call and the append: the transcript.
 *
 * **Validation is the model-facing half.** The payload is the card's own
 * schema, so a shape the renderer could not draw is refused here, while the
 * model still has a turn left to correct it. The daemon parses it again before
 * appending, since a tool result is not a promise about what was persisted.
 */
export const watchRetroReportInputSchema = z.looseObject({
  task: z.string(),
  purpose: z.string().optional().catch(undefined),
  steps: z.array(z.string()).optional().catch(undefined),
  eyebrow: z.string().optional().catch(undefined),
  coverage: z.string().optional().catch(undefined),
  questions: z.array(z.unknown()).optional().catch(undefined),
});

export async function executeWatchRetroReport(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const parsed = watchRetroReportInputSchema.safeParse(input);
  if (!parsed.success) {
    return invalidToolInputResult("watch_retro_report", parsed.error);
  }
  const { task, steps } = parsed.data;
  if (!task || task.trim().length === 0) {
    return {
      content: '"task" is required: name the task the session recorded.',
      isError: true,
    };
  }
  // A record with no steps is not a record. The questions are optional and the
  // rest is decoration, but a card whose first page is a bare title tells the
  // user nothing about the session they just finished.
  if (!steps || steps.length === 0) {
    return {
      content:
        '"steps" is required: list what you saw, in order, as short imperative fragments.',
      isError: true,
    };
  }
  return {
    content: JSON.stringify({ recorded: true, steps: steps.length }),
    isError: false,
  };
}

export const watchRetroReportTool = {
  name: "watch_retro_report",
  // Deliberately terse, field descriptions included: this tool is always
  // registered, so every byte here is spent on every request, and the payload
  // contract is carried by the retrospective prompt, which is the only caller.
  // `browser-skill-baseline-tool-payload` holds the total to a budget.
  description:
    "Report what a Watch (teach mode) session recorded. Only from a watch retrospective, which gives the payload shape.",
  category: "ui-surface",
  executionTarget: "sandbox",
  defaultRiskLevel: RiskLevel.Low,

  input_schema: toToolInputSchema(watchRetroReportInputSchema, {
    advertiseRequired: ["task", "steps"],
  }),

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    return executeWatchRetroReport(input, context);
  },
} satisfies ToolDefinition;
