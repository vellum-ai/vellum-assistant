import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "./logger.js";
import { getSignalsDir } from "./platform.js";

const log = getLogger("clipboard");

/**
 * Copy text to the user's clipboard.
 *
 * Writes a `copy_to_clipboard` event to `signals/emit-event` so the
 * daemon forwards it to connected native clients (e.g. the Swift macOS
 * app) which perform the pasteboard write on the user's host machine.
 *
 * The assistant always runs on a separate machine from the user's host,
 * so local clipboard commands (pbcopy/xclip) are never appropriate.
 */
export function copyToClipboard(text: string): void {
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
