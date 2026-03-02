/**
 * Fill a Secure Credential popup with the value of an environment variable.
 *
 * The Secure Credential popup is a native macOS NSPanel (SwiftUI) that floats
 * above the main app window. It contains a SecureField and Save/Cancel buttons.
 * This tool uses AppleScript to:
 *   1. Find the panel via its accessibility identifier
 *   2. Focus the SecureField
 *   3. Type the env var value
 *   4. Click Save
 *
 * The secret value is never returned in the tool result.
 */

import { execSync } from "child_process";
import { writeFileSync } from "fs";

import type Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright";

import type { ToolContext, ToolHandlerResult } from "./types";

export const definition: Anthropic.Tool = {
  name: "fill_secure_credential",
  description:
    'Fill a "Secure Credential" popup window with the value of an environment variable and click Save. Use this when you see a floating "Secure Credential" panel asking for a secret (API key, token, etc.). The secret value is never returned in the tool result.',
  input_schema: {
    type: "object" as const,
    properties: {
      env_var: {
        type: "string",
        description:
          "The name of the environment variable whose value should be entered (e.g., TWILIO_ACCOUNT_SID)",
      },
      process_name: {
        type: "string",
        description:
          "The name of the macOS process that owns the Secure Credential panel (e.g., Vellum)",
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

  // Escape the value for safe embedding in AppleScript string literals.
  // Backslashes must be escaped first, then double-quotes.
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  // The AppleScript:
  // 1. Finds the Secure Credential panel window (identified by containing
  //    a text field with accessibility identifier "secure-credential-input")
  // 2. Focuses the secure text field and types the value
  // 3. Clicks the Save button (identified by "secure-credential-save")
  const script = `
tell application "System Events"
  tell process "${processName}"
    set frontmost to true
    delay 0.3

    -- Find the window containing the secure credential input.
    -- The panel shows up as a window in the accessibility hierarchy.
    set credentialWindow to missing value
    repeat with w in windows
      try
        -- Look for the secure text field with our accessibility identifier
        set secureFields to every text field of w whose description contains "secure-credential-input"
        if (count of secureFields) > 0 then
          set credentialWindow to w
          exit repeat
        end if
      end try
      try
        -- Also check for UI elements that might be group-wrapped
        set secureFields to every text field of every group of w whose description contains "secure-credential-input"
        if (count of secureFields) > 0 then
          set credentialWindow to w
          exit repeat
        end if
      end try
    end repeat

    if credentialWindow is missing value then
      -- Fallback: look for any window with "Secure Credential" static text
      repeat with w in windows
        try
          set allText to value of every static text of every group of every scroll area of w
          -- Flatten and check for our header text
          repeat with textGroup in allText
            repeat with t in textGroup
              if t as text contains "Secure Credential" then
                set credentialWindow to w
                exit repeat
              end if
            end repeat
            if credentialWindow is not missing value then exit repeat
          end repeat
        end try
        if credentialWindow is not missing value then exit repeat
      end repeat
    end if

    if credentialWindow is missing value then
      error "Could not find a Secure Credential panel window"
    end if

    -- Focus and type into the secure text field.
    -- Try multiple strategies to find the input field.
    set foundField to false

    -- Strategy 1: Direct text field on the window
    try
      set tf to first text field of credentialWindow whose description contains "secure-credential-input"
      set focused of tf to true
      delay 0.2
      set value of tf to "${escaped}"
      set foundField to true
    end try

    -- Strategy 2: Text field inside a group
    if not foundField then
      try
        set allGroups to every group of credentialWindow
        repeat with g in allGroups
          try
            set tf to first text field of g whose description contains "secure-credential-input"
            set focused of tf to true
            delay 0.2
            set value of tf to "${escaped}"
            set foundField to true
            exit repeat
          end try
        end repeat
      end try
    end if

    -- Strategy 3: Deep search inside scroll areas and groups
    if not foundField then
      try
        set scrollAreas to every scroll area of credentialWindow
        repeat with sa in scrollAreas
          try
            set allGroups to every group of sa
            repeat with g in allGroups
              try
                set tf to first text field of g whose description contains "secure-credential-input"
                set focused of tf to true
                delay 0.2
                set value of tf to "${escaped}"
                set foundField to true
                exit repeat
              end try
            end repeat
          end try
          if foundField then exit repeat
        end repeat
      end try
    end if

    -- Strategy 4: Just try the first text field in the window
    if not foundField then
      try
        set tf to first text field of credentialWindow
        click tf
        delay 0.2
        keystroke "${escaped}"
        set foundField to true
      end try
    end if

    if not foundField then
      error "Could not find or focus the secure text field"
    end if

    delay 0.3

    -- Click the Save button
    set clickedSave to false
    try
      set saveBtn to first button of credentialWindow whose description contains "secure-credential-save"
      click saveBtn
      set clickedSave to true
    end try

    if not clickedSave then
      -- Fallback: look for a button named "Save"
      try
        set allButtons to every button of credentialWindow
        repeat with btn in allButtons
          if name of btn is "Save" or title of btn is "Save" then
            click btn
            set clickedSave to true
            exit repeat
          end if
        end repeat
      end try
    end if

    -- Deep search inside groups for Save button
    if not clickedSave then
      try
        set allGroups to every group of credentialWindow
        repeat with g in allGroups
          try
            set allButtons to every button of g
            repeat with btn in allButtons
              if name of btn is "Save" or description of btn contains "secure-credential-save" then
                click btn
                set clickedSave to true
                exit repeat
              end if
            end repeat
          end try
          if clickedSave then exit repeat
        end repeat
      end try
    end if

    if not clickedSave then
      error "Could not find or click the Save button"
    end if

    return "Credential entered and saved"
  end tell
end tell
`;

  const scriptPath = `/tmp/pw-agent-fill-credential-w${context.workerIndex}.scpt`;
  try {
    writeFileSync(scriptPath, script, "utf-8");
    execSync(`osascript ${scriptPath}`, {
      encoding: "utf-8",
      timeout: 30_000,
    });
    return {
      result: {
        success: true,
        data: `Filled Secure Credential with value of ${envVar} and clicked Save`,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      result: {
        success: false,
        data: `Failed to fill Secure Credential: ${message}`,
      },
    };
  }
}
