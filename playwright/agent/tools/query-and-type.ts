/**
 * Query the AX tree, find an input element, and type text into it in one step.
 *
 * Combines query_elements + click + type into a single tool call. Matches
 * elements by title or placeholder text (case-insensitive substring).
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright";

import { runAXHelper } from "./ax-helper";
import type { ToolContext, ToolHandlerResult } from "./types";

export const definition: Anthropic.Tool = {
  name: "query_and_type",
  description:
    "Query the AX tree, find an input element matching a title/placeholder, click it, and type text. Saves multiple round trips.",
  input_schema: {
    type: "object" as const,
    properties: {
      title: {
        type: "string",
        description:
          "Text to match in the element title or placeholder (case-insensitive substring).",
      },
      text: {
        type: "string",
        description: "The text to type into the matched element.",
      },
      app_name: {
        type: "string",
        description: "App name to query. Defaults to the test app.",
      },
    },
    required: ["title", "text"],
  },
};

export async function execute(
  _page: Page,
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolHandlerResult> {
  const args: string[] = [
    "--title", input.title as string,
    "--text", input.text as string,
  ];
  if (input.app_name) {
    args.push("--app", input.app_name as string);
  }

  const result = runAXHelper("query-and-type", args, context);
  return {
    result: { success: result.success, data: result.data },
  };
}
