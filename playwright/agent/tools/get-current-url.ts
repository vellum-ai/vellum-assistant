/**
 * Get the current page URL.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright";

import type { ToolContext, ToolHandlerResult } from "./types";

export const definition: Anthropic.Tool = {
  name: "get_current_url",
  description: "Get the current page URL.",
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
  return {
    result: { success: true, data: page.url() },
  };
}
