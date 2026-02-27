/**
 * Wait for a specified number of milliseconds.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright";

import type { ToolContext, ToolHandlerResult } from "./types";

export const definition: Anthropic.Tool = {
  name: "wait",
  description: "Wait for a specified number of milliseconds before continuing.",
  input_schema: {
    type: "object" as const,
    properties: {
      ms: {
        type: "number",
        description: "Number of milliseconds to wait",
      },
    },
    required: ["ms"],
  },
};

export async function execute(
  _page: Page,
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolHandlerResult> {
  const ms = input.ms as number;
  await new Promise((resolve) => setTimeout(resolve, ms));
  return {
    result: { success: true, data: `Waited ${ms}ms` },
  };
}
