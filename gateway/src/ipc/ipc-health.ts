/**
 * Shared down/up tracker for the gateway → assistant IPC channel.
 *
 * The gateway runs independent 5s polling loops (e.g.
 * outbound-voice-verification-sync) that each call the assistant over the
 * reverse IPC socket. When the assistant daemon is unreachable — typically a
 * 30s call timeout while it is hung or restarting — every loop logs a fresh
 * WARN on every poll, producing a steady stream of identical timeout errors.
 *
 * This module collapses that spam into a single edge-triggered signal shared
 * across all callers: one WARN when the channel first goes down, and one INFO
 * when it next comes back. Per-poll transport errors in between are counted but
 * not logged.
 *
 * Only {@link IpcTransportError} (timeout / socket closed / unreachable) is
 * treated as "down". Handler-level errors (a real RouteError from the daemon)
 * and domain errors are genuine signal — callers should keep logging those.
 */

import { getLogger } from "../logger.js";
import { IpcTransportError } from "./assistant-client.js";

const log = getLogger("ipc-health");

let down = false;
let downSince = 0;
let suppressedWhileDown = 0;

/**
 * Record the outcome of a failed IPC attempt for down/up tracking.
 *
 * Returns `true` when the caller should stay silent about this error because
 * the health tracker has accounted for it (i.e. it is a transport error and
 * the channel is — or just became — down). Returns `false` for non-transport
 * errors, which the caller should continue to log as usual.
 *
 * The first transport error after a healthy period logs a single "down" WARN;
 * subsequent transport errors are silently counted until recovery.
 */
export function noteIpcTransportError(err: unknown, context?: string): boolean {
  if (!(err instanceof IpcTransportError)) return false;

  if (down) {
    suppressedWhileDown++;
    return true;
  }

  down = true;
  downSince = Date.now();
  suppressedWhileDown = 0;
  log.warn(
    { err, context },
    "Assistant IPC is down — suppressing repeat sync errors until it recovers",
  );
  return true;
}

/**
 * Record a successful IPC round-trip. Logs a single "back" INFO on the
 * recovering edge (including how long the channel was down and how many
 * repeat errors were suppressed), and is a no-op while already healthy.
 */
export function noteIpcReachable(): void {
  if (!down) return;

  down = false;
  log.info(
    {
      downForMs: Date.now() - downSince,
      suppressedErrors: suppressedWhileDown,
    },
    "Assistant IPC is back",
  );
  suppressedWhileDown = 0;
}

/** Test-only: reset the shared health state between cases. */
export function __resetIpcHealthForTests(): void {
  down = false;
  downSince = 0;
  suppressedWhileDown = 0;
}
