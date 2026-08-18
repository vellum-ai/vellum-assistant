import { connect, type Socket } from "node:net";

import { refreshOverridesFromGateway } from "../config/assistant-feature-flags.js";
import { getBalancedModelExperimentArm } from "../config/balanced-model-experiment.js";
import { reconcileFlagGatedProfiles } from "../config/sync-gated-profiles.js";
import { SYNC_TAGS } from "../daemon/message-types/sync.js";
import { publishConfigChanged } from "../runtime/sync/resource-sync-events.js";
import { publishSyncInvalidation } from "../runtime/sync/sync-publisher.js";
import { getLogger } from "../util/logger.js";
import { resolveIpcSocketPath } from "./socket-path.js";

const log = getLogger("gateway-flag-listener");

/**
 * Refresh the flag-overrides cache from the gateway, then reconcile the
 * flag-gated managed profile (OS Beta). Both the `feature_flags_changed` event
 * and a reconnect refresh the cache; `reconcileFlagGatedProfiles` then adds or
 * removes the managed profile and, when it reports a change, a `config_changed`
 * broadcast refreshes the profile picker on clients. The reconcile runs only
 * when the refresh confirmed flags loaded from the gateway — a transient IPC
 * failure leaves the cache unset and resolves `os-beta` to its registry default
 * `false`, which would remove the user's profile and reset their selection.
 *
 * A new balanced-model experiment arm gets the same broadcast. It repoints what
 * the managed Balanced profile resolves to without moving anything on disk, so
 * the reconcile reports no change and clients would otherwise keep rendering
 * the previous model beside a profile already running the new one.
 */
function refreshFlagsAndReconcileProfiles(context: string): void {
  const balancedArmBefore = getBalancedModelExperimentArm();
  refreshOverridesFromGateway()
    .then((loaded) => {
      if (!loaded) {
        return;
      }
      const profilesChanged = reconcileFlagGatedProfiles();
      const balancedArmChanged =
        getBalancedModelExperimentArm() !== balancedArmBefore;
      if (profilesChanged || balancedArmChanged) {
        // Reuse the config-changed broadcast clients already consume: web
        // routes the `assistant:self:config` sync tag to the effective profile
        // catalog and the call-site catalog, both derived from config.
        publishConfigChanged();
      }
    })
    .catch((err) => {
      log.warn(
        { err },
        `Failed to refresh feature flag overrides (${context})`,
      );
    });
}

const MAX_BACKOFF_MS = 30_000;
const INITIAL_BACKOFF_MS = 1_000;

let socket: Socket | null = null;
let stopped = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let currentBackoffMs = INITIAL_BACKOFF_MS;

function getSocketPath(): string {
  return resolveIpcSocketPath("gateway").path;
}

function handleData(chunk: Buffer): void {
  const lines = chunk.toString().split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const msg = JSON.parse(trimmed) as { event?: string };
      if (msg.event === "feature_flags_changed") {
        log.info("Received feature_flags_changed event — refreshing overrides");
        refreshFlagsAndReconcileProfiles("flags-changed event");
        // Fan out to every connected web client so React Query caches
        // for `/v1/feature-flags/client-flag-values/` and
        // `/v1/assistants/:id/feature-flags` invalidate immediately
        // instead of waiting on a 5s polling tick.
        publishSyncInvalidation([
          SYNC_TAGS.featureFlagsClient,
          SYNC_TAGS.featureFlagsAssistant,
        ]).catch((err) => {
          log.warn({ err }, "Failed to broadcast feature-flags sync_changed");
        });
      }
    } catch {
      // Ignore non-JSON lines (e.g. IPC responses on a shared socket)
    }
  }
}

function scheduleReconnect(): void {
  if (stopped) {
    return;
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToGateway();
  }, currentBackoffMs);
  currentBackoffMs = Math.min(currentBackoffMs * 2, MAX_BACKOFF_MS);
}

function connectToGateway(): void {
  if (stopped) {
    return;
  }

  const socketPath = getSocketPath();
  const conn = connect(socketPath);

  conn.on("connect", () => {
    if (stopped) {
      conn.destroy();
      return;
    }
    log.info("Connected to gateway IPC for flag events");
    currentBackoffMs = INITIAL_BACKOFF_MS;
    socket = conn;
    // A reconnect may have missed a flag flip while disconnected, so reconcile
    // the managed profile too — not just the cache.
    refreshFlagsAndReconcileProfiles("reconnect");
  });

  let buffer = "";
  conn.on("data", (chunk) => {
    buffer += chunk.toString();
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      if (line.trim()) {
        handleData(Buffer.from(line));
      }
    }
  });

  conn.on("close", () => {
    socket = null;
    if (!stopped) {
      log.debug("Gateway IPC connection closed — reconnecting");
      scheduleReconnect();
    }
  });

  conn.on("error", (err) => {
    log.debug({ err }, "Gateway IPC connection error");
    conn.destroy();
  });
}

export function startGatewayFlagListener(): void {
  stopped = false;
  currentBackoffMs = INITIAL_BACKOFF_MS;
  connectToGateway();
}

export function stopGatewayFlagListener(): void {
  stopped = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    socket.destroy();
    socket = null;
  }
}
