/**
 * Handle conversation-undo signals delivered via signal files from the CLI.
 *
 * The built-in CLI writes JSON to `signals/conversation-undo` instead of
 * making an HTTP POST to `/v1/conversations/:id/undo`. The daemon's
 * ConfigWatcher detects the file change and invokes
 * {@link handleConversationUndoSignal}, which reads the payload, performs
 * the undo, and writes `signals/conversation-undo.result` so the CLI
 * receives feedback.
 *
 * Because the signal handler needs access to the daemon's session map, the
 * daemon registers a callback at startup via
 * {@link registerConversationUndoCallback}.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../util/logger.js";
import { getSignalsDir } from "../util/platform.js";

const log = getLogger("signal:conversation-undo");

// ── Daemon callback registry ─────────────────────────────────────────

type UndoCallback = (
  conversationId: string,
) => Promise<{ removedCount: number } | null>;

let _undoLastMessage: UndoCallback | null = null;

/**
 * Register the undo callback. Called once by the daemon server at startup
 * so the signal handler can reach the session map.
 */
export function registerConversationUndoCallback(cb: UndoCallback): void {
  _undoLastMessage = cb;
}

// ── Signal handler ───────────────────────────────────────────────────

/**
 * Read the `signals/conversation-undo` file and undo the last message in
 * the session. Writes `signals/conversation-undo.result` with the outcome
 * so the CLI can display feedback. Called by ConfigWatcher when the signal
 * file is written.
 */
export async function handleConversationUndoSignal(): Promise<void> {
  const resultPath = join(getSignalsDir(), "conversation-undo.result");

  const writeResult = (
    data:
      | { ok: true; removedCount: number; requestId: string }
      | { ok: false; error: string; requestId: string | null },
  ): void => {
    try {
      writeFileSync(resultPath, JSON.stringify(data));
    } catch {
      // Best-effort — filesystem may be broken.
    }
  };

  let parsedRequestId: string | undefined;

  try {
    const content = readFileSync(
      join(getSignalsDir(), "conversation-undo"),
      "utf-8",
    );
    const parsed = JSON.parse(content) as {
      conversationId?: string;
      requestId?: string;
    };
    const { conversationId, requestId } = parsed;
    parsedRequestId = requestId;

    if (!conversationId || typeof conversationId !== "string") {
      log.warn("Undo signal missing conversationId");
      writeResult({
        ok: false,
        error: "Missing conversationId",
        requestId: requestId ?? null,
      });
      return;
    }

    if (!requestId || typeof requestId !== "string") {
      log.warn("Undo signal missing requestId");
      writeResult({ ok: false, error: "Missing requestId", requestId: null });
      return;
    }

    if (!_undoLastMessage) {
      log.warn("Undo callback not registered; daemon may not be ready");
      writeResult({ ok: false, error: "Assistant not ready", requestId });
      return;
    }

    const result = await _undoLastMessage(conversationId);
    if (!result) {
      log.warn({ conversationId }, "No active conversation for undo signal");
      writeResult({ ok: false, error: "No active conversation", requestId });
      return;
    }

    log.info(
      { conversationId, removedCount: result.removedCount },
      "Undo completed via signal file",
    );
    writeResult({
      ok: true,
      removedCount: result.removedCount,
      requestId,
    });
  } catch (err) {
    log.error({ err }, "Failed to handle undo signal");
    writeResult({
      ok: false,
      error: "Internal error",
      requestId: parsedRequestId ?? null,
    });
  }
}
