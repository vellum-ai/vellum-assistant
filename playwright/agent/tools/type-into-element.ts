/**
 * Click a UI element to focus it, then type text into it.
 *
 * Uses the ax-helper binary to click the element by ID and paste text
 * via clipboard for reliability.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright";

import { runAXHelper } from "./ax-helper";
import type { ToolContext, ToolHandlerResult } from "./types";

export const definition: Anthropic.Tool = {
  name: "type_into_element",
  description:
    "Click on a UI element to focus it, then type text into it. The text is pasted via clipboard for reliability.",
  input_schema: {
    type: "object" as const,
    properties: {
      element_id: {
        type: "integer",
        description: "The element ID from query_elements output.",
      },
      text: {
        type: "string",
        description: "The text to type into the element.",
      },
    },
    required: ["element_id", "text"],
  },
};

export async function execute(
  _page: Page,
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolHandlerResult> {
  const elementId = input.element_id as number;
  const text = input.text as string;
  const result = runAXHelper(
    "type",
    ["--id", String(elementId), "--text", text],
    context,
  );
  return {
    result: { success: result.success, data: result.data },
  };
}
