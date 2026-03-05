/**
 * Send a message in the Vellum desktop app chat.
 *
 * Encapsulates the focus → clear → type → send → wait → verify flow
 * so the agent doesn't waste iterations debugging text field interactions.
 * Returns the updated chat content after the assistant responds.
 */

import { execSync } from "child_process";
import { unlinkSync, writeFileSync } from "fs";

import type Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright";

import type { ToolContext, ToolHandlerResult } from "./types";

export const definition: Anthropic.Tool = {
  name: "send_chat_message",
  description:
    'Send a message in the Vellum desktop app chat and wait for the assistant to respond. Handles focusing the text field, typing, pressing Enter, and waiting for a response. Returns the full chat text after the response arrives. Use this instead of manually typing into the text field with applescript.',
  input_schema: {
    type: "object" as const,
    properties: {
      message: {
        type: "string",
        description: "The message text to send",
      },
      process_name: {
        type: "string",
        description:
          "The name of the macOS process (default: Vellum)",
      },
      wait_seconds: {
        type: "number",
        description:
          "How many seconds to wait for the assistant to respond (default: 10)",
      },
    },
    required: ["message"],
  },
};

export async function execute(
  _page: Page,
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolHandlerResult> {
  const message = input.message as string;
  const processName = (input.process_name as string) ?? "Vellum";
  const waitSeconds = (input.wait_seconds as number) ?? 10;

  // Escape the message for AppleScript string literal
  const escaped = message.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  // Step 1: Focus the text field, clear it, type the message, and press Enter.
  // We find the text field via entire contents to handle any nesting.
  const sendScript = `
tell application "System Events"
  tell process "${processName}"
    set frontmost to true
    delay 0.3

    -- Find the main app window (largest window)
    set appWindow to missing value
    set largestArea to 0
    repeat with w in windows
      try
        set winSize to size of w
        set winW to item 1 of winSize
        set winH to item 2 of winSize
        set winArea to winW * winH
        if winArea > largestArea then
          set largestArea to winArea
          set appWindow to w
        end if
      end try
    end repeat

    if appWindow is missing value then
      error "Could not find the app window"
    end if

    -- Find the text field (chat input) in the main window.
    -- Use entire contents to find it regardless of nesting.
    set chatField to missing value
    set allElems to entire contents of appWindow
    repeat with elem in allElems
      try
        if class of elem is text field then
          -- The chat input is in the main group, not in a scroll area popup
          set chatField to elem
        end if
      end try
    end repeat

    if chatField is missing value then
      error "Could not find the chat text field"
    end if

    -- Focus, clear, type, and send
    set focused of chatField to true
    delay 0.3
    keystroke "a" using command down
    delay 0.1
    key code 51 -- delete
    delay 0.1
    keystroke "${escaped}"
    delay 0.2

    -- Verify the text was typed
    set fieldValue to value of chatField
    if fieldValue is "" then
      error "Text field is empty after typing — keystroke did not register"
    end if

    -- Send with Enter
    keystroke return
    delay 0.5
  end tell
end tell
`;

  const sendPath = `/tmp/pw-agent-send-msg-w${context.workerIndex}.scpt`;
  try {
    writeFileSync(sendPath, sendScript, "utf-8");
    execSync(`osascript ${sendPath}`, {
      encoding: "utf-8",
      timeout: 15_000,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      result: { success: false, data: `Failed to send message: ${msg}` },
    };
  } finally {
    try { unlinkSync(sendPath); } catch {}
  }

  // Step 2: Wait for the assistant to respond.
  // We poll every 2 seconds, checking if new static text appears
  // or if the window count increases (Secure Credential popup).
  const pollInterval = 2000;
  const maxPolls = Math.ceil((waitSeconds * 1000) / pollInterval);

  const readScript = `
tell application "System Events"
  tell process "${processName}"
    -- Count windows (>1 means a popup appeared)
    set windowCount to count of windows

    -- Find the main window (largest)
    set appWindow to missing value
    set largestArea to 0
    repeat with w in windows
      try
        set winSize to size of w
        set winW to item 1 of winSize
        set winH to item 2 of winSize
        set winArea to winW * winH
        if winArea > largestArea then
          set largestArea to winArea
          set appWindow to w
        end if
      end try
    end repeat

    if appWindow is missing value then
      return "ERROR: no app window"
    end if

    -- Collect all static text from the main window
    set allElems to entire contents of appWindow
    set chatTexts to ""
    repeat with elem in allElems
      try
        if class of elem is static text then
          set textVal to value of elem
          if textVal is not "" and textVal is not missing value then
            set chatTexts to chatTexts & textVal & "\\n"
          end if
        end if
      end try
    end repeat

    return "WINDOWS:" & windowCount & "\\n" & chatTexts
  end tell
end tell
`;

  const readPath = `/tmp/pw-agent-read-chat-w${context.workerIndex}.scpt`;
  let lastOutput = "";

  try {
    // Initial read to get baseline
    writeFileSync(readPath, readScript, "utf-8");
    let baseline = "";
    try {
      baseline = execSync(`osascript ${readPath}`, {
        encoding: "utf-8",
        timeout: 15_000,
      }).trim();
    } catch {}

    // Poll for changes
    for (let i = 0; i < maxPolls; i++) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));

      try {
        lastOutput = execSync(`osascript ${readPath}`, {
          encoding: "utf-8",
          timeout: 15_000,
        }).trim();

        // If a new window appeared (e.g., Secure Credential popup), return immediately
        if (lastOutput.startsWith("WINDOWS:") && !lastOutput.startsWith("WINDOWS:1\n")) {
          return {
            result: {
              success: true,
              data: `Message sent. A new window appeared (likely a popup).\n\n${lastOutput}`,
            },
          };
        }

        // If the content has grown, the assistant responded
        if (lastOutput.length > baseline.length + 20) {
          return {
            result: {
              success: true,
              data: `Message sent and response received.\n\n${lastOutput}`,
            },
          };
        }
      } catch {}
    }

    // Timeout — return whatever we have
    return {
      result: {
        success: true,
        data: `Message sent. Assistant may still be responding (waited ${waitSeconds}s).\n\n${lastOutput || baseline}`,
      },
    };
  } finally {
    try { unlinkSync(readPath); } catch {}
  }
}
