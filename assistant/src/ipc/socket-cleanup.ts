/**
 * Shared helpers for IPC server socket lifecycle. `AssistantIpcServer` needs
 * the probe-before-unlink dance to avoid silently stealing another daemon's
 * listener: a blind `unlinkSync` on a live Unix
 * socket file would orphan the bound listener (Linux/macOS allow unlink while
 * still bound) and the new server would happily `listen()` on the now-renamed
 * inode, leaving two daemons in conflict with no error.
 */

import { existsSync, unlinkSync } from "node:fs";
import { connect } from "node:net";

import { getAssistantSocketPath } from "./socket-path.js";

/**
 * Maximum time to wait for the probe `connect()` to settle before declaring
 * the path occupied. Without a bound, a hung process holding the socket would
 * make the daemon hang during startup — violating the AGENTS.md rule that
 * startup must never block. Two seconds is large enough to absorb a slow
 * peer's accept-loop latency but short enough to fail fast in the wedged
 * case.
 */
const PROBE_CONNECT_TIMEOUT_MS = 2000;

/**
 * Build an `EADDRINUSE`-coded error so callers (and `categorizeDaemonError`)
 * can branch on `err.code` and surface the structured "already running"
 * guidance instead of a generic UNKNOWN.
 */
function makeAddrInUseError(message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = "EADDRINUSE";
  return err;
}

type SocketProbeOutcome = "connected" | "timeout" | "stale";

/**
 * Probe-connect to `socketPath` once and classify the result. Never mutates the
 * filesystem. Rejects only on an unexpected socket error (anything other than
 * `ECONNREFUSED`/`ENOENT`). Callers must confirm the path exists first.
 *   - "connected": a live listener accepted the connection.
 *   - "timeout":   the connect did not settle within
 *                  {@link PROBE_CONNECT_TIMEOUT_MS}, so the path is treated as
 *                  occupied (a hung peer must not be blindly unlinked).
 *   - "stale":     the path exists but nothing is listening.
 */
async function connectProbe(socketPath: string): Promise<SocketProbeOutcome> {
  return await new Promise<SocketProbeOutcome>((resolve, reject) => {
    const client = connect(socketPath);
    let settled = false;
    const settle = (action: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      client.removeAllListeners();
      client.destroy();
      action();
    };
    const timer = setTimeout(() => {
      settle(() => resolve("timeout"));
    }, PROBE_CONNECT_TIMEOUT_MS);
    client.once("connect", () => settle(() => resolve("connected")));
    client.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ECONNREFUSED" || err.code === "ENOENT") {
        settle(() => resolve("stale"));
      } else {
        settle(() => reject(err));
      }
    });
  });
}

/**
 * Probe-connect to `socketPath`. Behavior:
 *   - Path doesn't exist → return.
 *   - Connect succeeds (live listener) → throw `EADDRINUSE` so the caller can
 *     surface the structured "already running" error.
 *   - Connect fails with `ECONNREFUSED`/`ENOENT` (stale leftover) → unlink
 *     the file and return.
 *   - Connect doesn't settle within {@link PROBE_CONNECT_TIMEOUT_MS} → throw
 *     `EADDRINUSE` (no fallback to blind unlink — the whole point of this
 *     helper is to keep the silent-orphan defense).
 *   - Any other socket error → propagate.
 */
export async function ensureSocketPathFree(socketPath: string): Promise<void> {
  if (!existsSync(socketPath)) {
    return;
  }
  const outcome = await connectProbe(socketPath);
  if (outcome === "connected") {
    throw makeAddrInUseError(
      `EADDRINUSE: another daemon is listening at ${socketPath}`,
    );
  }
  if (outcome === "timeout") {
    throw makeAddrInUseError(
      `EADDRINUSE: probe-connect to ${socketPath} did not settle within ${PROBE_CONNECT_TIMEOUT_MS}ms`,
    );
  }
  try {
    unlinkSync(socketPath);
  } catch {
    // Ignore — may already be gone
  }
}

/**
 * Read-only liveness check: is a live daemon currently listening at
 * `socketPath`? Unlike {@link ensureSocketPathFree}, this never unlinks a stale
 * leftover and never throws for an occupied path. An absent or stale socket
 * returns `false`. An unexpected socket error is inconclusive and also returns
 * `false`, leaving the authoritative bind-check to decide.
 */
export async function isDaemonSocketAlive(
  socketPath: string,
): Promise<boolean> {
  if (!existsSync(socketPath)) {
    return false;
  }
  try {
    const outcome = await connectProbe(socketPath);
    return outcome === "connected" || outcome === "timeout";
  } catch {
    return false;
  }
}

/**
 * Early duplicate-daemon guard for daemon startup. Throws an `EADDRINUSE`-coded
 * error when a live daemon already holds the assistant IPC socket, so startup
 * can abort BEFORE any config.json normalization or PID-file write. Read-only:
 * it never unlinks. The authoritative unlink-and-bind still runs later in
 * `AssistantIpcServer.start()`.
 */
export async function assertNoLiveDaemonHoldingSocket(
  socketPath: string = getAssistantSocketPath(),
): Promise<void> {
  if (await isDaemonSocketAlive(socketPath)) {
    throw makeAddrInUseError(
      `EADDRINUSE: another assistant is already running at ${socketPath}`,
    );
  }
}
