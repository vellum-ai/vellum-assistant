import { connect, type Socket } from "node:net";

import { refreshOverridesFromGateway } from "../config/assistant-feature-flags.js";
import { SYNC_TAGS } from "../daemon/message-types/sync.js";
import { publishSyncInvalidation } from "../runtime/sync/sync-publisher.js";
import { syncFlagGatedTools } from "../tools/registry.js";
import { getLogger } from "../util/logger.js";
import { resolveIpcSocketPath } from "./socket-path.js";

const log = getLogger("gateway-flag-listener");

/**
 * Refresh the flag-overrides cache from the gateway, then register any tools
 * whose flag gate has since opened. Both the `feature_flags_changed` event and a
 * reconnect only refresh the cache; without this follow-up, enabling a
 * tool-gating flag (e.g. `workflows`) at runtime would open the corresponding
 * routes' flag gate while the flag-gated tools (`run_workflow` /
 * `manage_workflows`, CES tools) stay absent from the registry until a daemon
 * restart. `syncFlagGatedTools` is idempotent and enable-only, so re-running it
 * on every refresh is safe; it also never throws (it logs internally).
 */
function refreshFlagsAndSyncTools(context: string): void {
  refreshOverridesFromGateway()
    .then(() => syncFlagGatedTools())
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
    if (!trimmed) continue;
    try {
      const msg = JSON.parse(trimmed) as { event?: string };
      if (msg.event === "feature_flags_changed") {
        log.info("Received feature_flags_changed event — refreshing overrides");
        refreshFlagsAndSyncTools("flags-changed event");
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
  if (stopped) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToGateway();
  }, currentBackoffMs);
  currentBackoffMs = Math.min(currentBackoffMs * 2, MAX_BACKOFF_MS);
}

function connectToGateway(): void {
  if (stopped) return;

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
    // A reconnect may have missed a flag flip while disconnected, so sync the
    // gated tools too — not just the cache.
    refreshFlagsAndSyncTools("reconnect");
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
