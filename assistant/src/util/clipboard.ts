import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "./logger.js";
import { getClipboardCommand, getSignalsDir } from "./platform.js";

const log = getLogger("clipboard");

/**
 * Copy text to the user's clipboard.
 *
 * On bare-metal macOS/Linux where `pbcopy`/`xclip` is available, copies
 * directly via the local command. When the local command is missing or
 * fails (e.g. headless Docker), writes a `copy_to_clipboard` event to
 * `signals/emit-event` so the daemon forwards it to a connected native
 * client (the Swift macOS app) which performs the actual paste-board write.
 */
export function copyToClipboard(text: string): void {
  const cmd = getClipboardCommand();
  if (cmd) {
    try {
      execSync(cmd, { input: text, stdio: ["pipe", "ignore", "ignore"] });
      return;
    } catch {
      // Local clipboard command failed (e.g. xclip not installed in Docker).
      // Fall through to signal-based routing.
    }
  }

  // Route through the signal file so the native client can copy on the
  // user's host machine.
  try {
    const signalsDir = getSignalsDir();
    mkdirSync(signalsDir, { recursive: true });
    writeFileSync(
      join(signalsDir, "emit-event"),
      JSON.stringify({ type: "copy_to_clipboard", text }),
    );
  } catch (err) {
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "Failed to write copy_to_clipboard signal",
    );
  }
}

export function formatConversationForExport(
  messages: Array<{ role: string; text: string }>,
): string {
  return messages
    .map((m) => {
      const label = m.role === "user" ? "you" : "assistant";
      return `${label}> ${m.text}`;
    })
    .join("\n\n");
}

export function extractLastCodeBlock(text: string): string | null {
  const re = /```[^\n]*\n((?:[\s\S]*?\n)?)```/g;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) != null) {
    last = m;
  }
  if (!last) return null;
  return last[1].trimEnd();
}
