/**
 * Shared helpers for IPC server socket lifecycle. Both `AssistantIpcServer` and
 * `SkillIpcServer` need the same probe-before-unlink dance to avoid silently
 * stealing another daemon's listener: a blind `unlinkSync` on a live Unix
 * socket file would orphan the bound listener (Linux/macOS allow unlink while
 * still bound) and the new server would happily `listen()` on the now-renamed
 * inode, leaving two daemons in conflict with no error.
 */

import { existsSync, unlinkSync } from "node:fs";
import { connect } from "node:net";

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
  if (!existsSync(socketPath)) return;
  await new Promise<void>((resolve, reject) => {
    const client = connect(socketPath);
    let settled = false;
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.removeAllListeners();
      client.destroy();
      action();
    };
    const timer = setTimeout(() => {
      settle(() =>
        reject(
          makeAddrInUseError(
            `EADDRINUSE: probe-connect to ${socketPath} did not settle within ${PROBE_CONNECT_TIMEOUT_MS}ms`,
          ),
        ),
      );
    }, PROBE_CONNECT_TIMEOUT_MS);
    client.once("connect", () => {
      settle(() =>
        reject(
          makeAddrInUseError(
            `EADDRINUSE: another daemon is listening at ${socketPath}`,
          ),
        ),
      );
    });
    client.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ECONNREFUSED" || err.code === "ENOENT") {
        settle(() => {
          try {
            unlinkSync(socketPath);
          } catch {
            // Ignore — may already be gone
          }
          resolve();
        });
      } else {
        settle(() => reject(err));
      }
    });
  });
}
