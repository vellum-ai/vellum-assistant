/**
 * Get the text content of an element.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright";

import type { ToolContext, ToolHandlerResult } from "./types";

export const definition: Anthropic.Tool = {
  name: "get_text",
  description:
    "Get the text content of an element matching the given CSS selector.",
  input_schema: {
    type: "object" as const,
    properties: {
      selector: {
        type: "string",
        description: "CSS selector for the element",
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
  const text = await page.textContent(input.selector as string);
  return {
    result: { success: true, data: text ?? "" },
  };
}
