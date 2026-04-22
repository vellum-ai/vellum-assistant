/**
 * Unified registry of active client connections.
 *
 * Tracks all clients currently connected to the assistant — macOS desktop
 * (SSE), iOS (SSE), web (SSE), chrome-extension (WebSocket), CLI, and
 * channel interfaces. Each entry records the interface type, derived
 * capabilities, connection timestamps, and optional host environment fields.
 *
 * The registry is populated by:
 *   - `handleSendMessage` in conversation-routes.ts (registers/refreshes on
 *     every inbound message with the interface and transport metadata)
 *
 * Future enhancements:
 *   - Deregister on SSE disconnect (events-routes.ts abort signal)
 *   - Surface ChromeExtensionRegistry entries through `listAll()`
 *   - Stale-client eviction sweep
 *
 * Consumers:
 *   - `assistant clients list` CLI command (via `list_clients` IPC route)
 *   - Future: deferred host tool routing (Phase 2)
 */

import type { HostProxyCapability, InterfaceId } from "../channels/types.js";
import { supportsHostProxy } from "../channels/types.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("client-registry");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** All host-proxy capabilities checked against each interface on register. */
const ALL_CAPABILITIES: HostProxyCapability[] = [
  "host_bash",
  "host_file",
  "host_cu",
  "host_browser",
];

export interface ClientEntry {
  /** Stable identifier for this client connection. */
  clientId: string;
  /** Interface type (e.g. "macos", "ios", "web", "chrome-extension"). */
  interfaceId: InterfaceId;
  /** Host-proxy capabilities this client supports. */
  capabilities: HostProxyCapability[];
  /** Wall-clock timestamp (ms) when the client first connected. */
  connectedAt: number;
  /** Wall-clock timestamp (ms) of the most recent activity. */
  lastActiveAt: number;
  /** Home directory on the host machine (only for host-proxy interfaces). */
  hostHomeDir?: string;
  /** Username on the host machine (only for host-proxy interfaces). */
  hostUsername?: string;
}

/** Serialized form returned by the IPC route / CLI command. */
export interface ClientEntryJSON {
  clientId: string;
  interfaceId: InterfaceId;
  capabilities: HostProxyCapability[];
  connectedAt: string;
  lastActiveAt: string;
  hostHomeDir?: string;
  hostUsername?: string;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class ClientRegistry {
  private clients = new Map<string, ClientEntry>();

  /**
   * Register or refresh a client connection.
   *
   * If a client with the same `clientId` already exists, its `lastActiveAt`
   * and host environment fields are updated. Otherwise a new entry is created.
   */
  register(opts: {
    clientId: string;
    interfaceId: InterfaceId;
    hostHomeDir?: string;
    hostUsername?: string;
  }): ClientEntry {
    const existing = this.clients.get(opts.clientId);
    const now = Date.now();

    if (existing) {
      existing.lastActiveAt = now;
      if (opts.hostHomeDir !== undefined) {
        existing.hostHomeDir = opts.hostHomeDir;
      }
      if (opts.hostUsername !== undefined) {
        existing.hostUsername = opts.hostUsername;
      }
      log.debug(
        { clientId: opts.clientId, interfaceId: opts.interfaceId },
        "client refreshed",
      );
      return existing;
    }

    const capabilities = ALL_CAPABILITIES.filter((cap) =>
      supportsHostProxy(opts.interfaceId, cap),
    );

    const entry: ClientEntry = {
      clientId: opts.clientId,
      interfaceId: opts.interfaceId,
      capabilities,
      connectedAt: now,
      lastActiveAt: now,
      hostHomeDir: opts.hostHomeDir,
      hostUsername: opts.hostUsername,
    };

    this.clients.set(opts.clientId, entry);
    log.info(
      {
        clientId: opts.clientId,
        interfaceId: opts.interfaceId,
        capabilities,
      },
      "client registered",
    );
    return entry;
  }

  /**
   * Remove a client connection. No-op if the clientId is not registered.
   */
  unregister(clientId: string): void {
    const entry = this.clients.get(clientId);
    if (!entry) return;
    this.clients.delete(clientId);
    log.info(
      { clientId, interfaceId: entry.interfaceId },
      "client unregistered",
    );
  }

  /**
   * Update `lastActiveAt` for a client without changing other fields.
   * No-op if the clientId is not registered.
   */
  touch(clientId: string): void {
    const entry = this.clients.get(clientId);
    if (entry) {
      entry.lastActiveAt = Date.now();
    }
  }

  /**
   * Return a specific client entry, or `undefined` if not registered.
   */
  get(clientId: string): ClientEntry | undefined {
    return this.clients.get(clientId);
  }

  /**
   * Return all registered clients, sorted by `lastActiveAt` descending
   * (most recently active first).
   */
  listAll(): ClientEntry[] {
    return Array.from(this.clients.values()).sort(
      (a, b) => b.lastActiveAt - a.lastActiveAt,
    );
  }

  /**
   * Return all registered clients that support the given capability,
   * sorted by `lastActiveAt` descending.
   */
  listByCapability(capability: HostProxyCapability): ClientEntry[] {
    return this.listAll().filter((e) => e.capabilities.includes(capability));
  }

  /**
   * Return the most recently active client that supports the given
   * capability, or `undefined` if none exists.
   */
  getMostRecentByCapability(
    capability: HostProxyCapability,
  ): ClientEntry | undefined {
    return this.listByCapability(capability)[0];
  }

  /**
   * Number of currently registered clients.
   */
  get size(): number {
    return this.clients.size;
  }

  /**
   * Serialize a client entry to JSON (ISO timestamps).
   */
  static toJSON(entry: ClientEntry): ClientEntryJSON {
    return {
      clientId: entry.clientId,
      interfaceId: entry.interfaceId,
      capabilities: entry.capabilities,
      connectedAt: new Date(entry.connectedAt).toISOString(),
      lastActiveAt: new Date(entry.lastActiveAt).toISOString(),
      ...(entry.hostHomeDir ? { hostHomeDir: entry.hostHomeDir } : {}),
      ...(entry.hostUsername ? { hostUsername: entry.hostUsername } : {}),
    };
  }
}

// ── Module-level singleton ────────────────────────────────────────────────

let instance: ClientRegistry | null = null;

export function getClientRegistry(): ClientRegistry {
  if (!instance) instance = new ClientRegistry();
  return instance;
}

/**
 * Test helper: reset the module-level singleton so each test starts with a
 * fresh registry.
 */
export function __resetClientRegistryForTests(): void {
  instance = null;
}
