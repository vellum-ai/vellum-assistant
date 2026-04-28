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
 *
 * A single guardian may have multiple simultaneous extension connections —
 * e.g. the same guardian signed in on two Chrome profiles, two desktops
 * sharing a sync identity, or a power user with parallel installs for
 * testing. Each install generates a stable `clientInstanceId` on first
 * run and sends it on every handshake; the registry keys inner entries by
 * that id so sibling instances don't evict each other on register/unregister.
 *
 * Routing semantics:
 *   - When a caller does not pin a specific instance, the registry picks
 *     the "most recently active" instance for the guardian (highest
 *     `lastActiveAt` timestamp). `lastActiveAt` is bumped on register and
 *     on every successful `send()` — but NOT by keepalive pings. Keepalive
 *     frames update a separate `lastKeepaliveAt` field that is used only
 *     for liveness checks, preventing idle instances from stealing the
 *     routing default via periodic keepalive traffic.
 *   - When no `clientInstanceId` is present on the handshake (older
 *     extension builds, dev bypass paths), we synthesize a placeholder
 *     `legacy:<connectionId>` key. The send/lookup path treats it the
 *     same as any other instance so the call site stays uniform. The
 *     synthesized key is deliberately connection-scoped so a stale
 *     legacy unregister can never evict a newer entry.
 */

import type { ServerWebSocket } from "bun";

import type { ServerMessage } from "../daemon/message-protocol.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("chrome-extension-registry");

/** Prefix applied to synthesized instance ids for connections that did not
 * provide a client-supplied `clientInstanceId` at handshake time. Kept
 * distinct from any plausible client-generated value so it never collides
 * with a real install id. */
const LEGACY_INSTANCE_PREFIX = "legacy:";

export interface ChromeExtensionConnection {
  /** Stable identifier for this WebSocket connection (used for unregister). */
  id: string;
  /** Guardian identity this connection is authenticated as. */
  guardianId: string;
  /**
   * Stable per-extension-install identifier (persists across browser
   * restarts, survives service-worker teardown). Absent on older
   * extension builds and on dev-bypass paths — the registry synthesizes
   * a `legacy:<connectionId>` key in that case so sibling multi-instance
   * semantics degrade gracefully to single-instance behavior.
   */
  clientInstanceId?: string;
  /** Underlying Bun WebSocket. */
  ws: ServerWebSocket<unknown>;
  /** Wall-clock timestamp (ms) when the connection was registered. */
  connectedAt: number;
  /**
   * Wall-clock timestamp (ms) of the most recent activity on this
   * connection — updated on register and on each successful `send()`.
   * Used by the default-send routing path to pick the "most recently
   * active" instance when the caller does not pin a specific one.
   *
   * Crucially, this is NOT updated by keepalive pings — those update
   * `lastKeepaliveAt` instead. This separation prevents idle instances
   * from stealing the routing default via periodic keepalive traffic.
   */
  lastActiveAt: number;
  /**
   * Wall-clock timestamp (ms) of the most recent keepalive ping
   * received on this connection. Updated exclusively by `touch()`
   * (i.e. keepalive frames). Does NOT affect routing — used only for
   * liveness checks (e.g. a future stale-connection sweep can evict
   * connections whose `lastKeepaliveAt` is too far in the past).
   */
  lastKeepaliveAt?: number;
  /**
   * Monotonic registration sequence number assigned by the registry
   * on each `register()` call. Used as a tuple-secondary tiebreaker
   * after `lastActiveAt` when picking the default active instance, so
   * two sibling instances that share the same millisecond timestamp
   * deterministically resolve to the most recently registered entry.
   *
   * Not used when the registry routes to an explicit instance via
   * `sendToInstance` / `getInstance`. Clients should treat this as an
   * internal field — it's assigned by `register()` and callers don't
   * need to populate it when constructing a connection.
   */
  registrationSeq?: number;
}

/**
 * Module-level registry of active chrome-extension connections keyed by
 * guardianId, then by clientInstanceId. Multiple concurrent connections
 * under the same guardian are supported; reconnects of the *same* install
 * supersede the prior entry for that instance only, leaving sibling
 * instances untouched.
 */
export class ChromeExtensionRegistry {
  private byGuardian = new Map<
    string,
    Map<string, ChromeExtensionConnection>
  >();
  /**
   * Monotonic counter stamped onto each registration as
   * `registrationSeq`, used as a secondary tiebreaker after
   * `lastActiveAt` in the default routing path. Starts at 0 and
   * increments before stamping so the first registered connection has
   * `registrationSeq === 1`.
   *
   * This exists because `lastActiveAt` is `Date.now()`, which has
   * millisecond resolution at best; two sibling instances that
   * register (or transmit) in the same millisecond would otherwise
   * resolve ties via insertion order of `Map#values()`, which is
   * technically well-defined but is not the "most recently registered"
   * behavior a caller would expect. A monotonic counter fixes that
   * deterministically.
   */
  private seqCounter = 0;

  /**
   * Resolve the effective instance key for a connection. Prefers the
   * client-supplied `clientInstanceId`; falls back to a
   * connection-scoped `legacy:<connectionId>` placeholder when absent
   * so older clients get stable single-instance semantics without
   * clobbering sibling instances for the same guardian.
   */
  private keyFor(conn: ChromeExtensionConnection): string {
    return conn.clientInstanceId ?? `${LEGACY_INSTANCE_PREFIX}${conn.id}`;
  }

  /**
   * Register a chrome-extension WebSocket for a guardian + instance.
   * If a prior connection already exists for the same guardianId AND
   * clientInstanceId (i.e. the same install reconnecting), it is closed
   * and replaced with the new one. Sibling instances for the same
   * guardian are left untouched.
   */
  register(conn: ChromeExtensionConnection): void {
    let instances = this.byGuardian.get(conn.guardianId);
    if (!instances) {
      instances = new Map();
      this.byGuardian.set(conn.guardianId, instances);
    }

    const instanceKey = this.keyFor(conn);
    const prior = instances.get(instanceKey);
    if (prior && prior.id !== conn.id) {
      try {
        prior.ws.close(1000, "superseded by new connection");
      } catch {
        // Best-effort — the prior socket may already be closed.
      }
    }
    // Stamp lastActiveAt on (re-)register so the "most recently active"
    // routing heuristic treats a fresh connection as the current default
    // target for its guardian. Stamp a monotonic registrationSeq
    // alongside it so two registrations that land in the same
    // millisecond resolve deterministically to the newer one.
    conn.lastActiveAt = Date.now();
    conn.registrationSeq = ++this.seqCounter;
    instances.set(instanceKey, conn);
    log.info(
      {
        guardianId: conn.guardianId,
        connectionId: conn.id,
        clientInstanceId: conn.clientInstanceId,
        registrationSeq: conn.registrationSeq,
        instanceCount: instances.size,
      },
      "chrome extension registered",
    );
  }

  /**
   * Remove the entry with the given connectionId. No-op if no connection
   * with that id is currently registered — the entry may already have been
   * superseded by a newer registration for the same instance, or the
   * guardian may have zero active instances remaining.
   *
   * Importantly, this does not evict sibling instances under the same
   * guardian — multi-instance routing depends on keeping them alive
   * across single-instance reconnects.
   */
  unregister(connectionId: string): void {
    for (const [guardianId, instances] of this.byGuardian) {
      for (const [instanceKey, conn] of instances) {
        if (conn.id === connectionId) {
          instances.delete(instanceKey);
          if (instances.size === 0) {
            this.byGuardian.delete(guardianId);
          }
          log.info(
            {
              guardianId,
              connectionId,
              clientInstanceId: conn.clientInstanceId,
              remaining: instances.size,
            },
            "chrome extension unregistered",
          );
          return;
        }
      }
    }
  }

  /**
   * Update the `lastKeepaliveAt` timestamp for the connection identified
   * by `connectionId`, without changing routing semantics or registration
   * state. Used by keepalive frames to signal that the extension is still
   * alive and reachable. Deliberately does NOT update `lastActiveAt` — that
   * field is reserved for actual CDP traffic (register, send) so that idle
   * instances cannot steal the routing default via periodic keepalive pings.
   *
   * No-op if no connection with the given id is currently registered
   * (e.g. after a race between disconnect and a trailing keepalive frame).
   */
  touch(connectionId: string): void {
    for (const instances of this.byGuardian.values()) {
      for (const conn of instances.values()) {
        if (conn.id === connectionId) {
          conn.lastKeepaliveAt = Date.now();
          return;
        }
      }
    }
  }

  /**
   * Return the default "active" connection for a guardian — the
   * instance with the most recent `lastActiveAt` timestamp. Ties on
   * `lastActiveAt` (common when two sibling instances register or
   * transmit within the same millisecond) are broken by the monotonic
   * `registrationSeq` counter, which deterministically prefers the
   * most recently registered instance. Returns `undefined` when no
   * instances are registered for the guardian.
   *
   * Callers that want to pin a specific instance should use
   * {@link getInstance} instead.
   */
  get(guardianId: string): ChromeExtensionConnection | undefined {
    const instances = this.byGuardian.get(guardianId);
    if (!instances || instances.size === 0) return undefined;
    let best: ChromeExtensionConnection | undefined;
    for (const conn of instances.values()) {
      if (!best) {
        best = conn;
        continue;
      }
      if (conn.lastActiveAt > best.lastActiveAt) {
        best = conn;
      } else if (
        conn.lastActiveAt === best.lastActiveAt &&
        (conn.registrationSeq ?? 0) > (best.registrationSeq ?? 0)
      ) {
        best = conn;
      }
    }
    return best;
  }

  /**
   * Return the connection for an explicit (guardianId, clientInstanceId)
   * pair, or `undefined` if no such instance is registered. Used by
   * routing callers that need to target a specific extension install
   * (e.g. sending a follow-up frame to the same instance that produced
   * the prior result).
   */
  getInstance(
    guardianId: string,
    clientInstanceId: string,
  ): ChromeExtensionConnection | undefined {
    return this.byGuardian.get(guardianId)?.get(clientInstanceId);
  }

  /**
   * Return all currently registered connections for a guardian. Order
   * is insertion order of the inner map — callers that care about
   * recency should sort by `lastActiveAt` themselves.
   */
  listInstances(guardianId: string): ChromeExtensionConnection[] {
    const instances = this.byGuardian.get(guardianId);
    if (!instances) return [];
    return Array.from(instances.values());
  }

  /**
   * Return the most recently active connection across ALL guardians.
   * Used by conversation-less code paths (e.g. CLI `assistant browser`)
   * that need to route through any available extension without knowing
   * the guardian ID upfront.
   */
  getAny(): ChromeExtensionConnection | undefined {
    let best: ChromeExtensionConnection | undefined;
    for (const instances of this.byGuardian.values()) {
      for (const conn of instances.values()) {
        if (
          !best ||
          conn.lastActiveAt > best.lastActiveAt ||
          (conn.lastActiveAt === best.lastActiveAt &&
            (conn.registrationSeq ?? 0) > (best.registrationSeq ?? 0))
        ) {
          best = conn;
        }
      }
    }
    return best;
  }

  /**
   * Send a ServerMessage to the default active chrome-extension
   * connection for the given guardian. The "default active" instance
   * is the one with the most recent `lastActiveAt` timestamp — i.e.
   * the install the user is currently driving.
   *
   * Returns `true` when a connection exists and the send succeeds;
   * `false` when no connection is registered or when the underlying
   * `ws.send` throws. On a successful send, the connection's
   * `lastActiveAt` is bumped so subsequent default sends stay on the
   * same instance unless another sibling becomes more recent.
   */
  send(guardianId: string, msg: ServerMessage): boolean {
    const conn = this.get(guardianId);
    if (!conn) return false;
    return this.sendTo(conn, msg);
  }

  /**
   * Send a ServerMessage to an explicit (guardianId, clientInstanceId)
   * pair. Returns `false` when no matching instance is registered or
   * when the underlying `ws.send` throws.
   */
  sendToInstance(
    guardianId: string,
    clientInstanceId: string,
    msg: ServerMessage,
  ): boolean {
    const conn = this.getInstance(guardianId, clientInstanceId);
    if (!conn) return false;
    return this.sendTo(conn, msg);
  }

  /**
   * Low-level send helper — writes to the socket and bumps
   * `lastActiveAt` on success. Callers should use {@link send} or
   * {@link sendToInstance} unless they already hold a resolved
   * connection handle.
   */
  private sendTo(conn: ChromeExtensionConnection, msg: ServerMessage): boolean {
    try {
      conn.ws.send(JSON.stringify(msg));
      conn.lastActiveAt = Date.now();
      return true;
    } catch (err) {
      log.warn(
        {
          guardianId: conn.guardianId,
          connectionId: conn.id,
          clientInstanceId: conn.clientInstanceId,
          err,
        },
        "failed to send to chrome extension",
      );
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
