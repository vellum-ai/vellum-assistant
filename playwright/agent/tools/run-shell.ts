/**
 * Run a shell command and return its output.
 */

import { execSync } from "child_process";

import type Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright";

import type { ToolContext, ToolHandlerResult } from "./types";

export const definition: Anthropic.Tool = {
  name: "run_shell",
  description:
    "Run a shell command and return its stdout. Useful for launching apps, running osascript, clearing defaults, etc.",
  input_schema: {
    type: "object" as const,
    properties: {
      command: {
        type: "string",
        description: "The shell command to execute",
      },
      timeout_ms: {
        type: "number",
        description: "Timeout in milliseconds (default: 30000)",
      },
    },
    required: ["command"],
  },
};

export async function execute(
  _page: Page,
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolHandlerResult> {
  const command = input.command as string;
  const timeoutMs = (input.timeout_ms as number) ?? 30_000;
  try {
    const output = execSync(command, {
      encoding: "utf-8",
      timeout: timeoutMs,
    }).trim();
    return {
      result: { success: true, data: output || "(no output)" },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      result: { success: false, data: `Shell command failed: ${message}` },
    };
  }
}
