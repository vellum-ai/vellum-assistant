export type { AcpAgentConfig, AcpSessionState } from "./types.js";

import { getConfig } from "../config/loader.js";
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
 * Returns the existing AcpSessionManager singleton, or null when none has been
 * created yet. Use this on cleanup hot paths (e.g. cancelling a conversation)
 * that must not spin up a manager just to discover there are no sessions to
 * act on.
 */
export function peekAcpSessionManager(): AcpSessionManager | null {
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
