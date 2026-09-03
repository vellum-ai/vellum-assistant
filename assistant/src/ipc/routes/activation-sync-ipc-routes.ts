/**
 * IPC-only route the sidecar workers (schedule, memory) call after a turn
 * moved a launched checklist task.
 *
 * Workers disable SSE seq stamping (`disableStreamSeqStamping`) so the daemon
 * is the sole seq authority, and the SSE subscribers live in the daemon too. A
 * worker that published `activation:progress` on its own hub would reach
 * nobody, so a task worked by a scheduled or background turn would keep
 * showing as running until the client refetched for some other reason.
 *
 * This route runs the publish on the daemon instead, where real subscribers
 * observe it. The hand-off carries no originating client, so nothing suppresses
 * the broadcast as its own echo.
 *
 * IPC-only: registered directly on the assistant IPC server (see
 * `assistant-server.ts`), never in the shared `ROUTES` array. The handler
 * touches no database, but the IPC server's uniform DB-migration gate still
 * applies (the method is not exempt); the worker's call is best-effort and
 * tolerates that.
 */

import type { RouteHandlerArgs } from "../../runtime/routes/types.js";
import { publishActivationProgressChanged } from "../../runtime/sync/resource-sync-events.js";
import { NOTIFY_ACTIVATION_PROGRESS_CHANGED_IPC_METHOD } from "../../runtime/sync/worker-daemon-notify.js";

/** Republish a worker's activation-progress invalidation to daemon subscribers. */
export function handleNotifyActivationProgressChanged(_args: RouteHandlerArgs) {
  publishActivationProgressChanged();
  return { ok: true };
}

/**
 * IPC-only activation-sync methods, keyed by operationId. Registered directly
 * on the assistant IPC server (see `assistant-server.ts`).
 */
export const ACTIVATION_SYNC_IPC_METHODS: Record<
  string,
  (args: RouteHandlerArgs) => unknown
> = {
  [NOTIFY_ACTIVATION_PROGRESS_CHANGED_IPC_METHOD]:
    handleNotifyActivationProgressChanged,
};
