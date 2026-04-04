/**
 * background_tool_control — manage background tool executions that exceeded
 * the deferral threshold.
 *
 * This is a core infrastructure tool (like CES tools) that requires deep
 * integration with the agent loop for managing deferred tool executions.
 * It is registered as a non-skill tool behind the `tool-deferral` feature flag.
 */

import { backgroundToolManager } from "../agent/background-tool-manager.js";
import { getConfig } from "../config/loader.js";
import { RiskLevel } from "../permissions/types.js";
import type { ToolDefinition } from "../providers/types.js";
import type { Tool, ToolContext, ToolExecutionResult } from "./types.js";

const TOOL_NAME = "background_tool_control";

const TOOL_DESCRIPTION =
  "Manage background tool executions that exceeded the deferral threshold. Use 'wait' to check on or wait for a result, or 'cancel' to terminate a running execution.";

class BackgroundToolControlTool implements Tool {
  name = TOOL_NAME;
  description = TOOL_DESCRIPTION;
  category = "system";
  defaultRiskLevel = RiskLevel.Low;
  deferralExempt = true;

  getDefinition(): ToolDefinition {
    return {
      name: TOOL_NAME,
      description: TOOL_DESCRIPTION,
      input_schema: {
        type: "object",
        properties: {
          execution_id: {
            type: "string",
            description: "The execution ID of the background tool to manage",
          },
          action: {
            type: "string",
            enum: ["wait", "cancel"],
            description:
              "Action to take: 'wait' to check status or wait for completion, 'cancel' to abort the execution",
          },
          wait_seconds: {
            type: "number",
            description:
              "For 'wait' action: how many seconds to wait for the tool to complete. If omitted, returns current status immediately. Short waits (\u2264 deferral threshold) block; longer waits schedule a deferred check-in.",
          },
        },
        required: ["execution_id", "action"],
      },
    };
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const executionId = input.execution_id as string;
    const action = input.action as string;
    const waitSeconds = input.wait_seconds as number | undefined;

    // Verify the execution exists and belongs to this conversation
    const status = backgroundToolManager.getStatus(executionId);
    if (!status) {
      return {
        content: `No execution found with ID ${executionId}`,
        isError: true,
      };
    }
    if (status.conversationId !== context.conversationId) {
      return {
        content: `Execution ${executionId} does not belong to this conversation`,
        isError: true,
      };
    }

    if (action === "cancel") {
      const result = backgroundToolManager.cancel(executionId);
      return {
        content: result.message,
        isError: !result.cancelled,
      };
    }

    if (action === "wait") {
      // Immediate status check (no wait_seconds or 0)
      if (waitSeconds === undefined || waitSeconds === 0) {
        if (status.status === "completed" && status.result) {
          return {
            content: `Execution ${executionId} completed:\n${status.result.content}`,
            isError: status.result.isError,
          };
        }
        return {
          content: `Execution ${executionId} is ${status.status} (elapsed: ${Math.round(status.elapsedMs / 1000)}s)`,
          isError: false,
        };
      }

      // Determine the deferral threshold
      const config = getConfig();
      const thresholdSec = config.timeouts.toolDeferralThresholdSec;

      if (waitSeconds <= thresholdSec) {
        // Short wait — block and return result
        const waitResult = await backgroundToolManager.waitFor(
          executionId,
          waitSeconds * 1000,
        );
        if (waitResult.completed && waitResult.result) {
          return {
            content: `Execution ${executionId} completed:\n${waitResult.result.content}`,
            isError: waitResult.result.isError,
          };
        }
        return {
          content: `Execution ${executionId} is still running after waiting ${waitSeconds}s`,
          isError: false,
        };
      }

      // Long wait — but if already terminal, return immediately
      if (status.status === "completed" && status.result) {
        return {
          content: `Execution ${executionId} completed:\n${status.result.content}`,
          isError: status.result.isError,
        };
      }
      if (status.status === "cancelled") {
        return {
          content: `Execution ${executionId} was cancelled`,
          isError: false,
        };
      }

      // Still running — schedule deferred check-in
      return {
        content: `Deferred check-in scheduled for execution ${executionId} in ${waitSeconds}s`,
        isError: false,
        scheduleCheckIn: {
          afterSeconds: waitSeconds,
          executionId,
          conversationId: context.conversationId,
        },
      };
    }

    return {
      content: `Unknown action: ${action}. Valid actions are 'wait' and 'cancel'.`,
      isError: true,
    };
  }
}

export const backgroundToolControlTool = new BackgroundToolControlTool();
