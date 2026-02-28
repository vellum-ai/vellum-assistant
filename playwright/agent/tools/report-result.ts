/**
 * Report the final test result.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright";

import type { ToolContext, ToolHandlerResult } from "./types";

export const definition: Anthropic.Tool = {
  name: "report_result",
  description:
    "Report the final test result. You MUST call this exactly once when you have completed all test steps and verified all expected outcomes.",
  input_schema: {
    type: "object" as const,
    properties: {
      passed: {
        type: "boolean",
        description: "Whether the test passed",
      },
      message: {
        type: "string",
        description:
          "A short summary of the test outcome (e.g. 'All steps completed successfully' or 'Button not found').",
      },
      reasoning: {
        type: "string",
        description:
          "Detailed step-by-step reasoning for why the test passed or failed. Include what you observed at each step, what you expected to see, and where things diverged if the test failed.",
      },
    },
    required: ["passed", "message", "reasoning"],
  },
};

export async function execute(
  _page: Page,
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolHandlerResult> {
  return {
    result: { success: true, data: "Test result reported" },
    testResult: {
      passed: input.passed as boolean,
      message: input.message as string,
      reasoning: input.reasoning as string,
    },
  };
}
