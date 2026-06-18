/**
 * The `advisor` tool — a no-argument tool the model calls to consult a stronger
 * model for strategic guidance. The model supplies no input; the plugin reads
 * the transcript captured by the lifecycle hooks and runs the consult, routed
 * through the assistant's own inference.
 *
 * Default export = the tool definition. `defaults/index.ts` finalizes it and
 * attaches it to the advisor plugin's `tools` array, which `bootstrapPlugins`
 * registers into the model-visible tool catalog.
 */

import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "@vellumai/plugin-api";
import { RiskLevel } from "@vellumai/plugin-api";

import { getCapture } from "../advisor-state-store.js";
import { consultAdvisor } from "../consult.js";

const advisorTool: ToolDefinition = {
  name: "advisor",
  description:
    "Consult a stronger advisor model to shape your plan and get strategic guidance. " +
    "Takes NO parameters — your full conversation (the task, every tool call, and every " +
    "result) is forwarded automatically. Call it BEFORE you start building: it can lay out " +
    "a plan when you don't have one yet, or review and sharpen the plan you've already " +
    "drafted. Also call it when you're stuck, when weighing a change in approach, and once " +
    "before declaring a task complete. Give its guidance serious weight.",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
  // Read-only advice; low risk so the consult isn't gated behind a prompt.
  defaultRiskLevel: RiskLevel.Low,
  async execute(
    _input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolExecutionResult> {
    try {
      const capture = getCapture(ctx.conversationId);
      const advice = await consultAdvisor({
        systemPrompt: capture?.systemPrompt ?? null,
        messages: capture?.messages ?? [],
        signal: ctx.signal,
      });
      return { content: advice, isError: false };
    } catch (err) {
      // Degrade like the advisor tool: never fail the turn over a consult.
      const reason = err instanceof Error ? err.message : String(err);
      return { content: `(advisor unavailable: ${reason})`, isError: false };
    }
  },
};

export default advisorTool;
