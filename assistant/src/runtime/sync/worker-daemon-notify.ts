/**
 * Worker → daemon hand-off for conversation message-persist notifications.
 *
 * Sidecar worker processes (schedule, memory) disable SSE seq stamping — the
 * daemon is the sole seq authority — so a worker's own `getCurrentSeq()`
 * reports `0` and its `publishConversationMessagesChanged` broadcast reaches no
 * SSE subscriber (those live in the daemon). After a worker persists a turn's
 * rows it hands the notification here; the daemon records an honest snapshot
 * anchor at its own seq and republishes the invalidation to real subscribers
 * (see `ipc/routes/conversation-sync-ipc-routes.ts`).
 */

import { cliIpcCall } from "../../ipc/cli-client.js";
import { getLogger } from "../../util/logger.js";

const log = getLogger("worker-daemon-notify");

/**
 * IPC method the daemon exposes for the worker hand-off. Shared by the worker
 * caller and the daemon route registration so the wire name cannot drift.
 */
export const NOTIFY_CONVERSATION_PERSISTED_IPC_METHOD =
  "notify_conversation_persisted_externally";

/**
 * Short timeout: this is a fire-and-forget invalidation, not a request whose
 * result the worker consumes. A busy or unreachable daemon simply leaves the
 * anchor stale until the client repairs it on its next snapshot fetch.
 */
const NOTIFY_TIMEOUT_MS = 3_000;

/**
 * Ask the daemon to record the snapshot anchor and republish the
 * messages-changed invalidation for `conversationId`.
 *
 * Best-effort by design: a daemon that is down, unreachable, or still running
 * migrations (the IPC method is DB-migration gated) yields a failed result that
 * is logged at debug and swallowed. No retries or queueing — the worker
 * persisted the rows regardless, and clients self-repair the stale anchor on
 * their next `/messages` fetch (switch/reload).
 */
export async function notifyDaemonConversationPersisted(
  conversationId: string,
): Promise<void> {
  try {
    const result = await cliIpcCall(
      NOTIFY_CONVERSATION_PERSISTED_IPC_METHOD,
      { body: { conversationId } },
      { timeoutMs: NOTIFY_TIMEOUT_MS },
    );
    if (!result.ok) {
      log.debug(
        { conversationId, error: result.error },
        "daemon conversation-persisted notify was not acknowledged",
      );
    }
  } catch (err) {
    log.debug(
      { err, conversationId },
      "daemon conversation-persisted notify failed",
    );
  }
}
