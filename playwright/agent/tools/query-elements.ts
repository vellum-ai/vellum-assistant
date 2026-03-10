/**
 * Query the accessibility tree of the macOS application.
 *
 * Returns a compact, structured summary of interactive elements with stable
 * IDs that can be used with click_element and type_into_element. Uses the
 * ax-helper binary for direct AXUIElement API access.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright";

import { runAXHelper } from "./ax-helper";
import type { ToolContext, ToolHandlerResult } from "./types";

export const definition: Anthropic.Tool = {
  name: "query_elements",
  description:
    "Query the accessibility tree of the macOS application to discover interactive elements. Returns a list of elements with IDs that can be used with click_element and type_into_element. Call this first before interacting with the UI.",
  input_schema: {
    type: "object" as const,
    properties: {
      app_name: {
        type: "string",
        description:
          "Name of the app to query. Defaults to the test app.",
      },
    },
    required: [],
  },
};

export async function execute(
  _page: Page,
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolHandlerResult> {
  const args: string[] = [];
  if (input.app_name) {
    args.push("--app", input.app_name as string);
  }

  const result = runAXHelper("query", args, context);
  return {
    result: { success: result.success, data: result.data },
  };
}
