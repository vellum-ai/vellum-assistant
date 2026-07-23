/**
 * Pre-checkpoint socket quiesce — `POST /internal/prepare-for-checkpoint`.
 *
 * Called by the platform control plane (vembda) right before it triggers a
 * gVisor pod checkpoint (GKE pod snapshot). A checkpoint captures each
 * process's epoll set as-is; TCP connections whose remote peer lives outside
 * the sandbox (the Velay tunnel, the Slack Socket Mode connection, SSE
 * streams held by the daemon) are dead by definition after a restore, and
 * readiness events on them crash Bun's event loop (uSockets null-deref in
 * `us_internal_dispatch_ready_poll`). This handler closes every external
 * long-lived socket the pod owns so the snapshot holds none:
 *
 *  1. asks the daemon (over the restore-safe in-pod IPC socket) to close its
 *     external connections, and
 *  2. closes the gateway's own — the Velay tunnel and the Slack socket —
 *     with a short reconnect holdoff so the reconnect can't race the
 *     checkpoint.
 *
 * After the pod resumes, the existing wake detection (epoch-gap) and the
 * holdoff expiry re-establish every connection through the normal reconnect
 * paths. The call is strictly best-effort on the vembda side: any failure
 * here only means the capture proceeds unquiesced.
 *
 * Exposure: the route only exists on managed-platform pods (`IS_PLATFORM`),
 * where the gateway port is cluster-internal; self-hosted deployments (which
 * may publish the port publicly) get a 404. The Velay allowlist excludes it
 * from the public tunnel and the handler additionally rejects tunnel-bridged
 * and edge-proxied requests. Its effect is a transient, self-healing
 * disconnect.
 */

import {
  ipcCallAssistant,
  IpcHandlerError,
} from "../../ipc/assistant-client.js";
import { getLogger } from "../../logger.js";
import { VELAY_FORWARDED_HEADER } from "../../velay/bridge-utils.js";
import { requestArrivedViaEdgeProxy } from "../edge-forwarded-header.js";
import { errorResponse } from "../loopback-guard.js";

const log = getLogger("checkpoint-quiesce");

/** IPC method registered by the daemon (see assistant checkpoint-ipc-routes). */
export const CHECKPOINT_PREPARE_IPC_METHOD = "/checkpoint/prepare";

const DAEMON_QUIESCE_TIMEOUT_MS = 3_000;

export type CheckpointQuiesceDeps = {
  velayTunnelClient:
    | { prepareForCheckpoint(): boolean | Promise<boolean> }
    | undefined;
  getSlackSocketClient: () => {
    prepareForCheckpoint(): boolean | Promise<boolean>;
  } | null;
  /** Injectable for tests; defaults to the real IPC client. */
  callAssistant?: typeof ipcCallAssistant;
  /** Injectable for tests; defaults to the IS_PLATFORM env detection. */
  isPlatform?: boolean;
};

/**
 * Pod snapshots only exist on the managed platform, where the gateway port is
 * cluster-internal. Self-hosted deployments can expose the gateway port
 * publicly (Docker publish, GCP firewall), so the route must not exist there.
 */
function isPlatformDeployment(): boolean {
  const raw = process.env.IS_PLATFORM?.trim().toLowerCase();
  return raw === "true" || raw === "1";
}

export async function handleCheckpointQuiesce(
  req: Request,
  deps: CheckpointQuiesceDeps,
): Promise<Response> {
  // Every response (including rejections) sends Connection: close so the
  // request that initiates the capture can't itself linger as an idle
  // keep-alive socket in the epoll set the checkpoint is about to freeze.
  const withConnectionClose = (res: Response): Response => {
    res.headers.set("connection", "close");
    return res;
  };

  // Managed-platform pods only — on self-hosted deployments the gateway port
  // can be publicly reachable and there is no checkpoint control plane, so
  // the route does not exist.
  if (!(deps.isPlatform ?? isPlatformDeployment())) {
    return withConnectionClose(errorResponse("NOT_FOUND", "not found", 404));
  }
  // In-cluster control-plane only: never reachable through the public tunnel
  // or the self-hosted edge.
  if (req.headers.get(VELAY_FORWARDED_HEADER)) {
    return withConnectionClose(
      errorResponse("FORBIDDEN", "endpoint is cluster-internal", 403),
    );
  }
  if (requestArrivedViaEdgeProxy(req)) {
    return withConnectionClose(
      errorResponse("FORBIDDEN", "endpoint is cluster-internal", 403),
    );
  }

  const callAssistant = deps.callAssistant ?? ipcCallAssistant;

  const quiesceDaemon = async (): Promise<Record<string, unknown>> => {
    try {
      return (await callAssistant(
        CHECKPOINT_PREPARE_IPC_METHOD,
        {},
        { timeoutMs: DAEMON_QUIESCE_TIMEOUT_MS },
      )) as Record<string, unknown>;
    } catch (err) {
      // Tolerated: old daemon images without the method (IpcHandlerError),
      // IPC transport failures, timeouts. The capture proceeds either way.
      log.warn(
        { err, tolerated: err instanceof IpcHandlerError },
        "Daemon pre-checkpoint quiesce failed",
      );
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };

  // Concurrent: the three quiesce operations are independent, and their
  // worst-case waits (3s IPC + 2s + 2s close-handshake bounds) must overlap
  // to stay inside vembda's 5s request budget. Each socket close resolves
  // only once its handshake finished (or was force-terminated), so the 200
  // below still means the sockets are gone.
  const [daemon, velayTunnelClosed, slackSocketClosed] = await Promise.all([
    quiesceDaemon(),
    Promise.resolve(deps.velayTunnelClient?.prepareForCheckpoint() ?? false),
    Promise.resolve(
      deps.getSlackSocketClient()?.prepareForCheckpoint() ?? false,
    ),
  ]);

  const summary = {
    ok: true,
    gateway: { velayTunnelClosed, slackSocketClosed },
    daemon,
  };
  log.info(summary, "Pre-checkpoint quiesce complete");
  return withConnectionClose(Response.json(summary));
}
