/**
 * CLI helper for notifying the daemon that the avatar has changed.
 *
 * Fire-and-forget: if the daemon is unreachable, the notification is silently
 * skipped. The avatar files are already written on disk; the client will pick
 * up the change on the next poll or reconnect.
 *
 * Uses Unix domain socket IPC (the preferred CLI-to-daemon transport).
 */

import { cliIpcCall } from "../../ipc/cli-client.js";
import { getLogger } from "../../util/logger.js";

const log = getLogger("daemon-avatar-client");

/**
 * Notify the running daemon that the avatar has been updated so it can
 * publish an `avatar_updated` SSE event to connected clients.
 *
 * Silently returns if the daemon is not running or the request fails.
 */
export async function notifyAvatarUpdated(): Promise<void> {
  try {
    const result = await cliIpcCall("notify_avatar_updated");
    if (!result.ok) {
      log.warn(
        { error: result.error },
        "Failed to notify daemon of avatar update",
      );
    }
  } catch (err) {
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "Failed to notify daemon of avatar update",
    );
  }
}
