export { AcpSessionManager } from "./session-manager.js";
export type { AcpAgentConfig, AcpSessionState } from "./types.js";

import { getConfig } from "../config/loader.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import { AcpSessionManager } from "./session-manager.js";

/** Singleton AcpSessionManager instance shared across the daemon. */
let manager: AcpSessionManager | null = null;

/**
 * Returns the singleton AcpSessionManager, creating it on first call
 * using the ACP config from getConfig().
 */
export function getAcpSessionManager(): AcpSessionManager {
  if (!manager) {
    const config = getConfig();
    manager = new AcpSessionManager(config.acp.maxConcurrentSessions);
  }
  return manager;
}

/**
 * Disposes the singleton AcpSessionManager and nulls the reference.
 */
export function disposeAcpSessionManager(): void {
  if (manager) {
    manager.dispose();
    manager = null;
  }
}

/**
 * Broadcast callback set by DaemonServer constructor so ACP session events
 * reach all connected SSE clients. Same pattern as
 * `getSubagentManager().broadcastToAllClients` in server.ts.
 */
export let broadcastToAllClients: ((msg: ServerMessage) => void) | null = null;

export function setBroadcastToAllClients(
  fn: (msg: ServerMessage) => void,
): void {
  broadcastToAllClients = fn;
}
