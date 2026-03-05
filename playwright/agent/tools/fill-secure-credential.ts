/**
 * Fill a Secure Credential popup with the value of an environment variable.
 *
 * The Secure Credential popup is a native macOS NSPanel (SwiftUI) that floats
 * above the main app window. It contains a SecureField and Save/Cancel buttons.
 * This tool uses AppleScript to:
 *   1. Find the panel via its accessibility identifier
 *   2. Focus the SecureField
 *   3. Type the env var value
 *   4. Click Save using a three-strategy cascade:
 *      - Strategy 1: AXIdentifier — reads `value of attribute "AXIdentifier"` to
 *        match the SwiftUI `.accessibilityIdentifier("secure-credential-save")`
 *      - Strategy 2: Name/title — checks `name of elem` / `title of elem` for "Save",
 *        backed by explicit `.accessibilityLabel("Save")` on the SwiftUI button
 *      - Strategy 3: Positional fallback — clicks the first non-Cancel button,
 *        skipping buttons whose AXIdentifier is "secure-credential-cancel"
 *
 * The secret value is never returned in the tool result.
 */

import { execSync } from "child_process";
import { unlinkSync, writeFileSync } from "fs";

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
  // 1. Finds the Secure Credential panel window (scans all windows for "Secure Credential" header, smallest match wins)
  // 2. Finds the text field via `entire contents` (reliable regardless of nesting)
  // 3. Types the env var value
  // 4. Clicks Save (by accessibility identifier, or by name "Save")
  //
  // The panel's actual hierarchy is:
  //   window > group > scroll area > text field
  //   window > group > scroll area > button (Cancel, Save)
  const script = `
tell application "System Events"
  tell process "${processName}"
    set frontmost to true
    delay 0.5

    -- Find the Secure Credential panel window.
    -- Strategy: scan all windows for the "Secure Credential" header text.
    -- Among matching windows, prefer the smallest (the panel is ~400x270).
    set credentialWindow to missing value
    set smallestArea to 9999999
    repeat with w in windows
      try
        set foundHeader to false
        set wElems to entire contents of w
        repeat with elem in wElems
          try
            if class of elem is static text then
              if value of elem is "Secure Credential" then
                set foundHeader to true
                exit repeat
              end if
            end if
          end try
        end repeat
        if foundHeader then
          set winSize to size of w
          set winW to item 1 of winSize
          set winH to item 2 of winSize
          set winArea to winW * winH
          if winArea < smallestArea then
            set smallestArea to winArea
            set credentialWindow to w
          end if
        end if
      end try
    end repeat

    if credentialWindow is missing value then
      error "Could not find a Secure Credential panel window"
    end if

    -- Find and fill the text field using entire contents (works regardless of nesting depth).
    set foundField to false
    set allElems to entire contents of credentialWindow
    repeat with elem in allElems
      try
        if class of elem is text field then
          click elem
          delay 0.3
          set focused of elem to true
          delay 0.2
          -- Clear any existing content
          keystroke "a" using command down
          delay 0.1
          set value of elem to "${escaped}"
          set foundField to true
          exit repeat
        end if
      end try
    end repeat

    if not foundField then
      error "Could not find or focus the text field in the Secure Credential panel"
    end if

    delay 0.3

    -- Click the Save button.
    -- We search entire contents for a button with the accessibility identifier or name "Save".
    set clickedSave to false

    -- Strategy 1: Find button by AXIdentifier (set by .accessibilityIdentifier() in SwiftUI)
    repeat with elem in allElems
      try
        if class of elem is button then
          set elemId to value of attribute "AXIdentifier" of elem
          if elemId is "secure-credential-save" then
            click elem
            set clickedSave to true
            exit repeat
          end if
        end if
      end try
    end repeat

    -- Strategy 2: Find button by name/title "Save"
    if not clickedSave then
      repeat with elem in allElems
        try
          if class of elem is button then
            if name of elem is "Save" or title of elem is "Save" then
              click elem
              set clickedSave to true
              exit repeat
            end if
          end if
        end try
      end repeat
    end if

    -- Strategy 3: Positional fallback — click the first non-Cancel button.
    -- The AX tree order is: Cancel, Save, [Send Once]. Taking the last button
    -- would pick "Send Once" when allowOneTimeSend is true, so we skip Cancel
    -- (identified by AXIdentifier) and take the first remaining button (Save).
    if not clickedSave then
      repeat with elem in allElems
        try
          if class of elem is button then
            set elemId to value of attribute "AXIdentifier" of elem
            if elemId is not "secure-credential-cancel" then
              click elem
              set clickedSave to true
              exit repeat
            end if
          end if
        end try
      end repeat
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
  } finally {
    try { unlinkSync(scriptPath); } catch {}
  }
}
