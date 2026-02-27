/**
 * Retrieve the Anthropic API key from the environment.
 *
 * This tool allows the agent to access the API key at runtime without
 * it being embedded in the markdown test case or prompt. The key is
 * read from the ANTHROPIC_API_KEY environment variable.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright";

import type { ToolContext, ToolHandlerResult } from "./types";

export const definition: Anthropic.Tool = {
  name: "get_anthropic_api_key",
  description:
    "Retrieve the Anthropic API key from the environment. Use this when a test step requires entering an API key.",
  input_schema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
};

export async function execute(
  _page: Page,
  _input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolHandlerResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  if (!apiKey) {
    return {
      result: { success: false, data: "ANTHROPIC_API_KEY environment variable is not set" },
    };
  }
  return {
    result: { success: true, data: apiKey },
  };
}
