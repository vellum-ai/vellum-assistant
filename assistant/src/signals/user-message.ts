/**
 * Handle user-message signals delivered via signal files from the CLI.
 *
 * The built-in CLI writes JSON to `signals/user-message` instead of making
 * an HTTP POST to `/v1/messages`. The daemon's ConfigWatcher detects the
 * file change and invokes {@link handleUserMessageSignal}, which reads the
 * payload, dispatches the message through the daemon's send pipeline, and
 * writes `signals/user-message.result` so the CLI knows whether the message
 * was accepted.
 *
 * Because the signal handler needs access to the daemon's session map and
 * event hub, the daemon registers a callback at startup via
 * {@link registerUserMessageCallback}.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";

const log = getLogger("signal:user-message");

// ── Daemon callback registry ─────────────────────────────────────────

type UserMessageCallback = (params: {
  conversationKey: string;
  content: string;
  sourceChannel: string;
  sourceInterface: string;
}) => Promise<{ accepted: boolean }>;

let _sendUserMessage: UserMessageCallback | null = null;

/**
 * Register the user-message callback. Called once by the daemon server at
 * startup so the signal handler can reach the session map and event hub.
 */
export function registerUserMessageCallback(cb: UserMessageCallback): void {
  _sendUserMessage = cb;
}

// ── Signal handler ───────────────────────────────────────────────────

/**
 * Read the `signals/user-message` file and dispatch the message through
 * the daemon's send pipeline. Writes `signals/user-message.result` with
 * the outcome so the CLI can display feedback. Called by ConfigWatcher
 * when the signal file is written.
 */
export async function handleUserMessageSignal(): Promise<void> {
  const resultPath = join(getWorkspaceDir(), "signals", "user-message.result");

  const writeResult = (
    data:
      | { ok: true; accepted: boolean; requestId: string }
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
      join(getWorkspaceDir(), "signals", "user-message"),
      "utf-8",
    );
    const parsed = JSON.parse(content) as {
      conversationKey?: string;
      content?: string;
      sourceChannel?: string;
      interface?: string;
      requestId?: string;
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
    });

    log.info(
      { accepted: result.accepted },
      "User message dispatched via signal file",
    );
    writeResult({ ok: true, accepted: result.accepted, requestId });
  } catch (err) {
    log.error({ err }, "Failed to handle user-message signal");
    writeResult({
      ok: false,
      error: "Internal error",
      requestId: parsedRequestId ?? null,
    });
  }
}
