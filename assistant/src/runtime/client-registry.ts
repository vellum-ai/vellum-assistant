/**
 * Unified registry of active client connections.
 *
 * Tracks all clients currently connected to the assistant — macOS desktop
 * (SSE), iOS (SSE), web (SSE), chrome-extension (WebSocket), CLI, and
 * channel interfaces. Each entry records the interface type, derived
 * capabilities, and connection timestamps.
 *
 * The registry is populated by:
 *   - SSE /events route (events-routes.ts) — registers on connect,
 *     unregisters on disconnect, touches on heartbeat.
 *
 * Future enhancements:
 *   - Surface ChromeExtensionRegistry entries through `listAll()`
 *
 * Consumers:
 *   - `assistant clients list` CLI command (via `list_clients` IPC route)
 *   - Future: deferred host tool routing (Phase 2)
 */

import type { HostProxyCapability, InterfaceId } from "../channels/types.js";
import { supportsHostProxy } from "../channels/types.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("client-registry");

/**
 * Default staleness threshold: entries not refreshed within this window are
 * evicted on the next read. 30 minutes is generous — messages refresh the
 * entry on every turn, so any actively used client stays well within this.
 */
const DEFAULT_STALE_AGE_MS = 30 * 60 * 1000;

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

/**
 * Opaque send function attached to a client entry. When present, the
 * registry can deliver messages to this client without knowing the
 * underlying transport (WebSocket, SSE, IPC, etc.).
 *
 * Returns `true` when the message was accepted by the transport layer;
 * `false` when the send fails (e.g. socket closed).
 */
export type ClientSendFn = (msg: unknown) => boolean;

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
  /**
   * Transport-level send function. Optional — only populated for clients
   * whose transport supports outbound delivery from the registry (e.g.
   * chrome-extension WebSocket). Callers should check availability before
   * invoking.
   */
  send?: ClientSendFn;
}

/** Serialized form returned by the IPC route / CLI command. */
export interface ClientEntryJSON {
  clientId: string;
  interfaceId: InterfaceId;
  capabilities: HostProxyCapability[];
  connectedAt: string;
  lastActiveAt: string;
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
   * is updated. Otherwise a new entry is created with derived capabilities.
   */
  register(opts: {
    clientId: string;
    interfaceId: InterfaceId;
    send?: ClientSendFn;
  }): ClientEntry {
    const existing = this.clients.get(opts.clientId);
    const now = Date.now();

    if (existing) {
      existing.lastActiveAt = now;
      if (opts.send) existing.send = opts.send;
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
      send: opts.send,
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
   * (most recently active first). Lazily evicts stale entries before
   * returning so disconnected clients don't linger indefinitely.
   */
  listAll(): ClientEntry[] {
    this.evictStale();
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
   * Return all registered clients with the given interface type,
   * sorted by `lastActiveAt` descending.
   */
  listByInterface(interfaceId: InterfaceId): ClientEntry[] {
    return this.listAll().filter((e) => e.interfaceId === interfaceId);
  }

  /**
   * Return the most recently active client with the given interface type,
   * or `undefined` if none exists.
   */
  getMostRecentByInterface(interfaceId: InterfaceId): ClientEntry | undefined {
    return this.listByInterface(interfaceId)[0];
  }

  /**
   * Send a message to the most recently active client that supports the
   * given capability. Returns `true` when the message was accepted by the
   * transport, `false` when no client with a `send` function is available
   * or the underlying send fails.
   *
   * On success, bumps the client's `lastActiveAt` so subsequent sends
   * continue to target the same client.
   */
  sendToCapability(capability: HostProxyCapability, msg: unknown): boolean {
    const client = this.getMostRecentByCapability(capability);
    if (!client?.send) return false;
    const ok = client.send(msg);
    if (ok) client.lastActiveAt = Date.now();
    return ok;
  }

  /**
   * Remove entries whose `lastActiveAt` is older than `maxAgeMs`.
   * Called lazily before reads to prevent unbounded map growth from
   * churning client IDs that are never explicitly unregistered.
   *
   * @returns Number of evicted entries.
   */
  evictStale(maxAgeMs: number = DEFAULT_STALE_AGE_MS): number {
    const cutoff = Date.now() - maxAgeMs;
    let evicted = 0;
    for (const [id, entry] of this.clients) {
      if (entry.lastActiveAt < cutoff) {
        this.clients.delete(id);
        evicted++;
        log.debug(
          { clientId: id, interfaceId: entry.interfaceId },
          "client evicted (stale)",
        );
      }
    }
    return evicted;
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
