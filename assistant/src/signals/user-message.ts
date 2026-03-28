/**
 * Handle user-message signals delivered via signal files from the CLI.
 *
 * Each invocation writes JSON to a unique `signals/user-message.<requestId>`
 * file. ConfigWatcher detects the new file and invokes
 * {@link handleUserMessageSignal}, which reads the payload, dispatches
 * the message through the daemon's send pipeline, and writes the result
 * to `signals/user-message.<requestId>.result` for the CLI to pick up.
 *
 * Per-request filenames avoid dropped messages when overlapping invocations
 * race on the same signal file.
 *
 * Because the signal handler needs access to the daemon's conversation map and
 * event hub, the daemon registers a callback at startup via
 * {@link registerUserMessageCallback}.
 */

import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../util/logger.js";
import { getSignalsDir } from "../util/platform.js";

const log = getLogger("signal:user-message");

// ── Daemon callback registry ─────────────────────────────────────────

type UserMessageCallback = (params: {
  conversationKey: string;
  content: string;
  sourceChannel: string;
  sourceInterface: string;
  bypassSecretCheck?: boolean;
}) => Promise<{ accepted: boolean; error?: string; message?: string }>;

let _sendUserMessage: UserMessageCallback | null = null;

/**
 * Register the user-message callback. Called once by the daemon server at
 * startup so the signal handler can reach the conversation map and event hub.
 */
export function registerUserMessageCallback(cb: UserMessageCallback): void {
  _sendUserMessage = cb;
}

// ── Signal handler ───────────────────────────────────────────────────

/**
 * Read a `signals/user-message.<requestId>` file and dispatch the message
 * through the daemon's send pipeline. Writes
 * `signals/user-message.<requestId>.result` with the outcome so the CLI
 * can display feedback. Called by ConfigWatcher when a matching signal
 * file is created or modified.
 */
export async function handleUserMessageSignal(filename: string): Promise<void> {
  const signalsDir = getSignalsDir();
  const signalPath = join(signalsDir, filename);
  const resultPath = join(signalsDir, `${filename}.result`);

  const writeResult = (
    data:
      | {
          ok: true;
          accepted: boolean;
          requestId: string;
          error?: string;
          message?: string;
        }
      | { ok: false; error: string; requestId: string | null },
  ): void => {
    try {
      writeFileSync(resultPath, JSON.stringify(data));
    } catch {
      // Best-effort — filesystem may be broken.
    }
  };

  let raw: string;
  try {
    raw = readFileSync(signalPath, "utf-8");
  } catch {
    // File may already be deleted (e.g. re-trigger from our own unlinkSync).
    return;
  }

  try {
    unlinkSync(signalPath);
  } catch {
    // Best-effort cleanup; the file may already be gone.
  }

  let parsedRequestId: string | undefined;

  try {
    const parsed = JSON.parse(raw) as {
      conversationKey?: string;
      content?: string;
      sourceChannel?: string;
      interface?: string;
      requestId?: string;
      bypassSecretCheck?: boolean;
    };
    const { requestId } = parsed;
    parsedRequestId = requestId;

    if (!requestId || typeof requestId !== "string") {
      log.warn("User-message signal missing requestId");
      writeResult({ ok: false, error: "Missing requestId", requestId: null });
      return;
    }

    if (!parsed.conversationKey || typeof parsed.conversationKey !== "string") {
      log.warn("User-message signal missing conversationKey");
      writeResult({
        ok: false,
        error: "Missing conversationKey",
        requestId,
      });
      return;
    }

    if (!parsed.content || typeof parsed.content !== "string") {
      log.warn("User-message signal missing content");
      writeResult({ ok: false, error: "Missing content", requestId });
      return;
    }

    if (!_sendUserMessage) {
      log.warn("User-message callback not registered; daemon may not be ready");
      writeResult({ ok: false, error: "Assistant not ready", requestId });
      return;
    }

    const result = await _sendUserMessage({
      conversationKey: parsed.conversationKey,
      content: parsed.content,
      sourceChannel: parsed.sourceChannel ?? "vellum",
      sourceInterface: parsed.interface ?? "cli",
      bypassSecretCheck: parsed.bypassSecretCheck === true,
    });

    log.info(
      { accepted: result.accepted },
      "User message dispatched via signal file",
    );
    writeResult({
      ok: true,
      accepted: result.accepted,
      requestId,
      ...(result.error ? { error: result.error } : {}),
      ...(result.message ? { message: result.message } : {}),
    });
  } catch (err) {
    log.error({ err }, "Failed to handle user-message signal");
    writeResult({
      ok: false,
      error: "Internal error",
      requestId: parsedRequestId ?? null,
    });
  }
}
