/**
 * CLI-side helper that opens a URL on the user's host machine.
 *
 * Writes an `open_url` event to the `signals/emit-event` file so that the
 * assistant's ConfigWatcher picks it up and publishes it to connected
 * clients (e.g. the Swift macOS app) via the assistant event hub.
 *
 * CLI-initiated emit — no conversation context available, so the inner
 * message has no `conversationId`. That's fine: `OpenUrlEventSchema`
 * declares `conversationId` as optional, so this payload parses
 * cleanly on the web side as well as in the Swift macOS app.
 *
 * Uses only `node:` imports so it's safe for `ipc`-tagged CLI commands.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function getWorkspaceDir(): string {
  return (
    process.env.VELLUM_WORKSPACE_DIR ??
    join(
      process.env.HOME ?? process.env.USERPROFILE ?? "/tmp",
      ".vellum",
      "workspace",
    )
  );
}

export function openInHostBrowser(url: string): void {
  try {
    const signalsDir = join(getWorkspaceDir(), "signals");
    mkdirSync(signalsDir, { recursive: true });
    writeFileSync(
      join(signalsDir, "emit-event"),
      JSON.stringify({ type: "open_url", url }),
    );
  } catch {
    // Best-effort — caller will display the URL as a fallback
  }
}
