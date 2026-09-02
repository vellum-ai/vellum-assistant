/**
 * In-process pub/sub hub for assistant events.
 *
 * Provides subscribe / publish primitives used by the daemon send paths
 * and the SSE route.
 *
 * Subscribers are typed via a discriminated union:
 *   - **ClientEntry** — an SSE-connected client (macos, chrome-extension, …)
 *     with identity, capabilities, and timestamps.
 *   - **ProcessEntry** — an in-process consumer (future: file-append logger).
 *
 * Client-oriented queries (list, find-by-capability) are methods on the hub.
 */

import type { AssistantEvent } from "../api/index.js";
import type { HostProxyCapability, InterfaceId } from "../channels/types.js";

// ---------------------------------------------------------------------------
// Message type → capability inference
// ---------------------------------------------------------------------------

const HOST_PREFIX_TO_CAPABILITY: Record<string, HostProxyCapability> = {
  host_bash: "host_bash",
  host_file: "host_file",
  host_transfer: "host_file", // transfers piggyback on host_file capability
  host_cu: "host_cu",
  host_browser: "host_browser",
  host_app_control: "host_app_control",
  host_ui_snapshot: "host_ui_snapshot",
};

/**
 * Infer the {@link HostProxyCapability} a message should be targeted at based
 * on its `type` field.  Returns `undefined` for message types that are not
 * host-proxy messages (i.e. they should broadcast to all subscribers).
 */
export function capabilityForMessageType(
  type: string,
): HostProxyCapability | undefined {
  const stem = type.replace(/_(request|cancel)$/, "");
  return HOST_PREFIX_TO_CAPABILITY[stem];
}
import type { AssistantEventEnvelope } from "../api/index.js";
import { forwardEventPublishToDaemon } from "../ipc/events-publish-client.js";
import { appendEventToStream } from "../signals/event-stream.js";
import { getLogger } from "../util/logger.js";
import { buildAssistantEvent } from "./assistant-event.js";
import type { AssistantEventPublishOptions } from "./assistant-event-publish-options.js";
import { stampAndBuffer } from "./assistant-stream-state.js";
import { isMainDaemonProcess } from "./process-role.js";

const log = getLogger("assistant-event-hub");

// ── Types ─────────────────────────────────────────────────────────────────────

/** Filter that determines which events a subscriber receives. */
export type AssistantEventFilter = {
  /** When set, restrict delivery to events for this conversation. */
  conversationId?: string;
};

export type AssistantEventCallback = (
  event: AssistantEventEnvelope,
) => void | Promise<void>;

/** Opaque handle returned by `subscribe`. Call `dispose()` to remove the subscription. */
export interface AssistantEventSubscription {
  dispose(): void;
  /** True until `dispose()` has been called. */
  readonly active: boolean;
  /**
   * Per-connection identifier, unique within the hub instance. Distinguishes
   * connections that share a `clientId` (e.g. an old connection and the new
   * one that replaced it on reconnect) so subscribe / dispose / shed log
   * lines can be attributed to a specific connection.
   */
  readonly connectionId: string;
}

// ── Subscriber entries (discriminated union) ─────────────────────────────────

interface BaseSubscriberEntry {
  filter: AssistantEventFilter;
  callback: AssistantEventCallback;
  active: boolean;
  onEvict: () => void;
  connectedAt: Date;
  lastActiveAt: Date;
  /**
   * Per-connection identifier, unique within the hub instance. Two entries
   * with the same `clientId` (old vs reconnected connection) get distinct
   * connection ids, making them traceable across subscribe / dispose / shed
   * logs.
   */
  connectionId: string;
}

/**
 * The presence states a desktop client may report. Single runtime source: the
 * stored type and the route's wire enum both derive from this tuple.
 */
export const DESKTOP_PRESENCE_STATES = ["active", "idle", "away"] as const;

export type DesktopPresenceState = (typeof DESKTOP_PRESENCE_STATES)[number];

export interface ClientPresence {
  state: DesktopPresenceState;
  /** When the daemon last heard from the client. Drives staleness. */
  reportedAt: Date;
}

/**
 * Web tab visibility and conversation focus, as reported by a `web`-interface
 * client (a browser tab or the Electron renderer). Distinct from
 * {@link ClientPresence}: scoped to a single conversation rather than app-wide
 * attendance, and reported by the shared web renderer rather than the macOS
 * host-proxy bridge. See `runtime/web-presence.ts` for the read-side policy.
 */
export interface WebPresenceReport {
  visible: boolean;
  /** The conversation currently focused (chat composer on screen), or `null`. */
  focusedConversationId: string | null;
}

export interface ClientWebPresence extends WebPresenceReport {
  /** When the daemon last heard from the client. Drives staleness. */
  reportedAt: Date;
}

interface ClientEntry extends BaseSubscriberEntry {
  type: "client";
  clientId: string;
  interfaceId: InterfaceId;
  capabilities: HostProxyCapability[];
  machineName?: string;
  /**
   * The verified actor principal id (canonical user identity, parsed from JWT
   * `sub`) of the user that opened this SSE connection, when available.
   *
   * Populated from `AuthContext.actorPrincipalId` at SSE subscription time.
   * Used by host proxies to gate cross-client targeted execution to the same
   * authenticated user identity. May be `undefined` for legacy or
   * service-token connections that have no principal.
   */
  actorPrincipalId?: string;
  /**
   * Last desktop presence reported by this client, for clients that report it.
   * In-memory only, so consumers must fail open when it is absent.
   */
  presence?: ClientPresence;
  /**
   * Last web tab visibility/focus reported by this client, for clients that
   * report it. In-memory only, so consumers must fail open when it is absent.
   */
  webPresence?: ClientWebPresence;
}

interface ProcessEntry extends BaseSubscriberEntry {
  type: "process";
}

type SubscriberEntry = ClientEntry | ProcessEntry;

/** Distributive Omit that preserves union discrimination. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** Input shape for `subscribe()` — hub fills `active`, `connectedAt`, `lastActiveAt`, `connectionId` and defaults `filter`/`onEvict`. */
type SubscriberInput = DistributiveOmit<
  SubscriberEntry,
  | "active"
  | "connectedAt"
  | "lastActiveAt"
  | "filter"
  | "onEvict"
  | "connectionId"
> & {
  filter?: AssistantEventFilter;
  onEvict?: () => void;
};

// ── Hub ───────────────────────────────────────────────────────────────────────

/**
 * Lightweight pub/sub hub for `AssistantEventEnvelope` messages.
 *
 * Filtering is applied at subscription level:
 *   - `conversationId`: scoped events match subscribers with same conversationId
 *     or no conversationId filter (broadcast to all).
 *   - `targetCapability` (on publish): targeted events only reach subscribers
 *     whose capabilities include the target. Untargeted events fan out to all.
 *
 * Client connections register as subscribers with metadata and are queryable
 * via `listClients()`, `getMostRecentClientByCapability()`, etc.
 */
export class AssistantEventHub {
  private readonly subscribers = new Set<SubscriberEntry>();
  private readonly maxSubscribers: number;
  /** Monotonic source for per-connection ids, scoped to this hub. */
  private connectionCounter = 0;

  constructor(options?: { maxSubscribers?: number }) {
    this.maxSubscribers = options?.maxSubscribers ?? Infinity;
  }

  /**
   * Register a subscriber that will be called for each matching event.
   *
   * **Client deduplication:** When a client subscriber is registered with a
   * `clientId` that already exists, all stale entries for that clientId are
   * disposed first. This prevents subscriber stacking when clients reconnect
   * (e.g. Chrome extension reload, SSE token refresh) before the old
   * connection's abort signal fires.
   *
   * When the subscriber cap (`maxSubscribers`) has been reached, the **oldest**
   * subscriber is evicted to make room: its `onEvict` callback is invoked (so
   * it can close its SSE stream) and its entry is removed from the hub.
   */
  subscribe(subscriber: SubscriberInput): AssistantEventSubscription {
    // Deduplicate: dispose stale subscribers for the same clientId.
    if (subscriber.type === "client") {
      const stale: SubscriberEntry[] = [];
      for (const existing of this.subscribers) {
        if (
          existing.type === "client" &&
          existing.clientId === subscriber.clientId
        ) {
          stale.push(existing);
        }
      }
      for (const entry of stale) {
        entry.active = false;
        this.subscribers.delete(entry);
        try {
          entry.onEvict();
        } catch {
          /* ignore eviction callback errors */
        }
      }
      if (stale.length > 0) {
        log.info(
          {
            clientId: subscriber.clientId,
            count: stale.length,
            disposedConnectionIds: stale.map((entry) => entry.connectionId),
          },
          "disposed stale subscribers for reconnecting client",
        );
      }
    }

    if (this.subscribers.size >= this.maxSubscribers) {
      const [oldest] = this.subscribers;
      if (!oldest) {
        throw new RangeError(
          `AssistantEventHub: subscriber cap reached (${this.maxSubscribers})`,
        );
      }
      oldest.active = false;
      this.subscribers.delete(oldest);
      try {
        oldest.onEvict();
      } catch {
        /* ignore eviction callback errors */
      }
    }

    const now = new Date();
    const connectionId = `conn-${++this.connectionCounter}`;
    const entry: SubscriberEntry = {
      ...subscriber,
      filter: subscriber.filter ?? {},
      onEvict: subscriber.onEvict ?? (() => {}),
      active: true,
      connectedAt: now,
      lastActiveAt: now,
      connectionId,
    } as SubscriberEntry;

    if (entry.type === "client") {
      log.info(
        {
          clientId: entry.clientId,
          interfaceId: entry.interfaceId,
          capabilities: entry.capabilities,
          connectionId,
        },
        "subscriber registered (client)",
      );
    } else {
      log.info({ connectionId }, "subscriber registered (process)");
    }

    this.subscribers.add(entry);

    return {
      dispose: () => {
        if (entry.active) {
          entry.active = false;
          this.subscribers.delete(entry);
          if (entry.type === "client") {
            log.info(
              {
                clientId: entry.clientId,
                interfaceId: entry.interfaceId,
                connectionId,
              },
              "subscriber unregistered (client)",
            );
          } else {
            log.info({ connectionId }, "subscriber unregistered (process)");
          }
        }
      },
      get active() {
        return entry.active;
      },
      connectionId,
    };
  }

  /**
   * Publish an event to all matching subscribers.
   *
   * Matching rules:
   * - if `excludeClientId` is set, the subscriber with that clientId is
   *   skipped regardless of every other rule (self-echo suppression — the
   *   client that originated the mutation does not receive its own
   *   invalidation back through the hub).
   * - if `targetClientId` is set, deliver only to the subscriber with that
   *   clientId, bypassing the conversation-id filter entirely (the web-origin
   *   event's conversationId differs from the macOS client's subscribed
   *   conversation).
   * - if `filter.conversationId` is set (and `targetClientId` is not), the
   *   `event.conversationId` must equal it
   * - if `targetCapability` is set, only subscribers whose capabilities include
   *   it receive the event; untargeted events go to all
   * - if `targetInterfaceId` is set, only client subscribers whose
   *   `interfaceId` matches receive the event; process subscribers and
   *   non-matching clients are skipped.
   *
   * Fanout is isolated: a throwing or rejecting subscriber does not abort
   * delivery to remaining subscribers.
   */
  async publish(
    event: AssistantEventEnvelope,
    options?: AssistantEventPublishOptions,
  ): Promise<void> {
    // Only the main daemon owns the subscribers real clients connect to. In any
    // other process (a sidecar worker, the route host) this hub has no SSE
    // subscriber, so hand the event to the daemon — it republishes on the hub
    // clients actually observe. Best-effort: a transport failure is logged, not
    // thrown, and never blocks the caller.
    if (!isMainDaemonProcess()) {
      return forwardEventPublishToDaemon(event, options);
    }
    if (event.conversationId) {
      try {
        appendEventToStream(event.conversationId, event);
      } catch {
        // Best-effort; file I/O failures must not block subscriber fanout.
      }
    }

    const targetCapability = options?.targetCapability;
    const targetClientId = options?.targetClientId;
    const targetInterfaceId = options?.targetInterfaceId;
    const excludeClientId = options?.excludeClientId;
    const snapshot = Array.from(this.subscribers);
    const errors: unknown[] = [];

    for (const entry of snapshot) {
      if (!entry.active) {
        continue;
      }

      // Self-echo suppression: the originating client never receives the
      // event back. Checked before every other rule so it composes with
      // both targeted and untargeted broadcasts.
      if (
        excludeClientId != null &&
        entry.type === "client" &&
        entry.clientId === excludeClientId
      ) {
        continue;
      }

      // Interface targeting: skip any subscriber that is not a client of
      // the requested interface. Composes with `targetClientId` and
      // `targetCapability` below.
      if (targetInterfaceId != null) {
        if (
          entry.type !== "client" ||
          entry.interfaceId !== targetInterfaceId
        ) {
          continue;
        }
      }

      if (targetClientId != null) {
        // Targeted: bypass conversation filter, deliver only to the named client.
        if (entry.type !== "client" || entry.clientId !== targetClientId) {
          continue;
        }
        if (
          targetCapability != null &&
          !entry.capabilities.includes(targetCapability)
        ) {
          continue;
        }
      } else {
        // Untargeted: existing conversation-scoped + capability logic.
        if (
          event.conversationId != null &&
          entry.filter.conversationId != null &&
          entry.filter.conversationId !== event.conversationId
        ) {
          continue;
        }

        // Capability targeting: targeted events only go to subscribers that
        // declare the required capability.
        if (targetCapability != null) {
          if (
            entry.type !== "client" ||
            !entry.capabilities.includes(targetCapability)
          ) {
            continue;
          }
        }
      }

      try {
        await entry.callback(event);
      } catch (err) {
        errors.push(err);
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        "One or more assistant-event subscribers threw",
      );
    }
  }

  /**
   * Yield every active client entry with the given clientId. `subscribe`
   * disposes any prior entries for the same clientId, so at most one entry
   * matches.
   */
  private *activeClientEntries(clientId: string): Generator<ClientEntry> {
    for (const entry of this.subscribers) {
      if (
        entry.active &&
        entry.type === "client" &&
        entry.clientId === clientId
      ) {
        yield entry;
      }
    }
  }

  /**
   * Return the active client subscriber with the given clientId, or
   * `undefined` if no such subscriber exists.
   */
  getClientById(clientId: string): ClientEntry | undefined {
    for (const entry of this.activeClientEntries(clientId)) {
      return entry;
    }
    return undefined;
  }

  /**
   * Return the verified actor principal id captured at SSE subscription time
   * for the given client, or `undefined` if the client is unknown or
   * connected without a principal (e.g. legacy/service tokens).
   *
   * Used by host proxies to bind cross-client targeted execution to the same
   * authenticated user identity that opened the target client's SSE stream.
   */
  getActorPrincipalIdForClient(clientId: string): string | undefined {
    return this.getClientById(clientId)?.actorPrincipalId;
  }

  /**
   * Whether the connection identified by `connectionId` is still an active
   * client subscription that carries no `actorPrincipalId`.
   *
   * Drives the retrying SSE self-heal (`sse-actor-principal-heal.ts`): the loop
   * re-checks before each attempt so it stops as soon as the connection closes,
   * is replaced by a reconnect, or gets a principal from any path. Returns
   * `false` for an unknown, inactive, or process-type connection.
   */
  needsActorPrincipalHeal(connectionId: string): boolean {
    for (const entry of this.subscribers) {
      if (entry.connectionId !== connectionId) {
        continue;
      }
      return (
        entry.active &&
        entry.type === "client" &&
        entry.actorPrincipalId == null
      );
    }
    return false;
  }

  /**
   * Fill a missing `actorPrincipalId` on a live client subscription.
   *
   * Used by the SSE dev-bypass self-heal: when the guardian-delivery cache is
   * cold at subscribe time, the registration lands without a principal; the
   * route resolves it async and patches the record here. Keyed by
   * `connectionId` (not clientId) so a reconnect race cannot patch the
   * subscription that replaced the one being healed. No-op when the
   * connection is gone or already carries a principal: this only fills a
   * missing value, never overwrites one. The value must come from the
   * daemon's own server-side guardian lookup, never from client input.
   */
  fillClientActorPrincipalId(
    connectionId: string,
    actorPrincipalId: string,
  ): void {
    for (const entry of this.subscribers) {
      if (entry.connectionId !== connectionId) {
        continue;
      }
      if (
        !entry.active ||
        entry.type !== "client" ||
        entry.actorPrincipalId != null
      ) {
        return;
      }
      entry.actorPrincipalId = actorPrincipalId;
      log.info(
        { clientId: entry.clientId, connectionId },
        "filled missing actorPrincipalId for client subscription",
      );
      return;
    }
  }

  /**
   * Returns true when at least one active subscriber would receive the given
   * event based on the same conversation matching rules as publish().
   */
  hasSubscribersForEvent(
    event: Pick<AssistantEventEnvelope, "conversationId">,
  ): boolean {
    for (const entry of this.subscribers) {
      if (!entry.active) {
        continue;
      }
      if (
        event.conversationId != null &&
        entry.filter.conversationId != null &&
        entry.filter.conversationId !== event.conversationId
      ) {
        continue;
      }
      return true;
    }
    return false;
  }

  // ── Client queries ──────────────────────────────────────────────────────────

  private clientEntries(): ClientEntry[] {
    const clients: ClientEntry[] = [];
    for (const entry of this.subscribers) {
      if (entry.active && entry.type === "client") {
        clients.push(entry);
      }
    }
    return clients.sort(
      (a, b) => b.lastActiveAt.getTime() - a.lastActiveAt.getTime(),
    );
  }

  /**
   * Return all active client subscribers, sorted by `lastActiveAt` descending.
   */
  listClients(): ClientEntry[] {
    return this.clientEntries();
  }

  /**
   * Return all client subscribers that support the given capability,
   * sorted by `lastActiveAt` descending.
   */
  listClientsByCapability(capability: HostProxyCapability): ClientEntry[] {
    return this.clientEntries().filter((c) =>
      c.capabilities.includes(capability),
    );
  }

  /**
   * Return the most recently active client that supports the given
   * capability, or `undefined` if none exists.
   */
  getMostRecentClientByCapability(
    capability: HostProxyCapability,
  ): ClientEntry | undefined {
    return this.listClientsByCapability(capability)[0];
  }

  /**
   * Return all client subscribers with the given interface type,
   * sorted by `lastActiveAt` descending.
   */
  listClientsByInterface(interfaceId: InterfaceId): ClientEntry[] {
    return this.clientEntries().filter((c) => c.interfaceId === interfaceId);
  }

  /**
   * Touch a client subscriber — update `lastActiveAt`. Used by heartbeat.
   */
  touchClient(clientId: string): void {
    const now = new Date();
    for (const entry of this.activeClientEntries(clientId)) {
      entry.lastActiveAt = now;
    }
  }

  /**
   * Record the desktop presence state reported by a client. `reportedAt`
   * always advances. Returns true when at least one active client entry
   * matched.
   */
  setClientPresence(clientId: string, state: DesktopPresenceState): boolean {
    const now = new Date();
    let matched = false;
    for (const entry of this.activeClientEntries(clientId)) {
      entry.presence = { state, reportedAt: now };
      matched = true;
    }
    return matched;
  }

  /**
   * Record the web tab visibility/focused-conversation reported by a client.
   * `reportedAt` always advances. Returns true when at least one active
   * client entry matched.
   */
  setClientWebPresence(clientId: string, report: WebPresenceReport): boolean {
    const now = new Date();
    let matched = false;
    for (const entry of this.activeClientEntries(clientId)) {
      entry.webPresence = { ...report, reportedAt: now };
      matched = true;
    }
    return matched;
  }

  /**
   * Force-disconnect a client by disposing all subscribers for the given
   * `clientId`. Returns the number of disposed entries.
   *
   * Used by `assistant clients disconnect <clientId>` to forcibly remove
   * stale or unwanted client connections.
   */
  disposeClient(clientId: string): number {
    const targets: SubscriberEntry[] = [];
    for (const entry of this.subscribers) {
      if (entry.type === "client" && entry.clientId === clientId) {
        targets.push(entry);
      }
    }
    for (const entry of targets) {
      entry.active = false;
      this.subscribers.delete(entry);
      try {
        entry.onEvict();
      } catch {
        /* ignore eviction callback errors */
      }
    }
    if (targets.length > 0) {
      log.info(
        { clientId, count: targets.length },
        "force-disposed client subscribers",
      );
    }
    return targets.length;
  }

  /** Number of currently active subscribers (useful for tests and caps). */
  subscriberCount(): number {
    return this.subscribers.size;
  }

  /** Returns true if the hub can accept a subscriber without evicting anyone. */
  hasCapacity(): boolean {
    return this.subscribers.size < this.maxSubscribers;
  }
}

// ── Process-level singleton ───────────────────────────────────────────────────

/**
 * Singleton hub shared across the entire runtime process.
 *
 * Import and use this in daemon send paths and the SSE route.
 */
export const assistantEventHub = new AssistantEventHub({ maxSubscribers: 100 });

// ── Convenience: AssistantEvent → AssistantEventEnvelope publish ───────────────────────

/**
 * Promise chain that serializes publishes so subscribers always observe
 * events in send order.
 */
let _hubChain = Promise.resolve();

/**
 * Wraps a `AssistantEvent` in an `AssistantEventEnvelope` envelope and publishes it
 * to the process-level hub.
 *
 * When `conversationId` is omitted, it is auto-extracted from the message
 * payload (if present).
 *
 * Target capability is inferred automatically from the message type — callers
 * never need to specify it.  Host-proxy messages (`host_bash_*`,
 * `host_file_*`, `host_transfer_*`, `host_cu_*`, `host_browser_*`) are routed
 * only to subscribers that declare the matching capability; all other messages
 * broadcast to every subscriber.
 *
 * This is the primary entrypoint for emitting events — handlers, routes, and
 * services should call this directly instead of threading a broadcast callback.
 */
export function broadcastMessage(
  msg: AssistantEvent,
  conversationId?: string,
  options?: { targetClientId?: string; targetInterfaceId?: InterfaceId },
): void {
  const resolvedConversationId = conversationId ?? extractConversationId(msg);
  const targetClientId = options?.targetClientId;
  const targetInterfaceId = options?.targetInterfaceId;

  const event = buildAssistantEvent(msg, resolvedConversationId);
  const targetCapability = capabilityForMessageType(msg.type);
  // Self-echo suppression: a `sync_changed` carrying an `originClientId`
  // means a specific client just mutated the resource. The hub must not
  // re-deliver the invalidation to that client — it already updated its
  // optimistic state locally and a redundant invalidation would clobber it
  // with a flash of stale-then-fresh data. Assistant-internal emits (agent
  // loop, FS watcher, cron) leave `originClientId` unset and the event
  // fans out to every subscriber as before.
  const excludeClientId =
    msg.type === "sync_changed" &&
    typeof msg.originClientId === "string" &&
    msg.originClientId.length > 0
      ? msg.originClientId
      : undefined;
  const publishOptions =
    targetCapability != null ||
    targetClientId != null ||
    targetInterfaceId != null ||
    excludeClientId != null
      ? {
          targetCapability,
          targetClientId,
          targetInterfaceId,
          excludeClientId,
        }
      : undefined;
  stampAndBuffer(event, { targeting: publishOptions });
  _hubChain = _hubChain
    .then(() => assistantEventHub.publish(event, publishOptions))
    .catch((err: unknown) => {
      log.warn({ err }, "assistant-events hub subscriber threw during publish");
    });
}

function extractConversationId(msg: AssistantEvent): string | undefined {
  const record = msg as unknown as Record<string, unknown>;
  if ("conversationId" in msg && typeof record.conversationId === "string") {
    return record.conversationId as string;
  }
  return undefined;
}
