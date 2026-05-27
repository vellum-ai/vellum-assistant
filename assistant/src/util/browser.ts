import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "./logger.js";
import { getSignalsDir } from "./platform.js";

const log = getLogger("browser");

/**
 * Open a URL on the user's host machine.
 *
 * Writes an `open_url` event to the `signals/emit-event` file so that the
 * assistant's ConfigWatcher picks it up and publishes it to connected
 * clients (e.g. the Swift macOS app) via the assistant event hub.
 *
 * CLI-initiated emit — no conversation context available, so the inner
 * message has no `conversationId`. The web parser's strict
 * `OpenUrlEventSchema` requires it, so this payload is dropped as an
 * unknown event on the web side. The macOS app uses an independent
 * (Swift) parser and still receives this broadcast.
 */
export async function openInHostBrowser(url: string): Promise<void> {
  try {
    const signalsDir = getSignalsDir();
    mkdirSync(signalsDir, { recursive: true });
    writeFileSync(
      join(signalsDir, "emit-event"),
      JSON.stringify({ type: "open_url", url }),
    );
  } catch (err) {
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "Failed to write open_url signal",
    );
  }
}
