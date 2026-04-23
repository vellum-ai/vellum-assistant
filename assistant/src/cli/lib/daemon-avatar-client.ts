/**
 * CLI helper for notifying the daemon that the avatar has changed.
 *
 * Fire-and-forget: if the daemon is unreachable, the notification is silently
 * skipped. The avatar files are already written on disk; the client will pick
 * up the change on the next poll or reconnect.
 *
 * Follows the daemon HTTP fetch pattern established in daemon-credential-client.ts
 * (health check, JWT minting, HTTP call).
 */

import { getRuntimeHttpHost, getRuntimeHttpPort } from "../../config/env.js";
import { healthCheckHost, isHttpHealthy } from "../../daemon/daemon-control.js";
import {
  initAuthSigningKey,
  loadOrCreateSigningKey,
  mintDaemonDeliveryToken,
} from "../../runtime/auth/token-service.js";
import { getLogger } from "../../util/logger.js";

const log = getLogger("daemon-avatar-client");

/** Hard timeout for daemon HTTP requests to prevent CLI commands from hanging. */
const DAEMON_FETCH_TIMEOUT_MS = 60_000;

/**
 * Notify the running daemon that the avatar has been updated so it can
 * publish an `avatar_updated` SSE event to connected clients.
 *
 * Silently returns if the daemon is not running or the request fails.
 */
export async function notifyAvatarUpdated(): Promise<void> {
  try {
    if (!(await isHttpHealthy())) return;

    const port = getRuntimeHttpPort();
    const host = healthCheckHost(getRuntimeHttpHost());
    initAuthSigningKey(loadOrCreateSigningKey());
    const token = mintDaemonDeliveryToken();

    const res = await fetch(`http://${host}:${port}/v1/avatar/notify-updated`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(DAEMON_FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      log.warn(
        { status: res.status },
        "Daemon avatar notify-updated returned non-ok status",
      );
    }
  } catch (err) {
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "Failed to notify daemon of avatar update",
    );
  }
}
