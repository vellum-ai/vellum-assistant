/**
 * Get the full text content of the page body.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright";

import type { ToolContext, ToolHandlerResult } from "./types";

export const definition: Anthropic.Tool = {
  name: "get_page_content",
  description: "Get the full text content of the page body.",
  input_schema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
};

export async function execute(
  page: Page,
  _input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolHandlerResult> {
  const bodyText = await page.textContent("body");
  return {
    result: { success: true, data: bodyText ?? "" },
  };
}
