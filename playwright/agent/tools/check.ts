/**
 * Check a checkbox element.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright";

import type { ToolContext, ToolHandlerResult } from "./types";

export const definition: Anthropic.Tool = {
  name: "check",
  description: "Check a checkbox element matching the given CSS selector.",
  input_schema: {
    type: "object" as const,
    properties: {
      selector: {
        type: "string",
        description: "CSS selector for the checkbox element",
      },
    },
    required: ["selector"],
  },
};

export async function execute(
  page: Page,
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolHandlerResult> {
  await page.check(input.selector as string);
  return {
    result: { success: true, data: `Checked checkbox: ${input.selector}` },
  };
}
