/**
 * CLI-side helper that opens a URL on the user's host machine.
 *
 * On macOS, launches the default browser directly. Other platforms write an
 * `open_url` event so a connected host client can open the URL.
 *
 * CLI-initiated emit — no conversation context available, so the inner
 * message has no `conversationId`. That's fine: `OpenUrlEventSchema`
 * declares `conversationId` as optional, so this payload parses
 * cleanly on the web side as well as in the Swift macOS app.
 *
 * Uses only `node:` imports so it's safe for `ipc`-tagged CLI commands.
 */

import { spawn } from "node:child_process";
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

export function openInHostBrowser(
  url: string,
  deps: {
    platform?: NodeJS.Platform;
    spawnImpl?: typeof spawn;
    workspaceDir?: string;
  } = {},
): void {
  if ((deps.platform ?? process.platform) === "darwin") {
    const child = (deps.spawnImpl ?? spawn)("open", [url], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {
      // The caller prints a fallback URL.
    });
    child.unref();
    return;
  }

  try {
    const signalsDir = join(deps.workspaceDir ?? getWorkspaceDir(), "signals");
    mkdirSync(signalsDir, { recursive: true });
    writeFileSync(
      join(signalsDir, "emit-event"),
      JSON.stringify({ type: "open_url", url }),
    );
  } catch {
    // Best-effort — caller will display the URL as a fallback
  }
}
