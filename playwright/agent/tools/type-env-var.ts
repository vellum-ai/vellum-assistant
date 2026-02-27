/**
 * Type the value of an environment variable into the focused input field.
 *
 * This tool resolves an environment variable at runtime and types its value
 * via AppleScript keystroke, without ever exposing the secret value in the
 * tool result or conversation context. Use this when a test step requires
 * entering a secret (e.g., an API key).
 */

import { execSync } from "child_process";
import { writeFileSync } from "fs";

import type Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright";

import type { ToolContext, ToolHandlerResult } from "./types";

export const definition: Anthropic.Tool = {
  name: "type_env_var",
  description:
    "Type the value of an environment variable into the currently focused input field using AppleScript keystroke. The secret value is never returned in the tool result. Use this for entering API keys or other secrets.",
  input_schema: {
    type: "object" as const,
    properties: {
      env_var: {
        type: "string",
        description:
          "The name of the environment variable to type (e.g., ANTHROPIC_API_KEY)",
      },
      process_name: {
        type: "string",
        description:
          "The name of the macOS process to type into (e.g., Vellum)",
      },
    },
    required: ["env_var", "process_name"],
  },
};

export async function execute(
  _page: Page,
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolHandlerResult> {
  const envVar = input.env_var as string;
  const processName = input.process_name as string;
  const value = process.env[envVar] ?? "";

  if (!value) {
    return {
      result: {
        success: false,
        data: `Environment variable ${envVar} is not set`,
      },
    };
  }

  const script = `
tell application "System Events"
  tell process "${processName}"
    set frontmost to true
    delay 0.5
    keystroke "${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"
  end tell
end tell
`;

  const scriptPath = "/tmp/pw-agent-type-env-var.scpt";
  try {
    writeFileSync(scriptPath, script, "utf-8");
    execSync(`osascript ${scriptPath}`, {
      encoding: "utf-8",
      timeout: 30_000,
    });
    return {
      result: {
        success: true,
        data: `Typed the value of ${envVar} into ${processName}`,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      result: {
        success: false,
        data: `Failed to type env var: ${message}`,
      },
    };
  }
}
