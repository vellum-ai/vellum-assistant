/**
 * Handle launch-conversation signals delivered via signal files from skills.
 *
 * Each invocation writes JSON to a unique
 * `signals/launch-conversation.<requestId>` file. ConfigWatcher detects the
 * new file and invokes {@link handleLaunchConversationSignal}, which reads
 * the payload, creates + seeds + titles a fresh conversation through the
 * daemon's registered callback, and writes the outcome to
 * `signals/launch-conversation.<requestId>.result` for the caller.
 *
 * Per-request filenames avoid dropped messages when overlapping invocations
 * race on the same signal file.
 *
 * Because the signal handler needs access to the daemon's conversation map,
 * title store, and event hub, the daemon registers a callback at startup via
 * {@link registerLaunchConversationCallback}.
 */

import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../util/logger.js";
import { getSignalsDir } from "../util/platform.js";

const log = getLogger("signal:launch-conversation");

// ── Daemon callback registry ─────────────────────────────────────────

type LaunchConversationCallback = (params: {
  title: string;
  seedPrompt: string;
  anchorMessageId?: string;
}) => Promise<{
  accepted: boolean;
  conversationId?: string;
  error?: string;
  message?: string;
}>;

let _launchConversation: LaunchConversationCallback | null = null;

/**
 * Register the launch-conversation callback. Called once by the daemon
 * server at startup so the signal handler can reach the conversation map,
 * title store, and event hub.
 */
export function registerLaunchConversationCallback(
  cb: LaunchConversationCallback,
): void {
  _launchConversation = cb;
}

// ── Signal handler ───────────────────────────────────────────────────

/**
 * Read a `signals/launch-conversation.<requestId>` file and spawn a new
 * conversation via the daemon's launch pipeline. Writes
 * `signals/launch-conversation.<requestId>.result` with the outcome so the
 * caller can observe success/failure and learn the new conversationId.
 */
export async function handleLaunchConversationSignal(
  filename: string,
): Promise<void> {
  const signalsDir = getSignalsDir();
  const signalPath = join(signalsDir, filename);
  const resultPath = join(signalsDir, `${filename}.result`);

  const writeResult = (
    data:
      | {
          ok: true;
          accepted: boolean;
          requestId: string;
          conversationId?: string;
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
      requestId?: string;
      title?: string;
      seedPrompt?: string;
      anchorMessageId?: string;
    };
    const { requestId } = parsed;
    parsedRequestId = requestId;

    if (!requestId || typeof requestId !== "string") {
      log.warn("Launch-conversation signal missing requestId");
      writeResult({ ok: false, error: "Missing requestId", requestId: null });
      return;
    }

    if (!parsed.title || typeof parsed.title !== "string") {
      log.warn("Launch-conversation signal missing title");
      writeResult({ ok: false, error: "Missing title", requestId });
      return;
    }

    if (!parsed.seedPrompt || typeof parsed.seedPrompt !== "string") {
      log.warn("Launch-conversation signal missing seedPrompt");
      writeResult({ ok: false, error: "Missing seedPrompt", requestId });
      return;
    }

    if (!_launchConversation) {
      log.warn(
        "Launch-conversation callback not registered; daemon may not be ready",
      );
      writeResult({ ok: false, error: "Assistant not ready", requestId });
      return;
    }

    const result = await _launchConversation({
      title: parsed.title,
      seedPrompt: parsed.seedPrompt,
      ...(typeof parsed.anchorMessageId === "string"
        ? { anchorMessageId: parsed.anchorMessageId }
        : {}),
    });

    log.info(
      {
        accepted: result.accepted,
        conversationId: result.conversationId,
      },
      "Launch-conversation dispatched via signal file",
    );
    writeResult({
      ok: true,
      accepted: result.accepted,
      requestId,
      ...(result.conversationId
        ? { conversationId: result.conversationId }
        : {}),
      ...(result.error ? { error: result.error } : {}),
      ...(result.message ? { message: result.message } : {}),
    });
  } catch (err) {
    log.error({ err }, "Failed to handle launch-conversation signal");
    writeResult({
      ok: false,
      error: "Internal error",
      requestId: parsedRequestId ?? null,
    });
  }
}
