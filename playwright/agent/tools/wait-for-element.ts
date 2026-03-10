/**
 * Wait for a UI element to appear in the accessibility tree.
 *
 * Polls the AX tree at intervals until an element matching the given
 * title (and optional role) appears, or the timeout is reached. This
 * eliminates the manual wait -> query -> check cycle.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright";

import { runAXHelper } from "./ax-helper";
import type { ToolContext, ToolHandlerResult } from "./types";

export const definition: Anthropic.Tool = {
  name: "wait_for_element",
  description:
    "Wait for a UI element matching a title (and optional role) to appear in the accessibility tree. Polls every second until the element appears or the timeout is reached. Returns the element tree when found.",
  input_schema: {
    type: "object" as const,
    properties: {
      title: {
        type: "string",
        description:
          "Text to match in the element title (case-insensitive substring).",
      },
      role: {
        type: "string",
        description:
          "Optional AX role to filter by (e.g. 'button', 'text field').",
      },
      timeout_ms: {
        type: "integer",
        description:
          "Maximum time to wait in milliseconds. Default: 5000.",
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
  const title = input.title as string;
  const role = input.role as string | undefined;
  const timeoutMs = (input.timeout_ms as number) ?? 5000;
  const pollIntervalMs = 1000;
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const queryArgs: string[] = [];
    if (input.app_name) {
      queryArgs.push("--app", input.app_name as string);
    }
    const queryResult = runAXHelper("query", queryArgs, context);

    if (queryResult.success) {
      const searchLower = title.toLowerCase();
      const dataLower = queryResult.data.toLowerCase();
      if (dataLower.includes(searchLower)) {
        if (role) {
          const roleLower = role.toLowerCase();
          const lines = queryResult.data.split("\n");
          const matchingLine = lines.find((line) => {
            const lineLower = line.toLowerCase();
            return lineLower.includes(searchLower) && lineLower.includes(roleLower);
          });
          if (matchingLine) {
            return {
              result: { success: true, data: `Element found after ${Date.now() - startTime}ms.\n${queryResult.data}` },
            };
          }
        } else {
          return {
            result: { success: true, data: `Element found after ${Date.now() - startTime}ms.\n${queryResult.data}` },
          };
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  // Final attempt — return the tree for debugging
  const finalQueryArgs: string[] = [];
  if (input.app_name) {
    finalQueryArgs.push("--app", input.app_name as string);
  }
  const finalQuery = runAXHelper("query", finalQueryArgs, context);
  const treeInfo = finalQuery.success ? `\nCurrent tree:\n${finalQuery.data}` : "";

  return {
    result: {
      success: false,
      data: `Element matching '${title}' not found after ${timeoutMs}ms.${treeInfo}`,
    },
  };
}
