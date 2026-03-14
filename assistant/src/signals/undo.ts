/**
 * Handle undo signals delivered via signal files from the CLI.
 *
 * The built-in CLI writes JSON to `signals/undo` instead of making an
 * HTTP POST to `/v1/conversations/:id/undo`. The daemon's ConfigWatcher
 * detects the file change and invokes {@link handleUndoSignal}, which
 * reads the payload, performs the undo, and writes `signals/undo.result`
 * so the CLI receives feedback.
 *
 * Because the signal handler needs access to the daemon's session map, the
 * daemon registers a callback at startup via {@link registerUndoCallback}.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";

const log = getLogger("signal:undo");

// ── Daemon callback registry ─────────────────────────────────────────

type UndoCallback = (
  sessionId: string,
) => Promise<{ removedCount: number } | null>;

let _undoLastMessage: UndoCallback | null = null;

/**
 * Register the undo callback. Called once by the daemon server at startup
 * so the signal handler can reach the session map.
 */
export function registerUndoCallback(cb: UndoCallback): void {
  _undoLastMessage = cb;
}

// ── Signal handler ───────────────────────────────────────────────────

/**
 * Read the `signals/undo` file and undo the last message in the session.
 * Writes `signals/undo.result` with the outcome so the CLI can display
 * feedback. Called by ConfigWatcher when the signal file is written.
 */
export async function handleUndoSignal(): Promise<void> {
  const resultPath = join(getWorkspaceDir(), "signals", "undo.result");

  const writeResult = (
    data:
      | { ok: true; removedCount: number; sessionId: string }
      | { ok: false; error: string; sessionId: string | null },
  ): void => {
    try {
      writeFileSync(resultPath, JSON.stringify(data));
    } catch {
      // Best-effort — filesystem may be broken.
    }
  };

  try {
    const content = readFileSync(
      join(getWorkspaceDir(), "signals", "undo"),
      "utf-8",
    );
    const parsed = JSON.parse(content) as { sessionId?: string };
    const { sessionId } = parsed;

    if (!sessionId || typeof sessionId !== "string") {
      log.warn("Undo signal missing sessionId");
      writeResult({ ok: false, error: "Missing sessionId", sessionId: null });
      return;
    }

    if (!_undoLastMessage) {
      log.warn("Undo callback not registered; daemon may not be ready");
      writeResult({ ok: false, error: "Daemon not ready", sessionId });
      return;
    }

    const result = await _undoLastMessage(sessionId);
    if (!result) {
      log.warn({ sessionId }, "No active session for undo signal");
      writeResult({ ok: false, error: "No active session", sessionId });
      return;
    }

    log.info(
      { sessionId, removedCount: result.removedCount },
      "Undo completed via signal file",
    );
    writeResult({
      ok: true,
      removedCount: result.removedCount,
      sessionId,
    });
  } catch (err) {
    log.error({ err }, "Failed to handle undo signal");
    writeResult({
      ok: false,
      error: "Internal error",
      sessionId: null,
    });
  }
}
