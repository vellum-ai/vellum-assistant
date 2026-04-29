/**
 * Handle conversation-undo signals delivered via signal files from the CLI.
 *
 * The built-in CLI writes JSON to `signals/conversation-undo` instead of
 * making an HTTP POST to `/v1/conversations/:id/undo`. The daemon's
 * ConfigWatcher detects the file change and invokes
 * {@link handleConversationUndoSignal}, which reads the payload, performs
 * the undo, and writes `signals/conversation-undo.result` so the CLI
 * receives feedback.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getIsContainerized } from "../config/env-registry.js";
import { undoLastMessage } from "../daemon/handlers/conversations.js";
import { getLogger } from "../util/logger.js";
import { getSignalsDir } from "../util/platform.js";

const log = getLogger("signal:conversation-undo");

// ── Signal handler ───────────────────────────────────────────────────

/**
 * Read the `signals/conversation-undo` file and undo the last message in
 * the conversation. Writes `signals/conversation-undo.result` with the outcome
 * so the CLI can display feedback. Called by ConfigWatcher when the signal
 * file is written.
 */
export async function handleConversationUndoSignal(): Promise<void> {
  if (getIsContainerized()) return;

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

    const result = await undoLastMessage(conversationId);
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
