/**
 * Query the AX tree and click an element matching a title/role in one step.
 *
 * Combines query_elements + click_element into a single tool call to
 * save a round trip. If the element is not found, returns the current
 * tree so the agent can see what's available.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright";

import { runAXHelper } from "./ax-helper";
import type { ToolContext, ToolHandlerResult } from "./types";

export const definition: Anthropic.Tool = {
  name: "query_and_click",
  description:
    "Query the AX tree and click an element matching a title/role in one step. Saves a round trip vs query_elements + click_element. If the element is not found, returns the current tree.",
  input_schema: {
    type: "object" as const,
    properties: {
      title: {
        type: "string",
        description:
          "Text to match in the element title (case-insensitive substring match).",
      },
      role: {
        type: "string",
        description:
          "Optional AX role to filter by (e.g. 'button', 'text field'). Matched after stripping 'AX' prefix and lowercasing.",
      },
      app_name: {
        type: "string",
        description: "App name to query. Defaults to the test app.",
      },
    },
    required: ["title"],
  },
};

export async function execute(
  _page: Page,
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolHandlerResult> {
  const args: string[] = ["--title", input.title as string];
  if (input.role) {
    args.push("--role", input.role as string);
  }
  if (input.app_name) {
    args.push("--app", input.app_name as string);
  }

  const result = runAXHelper("query-and-click", args, context);
  return {
    result: { success: result.success, data: result.data },
  };
}
