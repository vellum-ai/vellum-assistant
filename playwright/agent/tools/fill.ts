/**
 * Fill an input field with text.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright";

import type { ToolContext, ToolHandlerResult } from "./types";

export const definition: Anthropic.Tool = {
  name: "fill",
  description: "Fill an input field with the given text value.",
  input_schema: {
    type: "object" as const,
    properties: {
      selector: {
        type: "string",
        description: "CSS selector for the input element",
      },
      value: {
        type: "string",
        description: "The text to fill into the input",
      },
    },
    required: ["selector", "value"],
  },
};

export async function execute(
  page: Page,
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolHandlerResult> {
  await page.fill(input.selector as string, input.value as string);
  return {
    result: {
      success: true,
      data: `Filled "${input.selector}" with "${input.value}"`,
    },
  };
}
