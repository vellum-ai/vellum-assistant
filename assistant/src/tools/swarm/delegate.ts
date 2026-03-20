import { getConfig } from "../../config/loader.js";
import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";

export const swarmDelegateTool: Tool = {
  name: "swarm_delegate",
  description:
    "Decompose a complex task into parallel specialist subtasks and execute them concurrently. Use this for multi-part tasks that benefit from parallel research, coding, and review.",
  category: "orchestration",
  defaultRiskLevel: RiskLevel.Medium,

  getDefinition(): ToolDefinition {
    return {
      name: "swarm_delegate",
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          objective: {
            type: "string",
            description:
              "The complex task to decompose and execute in parallel",
          },
          context: {
            type: "string",
            description:
              "Optional additional context about the task or codebase",
          },
          max_workers: {
            type: "number",
            description:
              "Maximum concurrent workers (1-6, default from config)",
          },
        },
        required: ["objective"],
      },
    };
  },

  async execute(
    _input: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolExecutionResult> {
    // Check if swarm is enabled
    const config = getConfig();
    if (!config.swarm.enabled) {
      return {
        content:
          "Swarm orchestration is disabled in config (swarm.enabled = false). Execute the task directly instead.",
        isError: false,
      };
    }

    return {
      content:
        "Swarm orchestration is currently unavailable: no worker backend is configured.",
      isError: true,
    };
  },
};
