/**
 * IPC-only route for quiescing the daemon's external sockets ahead of a
 * gVisor pod checkpoint (GKE pod snapshot).
 *
 * A checkpoint captures the process's epoll set as-is. TCP connections whose
 * remote peer lives outside the sandbox (SSE streams held open by clients
 * through the platform, for example) are dead by definition after a restore,
 * and readiness events on them crash Bun's event loop (uSockets null-deref).
 * The gateway calls this method from its `/internal/prepare-for-checkpoint`
 * handler — invoked by vembda right before it triggers the snapshot — so the
 * daemon can close those connections while the pod is still healthy. Clients
 * reconnect through their normal SSE retry paths after the pod resumes.
 *
 * IPC-only: registered directly on the assistant IPC server (see
 * `assistant-server.ts`), never in the shared `ROUTES` array.
 */

import {
  beginCheckpointQuiesce,
  closeAllSseSubscriptions,
} from "../../runtime/checkpoint-quiesce.js";
import type { RouteHandlerArgs } from "../../runtime/routes/types.js";
import { getLogger } from "../../util/logger.js";

const log = getLogger("checkpoint-ipc");

/** IPC method name — called by the gateway's pre-checkpoint quiesce handler. */
export const CHECKPOINT_PREPARE_IPC_METHOD = "/checkpoint/prepare";

export type CheckpointPrepareResult = {
  ok: true;
  /** Number of event-hub client subscribers whose SSE streams were closed. */
  disposedSseClients: number;
};

export async function handleCheckpointPrepare(
  _args: RouteHandlerArgs,
): Promise<CheckpointPrepareResult> {
  // Latch first: SSE clients auto-retry within 1–2s, so admissions must stop
  // before existing streams close or a fresh external socket could slip into
  // the snapshot. The latch is wall-clock based and self-clears on restore.
  beginCheckpointQuiesce();
  // Close every SSE-backed subscription — client-identified or headerless
  // "process"-typed — via the events route's registry. Genuine in-process
  // subscribers (plugins, workers) never register and are untouched.
  const disposed = closeAllSseSubscriptions();
  log.info({ disposedSseClients: disposed }, "Pre-checkpoint quiesce complete");
  return { ok: true, disposedSseClients: disposed };
}

/**
 * IPC-only checkpoint methods, keyed by operationId. Registered directly on
 * the assistant IPC server (see `assistant-server.ts`).
 */
export const CHECKPOINT_IPC_METHODS: Record<
  string,
  (args: RouteHandlerArgs) => unknown
> = {
  [CHECKPOINT_PREPARE_IPC_METHOD]: handleCheckpointPrepare,
};
