/**
 * Handle cancel-generation signals delivered via signal files from the CLI.
 *
 * The built-in CLI writes JSON to `signals/cancel` instead of making an
 * HTTP POST to `/v1/conversations/:id/cancel`. The daemon's ConfigWatcher
 * detects the file change and invokes {@link handleCancelSignal}, which
 * reads the payload and aborts the target session.
 *
 * Because the signal handler needs access to the daemon's session map, the
 * daemon registers a callback at startup via {@link registerCancelCallback}.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../util/logger.js";
import { getSignalsDir } from "../util/platform.js";

const log = getLogger("signal:cancel");

// ── Daemon callback registry ─────────────────────────────────────────

type CancelCallback = (conversationId: string) => boolean;

let _cancelGeneration: CancelCallback | null = null;

/**
 * Register the cancel-generation callback. Called once by the daemon
 * server at startup so the signal handler can reach the session map.
 */
export function registerCancelCallback(cb: CancelCallback): void {
  _cancelGeneration = cb;
}

// ── Signal handler ───────────────────────────────────────────────────

/**
 * Read the `signals/cancel` file and abort the target session.
 * Called by ConfigWatcher when the signal file is written or modified.
 */
export function handleCancelSignal(): void {
  try {
    const content = readFileSync(join(getSignalsDir(), "cancel"), "utf-8");
    const parsed = JSON.parse(content) as { conversationId?: string };
    const { conversationId } = parsed;

    if (!conversationId || typeof conversationId !== "string") {
      log.warn("Cancel signal missing conversationId");
      return;
    }

    if (!_cancelGeneration) {
      log.warn("Cancel callback not registered; daemon may not be ready");
      return;
    }

    const found = _cancelGeneration(conversationId);
    if (found) {
      log.info({ conversationId }, "Generation cancelled via signal file");
    } else {
      log.warn({ conversationId }, "No active conversation for cancel signal");
    }
  } catch (err) {
    log.error({ err }, "Failed to handle cancel signal");
  }
}
