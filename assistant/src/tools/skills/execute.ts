import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import { registerTool } from "../registry.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";

export class SkillExecuteTool implements Tool {
  name = "skill_execute";
  description =
    "Execute a tool provided by a loaded skill. Use this instead of calling skill tools directly. The skill's instructions (from skill_load) describe available tools and their parameters.";
  category = "skills";
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          tool: {
            type: "string",
            description:
              "The skill tool name to execute (e.g. 'browser_navigate', 'task_create')",
          },
          input: {
            type: "object",
            description:
              "Tool-specific parameters as documented in the skill's instructions",
          },
          activity: {
            type: "string",
            description:
              "Brief non-technical explanation of what you are doing and why, shown to the user as a status update.",
          },
        },
        required: ["tool", "input"],
      },
    };
  }

  async execute(
    _input: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolExecutionResult> {
    return {
      content:
        "skill_execute should be intercepted at session level. If you see this error, the session dispatch is not configured.",
      isError: true,
    };
  }
}

export const skillExecuteTool = new SkillExecuteTool();
registerTool(skillExecuteTool);
