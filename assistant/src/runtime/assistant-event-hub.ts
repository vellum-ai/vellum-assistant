/**
 * In-process pub/sub hub for assistant events.
 *
 * Provides subscribe / publish primitives used by the daemon send paths
 * and the SSE route.
 *
 * Client connections (SSE) register as subscribers with metadata (clientId,
 * interfaceId, capabilities). The hub replaces the former ClientRegistry —
 * client-oriented queries (list, find-by-capability) are methods on the hub.
 */

import type { HostProxyCapability, InterfaceId } from "../channels/types.js";
import { supportsHostProxy } from "../channels/types.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import { appendEventToStream } from "../signals/event-stream.js";
import { getLogger } from "../util/logger.js";
import type { AssistantEvent } from "./assistant-event.js";
import { buildAssistantEvent } from "./assistant-event.js";

const log = getLogger("assistant-event-hub");

// ── Types ─────────────────────────────────────────────────────────────────────

/** All host-proxy capabilities checked against each interface on register. */
const ALL_CAPABILITIES: HostProxyCapability[] = [
  "host_bash",
  "host_file",
  "host_cu",
  "host_browser",
];

/** Filter that determines which events a subscriber receives. */
export type AssistantEventFilter = {
  /** When set, restrict delivery to events for this conversation. */
  conversationId?: string;
  /** When set, only receive events targeted at this interfaceId (plus untargeted). */
  interfaceId?: InterfaceId;
};

export type AssistantEventCallback = (
  event: AssistantEvent,
) => void | Promise<void>;

/** Opaque handle returned by `subscribe`. Call `dispose()` to remove the subscription. */
export interface AssistantEventSubscription {
  dispose(): void;
  /** True until `dispose()` has been called. */
  readonly active: boolean;
}

/** Optional metadata for client subscribers. */
export interface ClientSubscriberMeta {
  clientId: string;
  interfaceId: InterfaceId;
}

/** Serialized form returned by the IPC route / CLI command. */
export interface ClientEntryJSON {
  clientId: string;
  interfaceId: InterfaceId;
  capabilities: HostProxyCapability[];
  connectedAt: string;
  lastActiveAt: string;
}

// ── Hub ───────────────────────────────────────────────────────────────────────

interface SubscriberEntry {
  filter: AssistantEventFilter;
  callback: AssistantEventCallback;
  active: boolean;
  /** Called by the hub when this entry is evicted to make room for a new subscriber. */
  onEvict?: () => void;
  /** Present when this subscriber represents a connected client. */
  client?: {
    clientId: string;
    interfaceId: InterfaceId;
    capabilities: HostProxyCapability[];
    connectedAt: number;
    lastActiveAt: number;
  };
}

/**
 * Lightweight pub/sub hub for `AssistantEvent` messages.
 *
 * Filtering is applied at subscription level:
 *   - `conversationId`: scoped events match subscribers with same conversationId
 *     or no conversationId filter (broadcast to all).
 *   - `interfaceId` (targeting): events with `targetInterfaceId` only go to
 *     subscribers whose filter.interfaceId matches. Events without a target
 *     go to all matching subscribers.
 *
 * Client connections register as subscribers with metadata and are queryable
 * via `listClients()`, `getClientByCapability()`, etc.
 */
export class AssistantEventHub {
  private readonly subscribers = new Set<SubscriberEntry>();
  private readonly maxSubscribers: number;

  constructor(options?: { maxSubscribers?: number }) {
    this.maxSubscribers = options?.maxSubscribers ?? Infinity;
  }

  /**
   * Register a subscriber that will be called for each matching event.
   *
   * When the subscriber cap (`maxSubscribers`) has been reached, the **oldest**
   * subscriber is evicted to make room: its `onEvict` callback is invoked (so
   * it can close its SSE stream) and its entry is removed from the hub.
   *
   * @param options.onEvict  Called if this subscriber is later evicted by a newer one.
   * @param options.client   When provided, marks this subscriber as a connected client.
   * @returns A subscription handle. Call `dispose()` to unsubscribe.
   */
  subscribe(
    filter: AssistantEventFilter,
    callback: AssistantEventCallback,
    options?: {
      onEvict?: () => void;
      client?: ClientSubscriberMeta;
    },
  ): AssistantEventSubscription {
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
        oldest.onEvict?.();
      } catch {
        /* ignore eviction callback errors */
      }
    }

    const now = Date.now();
    let clientMeta: SubscriberEntry["client"] | undefined;
    if (options?.client) {
      const { clientId, interfaceId } = options.client;
      clientMeta = {
        clientId,
        interfaceId,
        capabilities: ALL_CAPABILITIES.filter((cap) =>
          supportsHostProxy(interfaceId, cap),
        ),
        connectedAt: now,
        lastActiveAt: now,
      };
      log.info(
        {
          clientId,
          interfaceId,
          capabilities: clientMeta.capabilities,
        },
        "client registered",
      );
    }

    const entry: SubscriberEntry = {
      filter,
      callback,
      active: true,
      onEvict: options?.onEvict,
      client: clientMeta,
    };
    this.subscribers.add(entry);

    return {
      dispose: () => {
        if (entry.active) {
          entry.active = false;
          this.subscribers.delete(entry);
          if (entry.client) {
            log.info(
              {
                clientId: entry.client.clientId,
                interfaceId: entry.client.interfaceId,
              },
              "client unregistered",
            );
          }
        }
      },
      get active() {
        return entry.active;
      },
    };
  }

  /**
   * Publish an event to all matching subscribers.
   *
   * Matching rules:
   * - if `filter.conversationId` is set, `event.conversationId` must equal it
   * - if `event.targetInterfaceId` is set, only subscribers whose
   *   `filter.interfaceId` matches receive it; untargeted events go to all
   *
   * Fanout is isolated: a throwing or rejecting subscriber does not abort
   * delivery to remaining subscribers.
   */
  async publish(
    event: AssistantEvent,
    options?: { targetInterfaceId?: InterfaceId },
  ): Promise<void> {
    if (event.conversationId) {
      try {
        appendEventToStream(event.conversationId, event);
      } catch {
        // Best-effort; file I/O failures must not block subscriber fanout.
      }
    }

    const targetInterfaceId = options?.targetInterfaceId;
    const snapshot = Array.from(this.subscribers);
    const errors: unknown[] = [];

    for (const entry of snapshot) {
      if (!entry.active) continue;

      // Conversation scoping: scoped events skip subscribers filtering on a
      // different conversation.
      if (
        event.conversationId != null &&
        entry.filter.conversationId != null &&
        entry.filter.conversationId !== event.conversationId
      )
        continue;

      // Interface targeting: targeted events only go to matching subscribers.
      if (
        targetInterfaceId != null &&
        entry.filter.interfaceId != null &&
        entry.filter.interfaceId !== targetInterfaceId
      )
        continue;

      // If event is targeted but subscriber has no interfaceId filter, skip it.
      // Only subscribers that declared an interfaceId should receive targeted events.
      if (targetInterfaceId != null && entry.filter.interfaceId == null)
        continue;

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
   * Returns true when at least one active subscriber would receive the given
   * event based on the same conversation matching rules as publish().
   */
  hasSubscribersForEvent(
    event: Pick<AssistantEvent, "conversationId">,
  ): boolean {
    for (const entry of this.subscribers) {
      if (!entry.active) continue;
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

  /**
   * Return all active client subscribers, sorted by `lastActiveAt` descending.
   */
  listClients(): SubscriberEntry["client"][] {
    const clients: NonNullable<SubscriberEntry["client"]>[] = [];
    for (const entry of this.subscribers) {
      if (entry.active && entry.client) {
        clients.push(entry.client);
      }
    }
    return clients.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  /**
   * Return all client subscribers that support the given capability,
   * sorted by `lastActiveAt` descending.
   */
  listClientsByCapability(
    capability: HostProxyCapability,
  ): NonNullable<SubscriberEntry["client"]>[] {
    return this.listClients().filter((c) =>
      c.capabilities.includes(capability),
    );
  }

  /**
   * Return the most recently active client that supports the given
   * capability, or `undefined` if none exists.
   */
  getMostRecentClientByCapability(
    capability: HostProxyCapability,
  ): NonNullable<SubscriberEntry["client"]> | undefined {
    return this.listClientsByCapability(capability)[0];
  }

  /**
   * Return all client subscribers with the given interface type,
   * sorted by `lastActiveAt` descending.
   */
  listClientsByInterface(
    interfaceId: InterfaceId,
  ): NonNullable<SubscriberEntry["client"]>[] {
    return this.listClients().filter((c) => c.interfaceId === interfaceId);
  }

  /**
   * Touch a client subscriber — update `lastActiveAt`. Used by heartbeat.
   */
  touchClient(clientId: string): void {
    for (const entry of this.subscribers) {
      if (entry.active && entry.client?.clientId === clientId) {
        entry.client.lastActiveAt = Date.now();
        return;
      }
    }
  }

  /**
   * Serialize a client entry to JSON (ISO timestamps).
   */
  static clientToJSON(
    client: NonNullable<SubscriberEntry["client"]>,
  ): ClientEntryJSON {
    return {
      clientId: client.clientId,
      interfaceId: client.interfaceId,
      capabilities: client.capabilities,
      connectedAt: new Date(client.connectedAt).toISOString(),
      lastActiveAt: new Date(client.lastActiveAt).toISOString(),
    };
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

// ── Convenience: ServerMessage → AssistantEvent publish ───────────────────────

/**
 * Promise chain that serializes publishes so subscribers always observe
 * events in send order.
 */
let _hubChain = Promise.resolve();

/**
 * Wraps a `ServerMessage` in an `AssistantEvent` envelope and publishes it
 * to the process-level hub.
 *
 * When `conversationId` is omitted, it is auto-extracted from the message
 * payload (if present).
 *
 * This is the primary entrypoint for emitting events — handlers, routes, and
 * services should call this directly instead of threading a broadcast callback.
 */
export function broadcastMessage(
  msg: ServerMessage,
  conversationId?: string,
): void {
  const resolvedConversationId = conversationId ?? extractConversationId(msg);
  const event = buildAssistantEvent(msg, resolvedConversationId);
  _hubChain = _hubChain
    .then(() => assistantEventHub.publish(event))
    .catch((err: unknown) => {
      log.warn({ err }, "assistant-events hub subscriber threw during publish");
    });
}

function extractConversationId(msg: ServerMessage): string | undefined {
  const record = msg as unknown as Record<string, unknown>;
  if ("conversationId" in msg && typeof record.conversationId === "string") {
    return record.conversationId as string;
  }
  return undefined;
}
