/**
 * Click an element on the page.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright";

import type { ToolContext, ToolHandlerResult } from "./types";

export const definition: Anthropic.Tool = {
  name: "click",
  description: "Click an element matching the given CSS selector.",
  input_schema: {
    type: "object" as const,
    properties: {
      selector: {
        type: "string",
        description: "CSS selector for the element to click",
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
  await page.click(input.selector as string);
  return {
    result: { success: true, data: `Clicked element: ${input.selector}` },
  };
}
