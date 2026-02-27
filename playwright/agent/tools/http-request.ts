/**
 * Make an HTTP request and return the response body.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright";

import type { ToolContext, ToolHandlerResult } from "./types";

export const definition: Anthropic.Tool = {
  name: "http_request",
  description:
    "Make an HTTP request and return the response body. Useful for fetching data from APIs.",
  input_schema: {
    type: "object" as const,
    properties: {
      url: { type: "string", description: "The URL to request" },
      method: {
        type: "string",
        description: "HTTP method (default: GET)",
      },
    },
    required: ["url"],
  },
};

export async function execute(
  _page: Page,
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolHandlerResult> {
  const method = (input.method as string) ?? "GET";
  const response = await fetch(input.url as string, { method });
  const body = await response.text();
  return {
    result: { success: true, data: body },
  };
}
