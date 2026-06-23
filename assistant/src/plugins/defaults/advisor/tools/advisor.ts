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

import { advisorEnabledForProfile } from "../advisor-gate.js";
import { getCapture } from "../advisor-state-store.js";
import { consultAdvisor } from "../consult.js";
import { buildAdvisorContext } from "../context-pack.js";

const advisorTool: ToolDefinition = {
  name: "advisor",
  description:
    "Consult a stronger advisor model to shape your plan and get strategic guidance. " +
    "Takes NO parameters — your full conversation (the task, every tool call, and every " +
    "result) is forwarded automatically, along with your available tools and skills, the " +
    "workspace/project context, and relevant memory. Call it BEFORE you start building: it " +
    "can lay out a plan when you don't have one yet, or review and sharpen the plan you've " +
    "already drafted. Also call it when you're stuck, when weighing a change in approach, and " +
    "once before declaring a task complete. It runs on its own — if you call it alongside " +
    "other tools, those are held back until you've seen its guidance. Give its guidance " +
    "serious weight.",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
  // Read-only advice; low risk so the consult isn't gated behind a prompt.
  defaultRiskLevel: RiskLevel.Low,
  // Runs alone in its turn: the loop defers any sibling tool calls so the model
  // incorporates the advisor's guidance before acting on anything else.
  exclusive: true,
  async execute(
    _input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolExecutionResult> {
    // Defense-in-depth: the steering is already gated per profile, but a model
    // could still call the tool. Honor the chat profile this turn runs under —
    // the per-turn override (per-conversation / profile-session) when present,
    // else the workspace active profile.
    if (!advisorEnabledForProfile(ctx.overrideProfile ?? null)) {
      return {
        content: "(advisor is disabled for the active profile)",
        isError: false,
      };
    }
    try {
      const capture = getCapture(ctx.conversationId);
      const messages = capture?.messages ?? [];
      // Gather the agent's situational context (tools, skills, workspace,
      // memory) so the advisor reasons with the same awareness the agent has.
      // Best-effort: a failure here must not block the consult.
      const runtimeContext = await buildAdvisorContext({
        conversationId: ctx.conversationId,
        workingDir: ctx.workingDir,
        allowedToolNames: ctx.allowedToolNames,
        trustClass: ctx.trustClass,
        transcript: messages,
        signal: ctx.signal,
      }).catch(() => null);
      const advice = await consultAdvisor({
        systemPrompt: capture?.systemPrompt ?? null,
        messages,
        runtimeContext,
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
