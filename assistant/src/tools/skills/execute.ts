import { RiskLevel } from "../../permissions/types.js";
import { registerTool } from "../registry.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../types.js";

export const skillExecuteTool = {
  name: "skill_execute",
  description:
    "Execute a tool provided by a loaded skill. Use this instead of calling skill tools directly. The skill's instructions (from skill_load) describe available tools and their parameters. For browser automation, use the `assistant browser` CLI commands instead.",
  category: "skills",
  executionTarget: "sandbox",
  defaultRiskLevel: RiskLevel.Low,

  input_schema: {
    type: "object",
    properties: {
      tool: {
        type: "string",
        description:
          "The skill tool name to execute (e.g. 'task_create', 'deploy_run')",
      },
      input: {
        type: "object",
        description:
          "Tool-specific parameters as documented in the skill's instructions",
      },
      activity: {
        type: "string",
        description:
          "Brief non-technical explanation of what you are doing and why, shown as a progress update.",
      },
    },
    required: ["tool", "input", "activity"],
  },

  async execute(
    _input: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolExecutionResult> {
    return {
      content:
        "skill_execute should be intercepted at session level. If you see this error, the session dispatch is not configured.",
      isError: true,
    };
  },
} satisfies ToolDefinition;

registerTool(skillExecuteTool);
