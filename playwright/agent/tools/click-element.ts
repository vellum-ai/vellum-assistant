/**
 * Click a UI element by its stable ID from query_elements.
 *
 * Uses the ax-helper binary to read the element's cached coordinates
 * and perform a click via CGEvent.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright";

import { runAXHelper } from "./ax-helper";
import type { ToolContext, ToolHandlerResult } from "./types";

export const definition: Anthropic.Tool = {
  name: "click_element",
  description:
    "Click on a UI element by its ID (from query_elements). Use this instead of AppleScript for clicking buttons, checkboxes, etc.",
  input_schema: {
    type: "object" as const,
    properties: {
      element_id: {
        type: "integer",
        description: "The element ID from query_elements output.",
      },
    },
    required: ["element_id"],
  },
};

export async function execute(
  _page: Page,
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolHandlerResult> {
  const elementId = input.element_id as number;
  const result = runAXHelper("click", ["--id", String(elementId)], context);
  return {
    result: { success: result.success, data: result.data },
  };
}
