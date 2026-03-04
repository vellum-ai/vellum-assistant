/**
 * Take a screenshot of the macOS screen via screencapture.
 *
 * We use the system screencapture command rather than page.screenshot()
 * because the agent tests interact with native macOS desktop apps via
 * AppleScript/System Events — the Playwright browser page is just a
 * blank tab used for web-based tool calls.
 */

import { execFileSync } from "child_process";
import { mkdirSync } from "fs";

import type Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright";

import type { ToolContext, ToolHandlerResult } from "./types";

export const definition: Anthropic.Tool = {
  name: "screenshot",
  description:
    "Take a screenshot of the current macOS screen. Returns the file path of the saved screenshot.",
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
  _page: Page,
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolHandlerResult> {
  mkdirSync(context.screenshotDir, { recursive: true });
  const index = String(context.screenshotCounter.value++).padStart(3, "0");
  const filePath = `${context.screenshotDir}/${index}-${input.name as string}.png`;
  try {
    execFileSync("screencapture", ["-x", filePath], { timeout: 10_000 });
    return {
      result: { success: true, data: `Screenshot saved to ${filePath}` },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      result: { success: false, data: `screencapture failed: ${message}` },
    };
  }
}
