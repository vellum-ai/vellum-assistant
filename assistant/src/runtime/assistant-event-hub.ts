/**
 * In-process pub/sub hub for assistant events.
 *
 * Provides subscribe / publish primitives used by the daemon send paths
 * and the SSE route. No runtime route or daemon integration is wired here.
 */

import type { ServerMessage } from "../daemon/message-protocol.js";
import { appendEventToStream } from "../signals/event-stream.js";
import { getLogger } from "../util/logger.js";
import type { AssistantEvent } from "./assistant-event.js";
import { buildAssistantEvent } from "./assistant-event.js";

const log = getLogger("assistant-event-hub");

// ── Types ─────────────────────────────────────────────────────────────────────

/** Predicate that determines whether a subscriber wants a given event. */
export type AssistantEventFilter = {
  /** When set, restrict delivery to this conversation. */
  conversationId?: string;
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

// ── Hub ───────────────────────────────────────────────────────────────────────

interface SubscriberEntry {
  filter: AssistantEventFilter;
  callback: AssistantEventCallback;
  active: boolean;
  /** Called by the hub when this entry is evicted to make room for a new subscriber. */
  onEvict?: () => void;
}

/**
 * Lightweight pub/sub hub for `AssistantEvent` messages.
 *
 * Filtering is applied at subscription level — subscribers receive only
 * events that match their `conversationId` (when specified).
 *
 * The hub is intentionally simple: synchronous fanout, no buffering, no
 * backpressure. Slow-consumer protection lives in the SSE route.
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
   * The only case that throws is when `maxSubscribers` is 0 — there is nothing
   * to evict and no room to add.
   *
   * @param options.onEvict  Called if this subscriber is later evicted by a newer one.
   * @returns A subscription handle. Call `dispose()` to unsubscribe.
   */
  subscribe(
    filter: AssistantEventFilter,
    callback: AssistantEventCallback,
    options?: { onEvict?: () => void },
  ): AssistantEventSubscription {
    if (this.subscribers.size >= this.maxSubscribers) {
      // Evict the oldest subscriber (Sets maintain insertion order).
      const [oldest] = this.subscribers;
      if (!oldest) {
        // maxSubscribers is 0 — nothing to evict, nothing to add.
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
    const entry: SubscriberEntry = {
      filter,
      callback,
      active: true,
      onEvict: options?.onEvict,
    };
    this.subscribers.add(entry);

    return {
      dispose: () => {
        if (entry.active) {
          entry.active = false;
          this.subscribers.delete(entry);
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
   *
   * Fanout is isolated: a throwing or rejecting subscriber does not abort
   * delivery to remaining subscribers. All callbacks (sync and async) are
   * awaited and their errors collected; any errors are re-thrown together
   * as an `AggregateError` after all callbacks have been invoked.
   *
   * Subscribers are snapshotted at the start of each publish call so that
   * callbacks adding new subscriptions do not receive the in-flight event.
   */
  async publish(event: AssistantEvent): Promise<void> {
    if (event.conversationId) {
      try {
        appendEventToStream(event.conversationId, event);
      } catch {
        // Best-effort; file I/O failures must not block subscriber fanout.
      }
    }

    const snapshot = Array.from(this.subscribers);
    const errors: unknown[] = [];

    for (const entry of snapshot) {
      if (!entry.active) continue;
      // System events (no conversationId) match all subscribers; scoped events
      // must match the subscriber's conversationId filter when present.
      if (
        event.conversationId != null &&
        entry.filter.conversationId != null &&
        entry.filter.conversationId !== event.conversationId
      )
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
