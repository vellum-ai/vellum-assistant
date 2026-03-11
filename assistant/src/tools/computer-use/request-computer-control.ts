/**
 * computer_use_request_control tool definition.
 *
 * This tool allows a text_qa session to escalate to foreground computer use
 * when the user explicitly requests it (e.g. "go ahead and do it", "take over
 * for 20 seconds"). It is a proxy tool — execution is handled by the session's
 * surfaceProxyResolver, which creates a CU session and sends a task_routed
 * message to the client.
 *
 * This tool is only available to text_qa sessions. It must NOT be added to
 * CU sessions (that would be recursive).
 *
 * Part of the bundled computer-use skill. The definition here is imported by
 * buildToolDefinitions() so text_qa sessions can include it without
 * preactivating the entire skill.
 */

import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import type { Tool, ToolExecutionResult } from "../types.js";

export const requestComputerControlTool: Tool = {
  name: "computer_use_request_control",
  description:
    "Escalate to foreground computer use. Call this when the user explicitly asks you to " +
    'take control of their computer to perform a task (e.g. "go ahead and do it", ' +
    '"take over", "open that for me"). Provide a concise description of the task ' +
    "that computer use should accomplish.",
  category: "computer-use",
  defaultRiskLevel: RiskLevel.Low,
  executionMode: "proxy",

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description:
              "Concise description of what computer use should accomplish",
          },
        },
        required: ["task"],
      },
    };
  },

  execute(): Promise<ToolExecutionResult> {
    throw new Error(
      "Proxy tool: execution must be forwarded via surfaceProxyResolver",
    );
  },
};
