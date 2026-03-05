/**
 * Read all chat messages from the Vellum desktop app.
 *
 * Uses `entire contents` to reliably read ALL static text in the main window,
 * regardless of scroll position or nesting depth. This avoids the common pitfall
 * of using narrowly-scoped queries like `every static text of UI element 1`
 * that miss newly-added messages.
 */

import { execSync } from "child_process";
import { unlinkSync, writeFileSync } from "fs";

import type Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright";

import type { ToolContext, ToolHandlerResult } from "./types";

export const definition: Anthropic.Tool = {
  name: "read_chat_messages",
  description:
    "Read all chat messages from the Vellum desktop app. Returns all visible text in the main window, plus the window count (to detect popups). Use this instead of manually querying static text elements via applescript — it handles scroll areas and nesting correctly.",
  input_schema: {
    type: "object" as const,
    properties: {
      process_name: {
        type: "string",
        description:
          "The name of the macOS process (default: Vellum)",
      },
    },
    required: [],
  },
};

export async function execute(
  _page: Page,
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolHandlerResult> {
  const processName = (input.process_name as string) ?? "Vellum";

  const script = `
tell application "System Events"
  tell process "${processName}"
    set windowCount to count of windows

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
      return "ERROR: no app window found"
    end if

    -- Collect all static text from the main window using entire contents
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

  const scriptPath = `/tmp/pw-agent-read-chat-w${context.workerIndex}.scpt`;
  try {
    writeFileSync(scriptPath, script, "utf-8");
    const output = execSync(`osascript ${scriptPath}`, {
      encoding: "utf-8",
      timeout: 30_000,
    }).trim();
    return {
      result: { success: true, data: output || "(no text found)" },
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      result: { success: false, data: `Failed to read chat: ${msg}` },
    };
  } finally {
    try { unlinkSync(scriptPath); } catch {}
  }
}
