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
  context: ToolContext,
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

  // Guard: only allow typing env var values into password or secret input
  // fields to prevent accidental exposure of sensitive values.
  // Uses macOS Accessibility (System Events) to check the focused UI element's
  // role — "AXSecureTextField" corresponds to password/secret inputs.
  //
  // NOTE: `focused UI element` is a problematic AppleScript construct that
  // causes compilation errors on some macOS versions. We use the AXFocusedUIElement
  // attribute instead. The primary query is at the process level (where the
  // attribute is defined), with a per-window fallback for edge cases.
  const checkScript = `
tell application "System Events"
  tell process "${processName}"
    try
      -- Query AXFocusedUIElement at the process level (most reliable).
      -- This attribute belongs to the application, not individual windows.
      set focusedEl to value of attribute "AXFocusedUIElement"
      if focusedEl is not missing value then
        set elRole to value of attribute "AXRole" of focusedEl
        return elRole
      end if
    end try
    try
      -- Fallback: check each window (older macOS or unusual window setups)
      repeat with w in windows
        try
          set focusedEl to value of attribute "AXFocusedUIElement" of w
          if focusedEl is not missing value then
            set elRole to value of attribute "AXRole" of focusedEl
            return elRole
          end if
        end try
      end repeat
    end try
    return "unknown"
  end tell
end tell
`;
  const checkPath = `/tmp/pw-agent-check-secret-w${context.workerIndex}.scpt`;
  try {
    writeFileSync(checkPath, checkScript, "utf-8");
    const role = execSync(`osascript ${checkPath}`, {
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();

    if (role !== "AXSecureTextField" && role !== "AXTextField") {
      return {
        result: {
          success: false,
          data: `Cannot type environment variable ${envVar}: the focused element is not a text input field (role: ${role}). Use fill_secure_credential instead for Secure Credential popups.`,
        },
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      result: {
        success: false,
        data: `Cannot verify focused element is a secret input: ${message}`,
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

  const scriptPath = `/tmp/pw-agent-type-env-var-w${context.workerIndex}.scpt`;
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
