/**
 * Take a screenshot of the current page.
 */

import { mkdirSync } from "fs";

import type Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright";

import type { ToolContext, ToolHandlerResult } from "./types";

export const definition: Anthropic.Tool = {
  name: "screenshot",
  description:
    "Take a screenshot of the current page. Returns the file path of the saved screenshot.",
  input_schema: {
    type: "object" as const,
    properties: {
      name: {
        type: "string",
        description: "Name for the screenshot file (without extension)",
      },
    },
    required: ["name"],
  },
};

export async function execute(
  page: Page,
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolHandlerResult> {
  mkdirSync(context.screenshotDir, { recursive: true });
  const filePath = `${context.screenshotDir}/${input.name as string}.png`;
  await page.screenshot({ path: filePath });
  return {
    result: { success: true, data: `Screenshot saved to ${filePath}` },
  };
}
