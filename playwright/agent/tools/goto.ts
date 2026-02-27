/**
 * Navigate the browser to a URL.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright";

import type { ToolContext, ToolHandlerResult } from "./types";

export const definition: Anthropic.Tool = {
  name: "goto",
  description:
    "Navigate the browser to a URL. Returns the HTTP status code of the response.",
  input_schema: {
    type: "object" as const,
    properties: {
      url: { type: "string", description: "The URL to navigate to" },
    },
    required: ["url"],
  },
};

export async function execute(
  page: Page,
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolHandlerResult> {
  const response = await page.goto(input.url as string);
  const status = response?.status() ?? 0;
  return {
    result: { success: true, data: `Navigated to ${input.url} (status: ${status})` },
  };
}
