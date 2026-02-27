/**
 * Run an AppleScript via osascript and return the result.
 */

import { execSync } from "child_process";
import { writeFileSync } from "fs";

import type Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright";

import type { ToolContext, ToolHandlerResult } from "./types";

export const definition: Anthropic.Tool = {
  name: "applescript",
  description:
    "Run an AppleScript via osascript and return its output. Use this to interact with macOS native applications via System Events (clicking buttons, typing text, reading accessibility tree, etc.).",
  input_schema: {
    type: "object" as const,
    properties: {
      script: {
        type: "string",
        description: "The AppleScript source code to execute",
      },
    },
    required: ["script"],
  },
};

export async function execute(
  _page: Page,
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolHandlerResult> {
  const script = input.script as string;
  const scriptPath = "/tmp/pw-agent-applescript.scpt";
  try {
    writeFileSync(scriptPath, script, "utf-8");
    const output = execSync(`osascript ${scriptPath}`, {
      encoding: "utf-8",
      timeout: 30_000,
    }).trim();
    return {
      result: { success: true, data: output || "(no output)" },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      result: { success: false, data: `AppleScript failed: ${message}` },
    };
  }
}
