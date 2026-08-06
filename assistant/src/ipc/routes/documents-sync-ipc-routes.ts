/**
 * IPC-only route the sidecar workers (schedule, memory) call after a turn
 * changed a document.
 *
 * Workers disable SSE seq stamping (`disableStreamSeqStamping`) so the daemon
 * is the sole seq authority, and the SSE subscribers live in the daemon too. A
 * worker that published `documents:list` on its own hub would reach nobody, so
 * a scheduled or background turn's document edit would stay invisible: the
 * conversation assets pill and the Library would keep serving their cached
 * list. That is precisely the case the changed-document surfacing exists for.
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
import { publishDocumentsChanged } from "../../runtime/sync/resource-sync-events.js";
import { NOTIFY_DOCUMENTS_CHANGED_IPC_METHOD } from "../../runtime/sync/worker-daemon-notify.js";

/** Republish a worker's documents-changed invalidation to daemon subscribers. */
export function handleNotifyDocumentsChanged(_args: RouteHandlerArgs) {
  publishDocumentsChanged();
  return { ok: true };
}

/**
 * IPC-only documents-sync methods, keyed by operationId. Registered directly on
 * the assistant IPC server (see `assistant-server.ts`).
 */
export const DOCUMENTS_SYNC_IPC_METHODS: Record<
  string,
  (args: RouteHandlerArgs) => unknown
> = {
  [NOTIFY_DOCUMENTS_CHANGED_IPC_METHOD]: handleNotifyDocumentsChanged,
};
