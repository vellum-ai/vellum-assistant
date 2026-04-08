/**
 * Registry mapping guardianId → active Chrome extension WebSocket connections.
 *
 * Populated by the `/v1/browser-relay` WebSocket upgrade handler when a
 * chrome-extension client connects; drained on close. Used by
 * conversation-routes.ts to route `host_browser_request` frames to the
 * connected extension for the appropriate guardian.
 *
 * This is the chrome-extension counterpart to the SSE hub used by the macOS
 * client for the same purpose.
 */

import type { ServerWebSocket } from "bun";

import type { ServerMessage } from "../daemon/message-protocol.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("chrome-extension-registry");

export interface ChromeExtensionConnection {
  /** Stable identifier for this WebSocket connection (used for unregister). */
  id: string;
  /** Guardian identity this connection is authenticated as. */
  guardianId: string;
  /** Underlying Bun WebSocket. */
  ws: ServerWebSocket<unknown>;
  /** Wall-clock timestamp (ms) when the connection was registered. */
  connectedAt: number;
}

/**
 * Module-level registry of active chrome-extension connections keyed by
 * guardianId. There is at most one connection per guardian — reconnects
 * supersede the prior entry by closing it first.
 */
export class ChromeExtensionRegistry {
  private byGuardian = new Map<string, ChromeExtensionConnection>();

  /**
   * Register a chrome-extension WebSocket for a guardian. If a prior
   * connection already exists for the same guardianId, it is closed and
   * replaced with the new one.
   */
  register(conn: ChromeExtensionConnection): void {
    const prior = this.byGuardian.get(conn.guardianId);
    if (prior && prior.id !== conn.id) {
      try {
        prior.ws.close(1000, "superseded by new connection");
      } catch {
        // Best-effort — the prior socket may already be closed.
      }
    }
    this.byGuardian.set(conn.guardianId, conn);
    log.info(
      { guardianId: conn.guardianId, connectionId: conn.id },
      "chrome extension registered",
    );
  }

  /**
   * Remove the entry with the given connectionId. No-op if no connection
   * with that id is currently registered — the entry may already have been
   * superseded by a newer registration.
   */
  unregister(connectionId: string): void {
    for (const [key, conn] of this.byGuardian) {
      if (conn.id === connectionId) {
        this.byGuardian.delete(key);
        log.info(
          { guardianId: key, connectionId },
          "chrome extension unregistered",
        );
        return;
      }
    }
  }

  /** Return the active connection for a guardian, if any. */
  get(guardianId: string): ChromeExtensionConnection | undefined {
    return this.byGuardian.get(guardianId);
  }

  /**
   * Send a ServerMessage to the chrome-extension connection for the given
   * guardian. Returns `true` when a connection exists and the send
   * succeeds; `false` when no connection is registered or when the
   * underlying `ws.send` throws.
   */
  send(guardianId: string, msg: ServerMessage): boolean {
    const conn = this.byGuardian.get(guardianId);
    if (!conn) return false;
    try {
      conn.ws.send(JSON.stringify(msg));
      return true;
    } catch (err) {
      log.warn({ guardianId, err }, "failed to send to chrome extension");
      return false;
    }
  }
}

// ── Module-level singleton (same pattern as assistant-event-hub) ──────────
let instance: ChromeExtensionRegistry | null = null;

export function getChromeExtensionRegistry(): ChromeExtensionRegistry {
  if (!instance) instance = new ChromeExtensionRegistry();
  return instance;
}

/**
 * Test helper: reset the module-level singleton so each test starts with a
 * fresh registry. Not exported from any public index — test-only.
 */
export function __resetChromeExtensionRegistryForTests(): void {
  instance = null;
}
