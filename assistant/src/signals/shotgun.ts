/**
 * Handle shotgun (screen-watch) signals delivered via signal files from the CLI.
 *
 * Each invocation writes JSON to a unique `signals/shotgun.<requestId>` file.
 * ConfigWatcher detects the new file and invokes {@link handleShotgunSignal},
 * which reads the payload, creates or queries a watch session, and writes
 * the result to `signals/shotgun.<requestId>.result` for the CLI to pick up.
 *
 * Supports two actions:
 * - `start`: Create a new watch session and return the watchId/conversationId.
 * - `status`: Query the status of an existing watch session by watchId.
 */

import crypto from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getIsContainerized } from "../config/env-registry.js";
import {
  fireWatchCompletionNotifier,
  fireWatchStartNotifier,
  type WatchSession,
  watchSessions,
} from "../tools/watch/watch-state.js";
import { getLogger } from "../util/logger.js";
import { getSignalsDir } from "../util/platform.js";

const log = getLogger("signal:shotgun");

const SHORT_HASH_LENGTH = 8;

interface ShotgunResult {
  requestId: string;
  ok: boolean;
  error?: string;
  watchId?: string;
  conversationId?: string;
  status?: string;
}

function writeResult(requestId: string, result: ShotgunResult): void {
  try {
    writeFileSync(
      join(getSignalsDir(), `shotgun.${requestId}.result`),
      JSON.stringify(result),
    );
  } catch (err) {
    log.error({ err, requestId }, "Failed to write shotgun signal result");
  }
}

/**
 * Read a `signals/shotgun.<requestId>` file, process the action, and write
 * the result to `signals/shotgun.<requestId>.result`. Called by ConfigWatcher
 * when a matching signal file is created or modified.
 */
export function handleShotgunSignal(filename: string): void {
  if (getIsContainerized()) return;

  const signalPath = join(getSignalsDir(), filename);
  let raw: string;
  try {
    raw = readFileSync(signalPath, "utf-8");
  } catch {
    return;
  }

  try {
    unlinkSync(signalPath);
  } catch {
    // Best-effort cleanup.
  }

  let payload: {
    requestId?: string;
    action?: string;
    durationSeconds?: number;
    intervalSeconds?: number;
    focusArea?: string;
    watchId?: string;
  };
  try {
    payload = JSON.parse(raw) as typeof payload;
  } catch (err) {
    log.error({ err, filename }, "Failed to parse shotgun signal file");
    return;
  }

  const { requestId } = payload;
  if (!requestId || typeof requestId !== "string") {
    log.warn("Shotgun signal missing requestId");
    return;
  }

  const { action } = payload;

  if (action === "start") {
    handleStart(requestId, payload);
  } else if (action === "status") {
    handleStatus(requestId, payload);
  } else {
    writeResult(requestId, {
      requestId,
      ok: false,
      error: `Unknown action: ${String(action)}`,
    });
  }
}

function handleStart(
  requestId: string,
  payload: {
    durationSeconds?: number;
    intervalSeconds?: number;
    focusArea?: string;
  },
): void {
  const durationSeconds =
    typeof payload.durationSeconds === "number" && payload.durationSeconds > 0
      ? payload.durationSeconds
      : 300;

  const intervalSeconds =
    typeof payload.intervalSeconds === "number" && payload.intervalSeconds > 0
      ? payload.intervalSeconds
      : 5;

  const focusArea =
    typeof payload.focusArea === "string" && payload.focusArea.length > 0
      ? payload.focusArea
      : "general observation";

  const watchId = crypto.randomUUID().slice(0, SHORT_HASH_LENGTH);
  const conversationId = `shotgun-${watchId}`;
  const now = Date.now();

  const session: WatchSession = {
    watchId,
    conversationId,
    focusArea,
    durationSeconds,
    intervalSeconds,
    observations: [],
    commentaryCount: 0,
    status: "active",
    startedAt: now,
  };

  watchSessions.set(watchId, session);
  fireWatchStartNotifier(conversationId, session);

  session.timeoutHandle = setTimeout(() => {
    session.status = "completing";
    session.timeoutHandle = undefined;
    log.info(
      { watchId, focusArea },
      "Shotgun session duration expired, marking as completing",
    );
    fireWatchCompletionNotifier(conversationId, session);
  }, durationSeconds * 1000);

  log.info(
    { watchId, conversationId, focusArea, durationSeconds, intervalSeconds },
    "Shotgun watch session started via signal",
  );

  writeResult(requestId, {
    requestId,
    ok: true,
    watchId,
    conversationId,
  });
}

function handleStatus(requestId: string, payload: { watchId?: string }): void {
  const { watchId } = payload;
  if (!watchId || typeof watchId !== "string") {
    writeResult(requestId, {
      requestId,
      ok: false,
      error: "Missing watchId for status query",
    });
    return;
  }

  const session = watchSessions.get(watchId);
  if (!session) {
    writeResult(requestId, {
      requestId,
      ok: false,
      error: `No watch session found for watchId: ${watchId}`,
    });
    return;
  }

  writeResult(requestId, {
    requestId,
    ok: true,
    watchId,
    conversationId: session.conversationId,
    status: session.status,
  });
}
