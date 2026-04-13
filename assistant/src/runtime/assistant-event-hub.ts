/**
 * In-process pub/sub hub for assistant events.
 *
 * Provides subscribe / publish primitives used by the daemon send paths
 * and the SSE route. No runtime route or daemon integration is wired here.
 */

import type { AssistantEvent } from "./assistant-event.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Predicate that determines whether a subscriber wants a given event. */
export type AssistantEventFilter = {
  /** Only deliver events for this assistant. */
  assistantId: string;
  /** When set, further restrict to this conversation. */
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

// ── Ring-buffer constants ─────────────────────────────────────────────────────

/** Max events retained per conversation for SSE replay. */
const EVENT_BUFFER_CAPACITY = 128;

/** Max number of distinct conversations tracked in the replay buffer.
 *  Oldest conversation buffer is evicted when this cap is reached. */
const MAX_BUFFERED_CONVERSATIONS = 256;

/**
 * Lightweight pub/sub hub for `AssistantEvent` messages.
 *
 * Filtering is applied at subscription level — subscribers receive only
 * events that match their `assistantId` (and optionally `conversationId`).
 *
 * Each conversation's events are retained in a capped ring buffer so that
 * SSE reconnects with `Last-Event-ID` can replay missed events without a
 * full history fetch.
 *
 * Slow-consumer protection lives in the SSE route.
 */
export class AssistantEventHub {
  private readonly subscribers = new Set<SubscriberEntry>();
  private readonly maxSubscribers: number;

  /** Per-conversation ring buffer keyed by conversationId. */
  private readonly conversationBuffers = new Map<string, AssistantEvent[]>();
  private readonly eventBufferCapacity: number;
  private readonly maxBufferedConversations: number;

  constructor(options?: {
    maxSubscribers?: number;
    eventBufferCapacity?: number;
    maxBufferedConversations?: number;
  }) {
    this.maxSubscribers = options?.maxSubscribers ?? Infinity;
    this.eventBufferCapacity =
      options?.eventBufferCapacity ?? EVENT_BUFFER_CAPACITY;
    this.maxBufferedConversations =
      options?.maxBufferedConversations ?? MAX_BUFFERED_CONVERSATIONS;
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
   * - `event.assistantId` must equal `filter.assistantId`
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
    const snapshot = Array.from(this.subscribers);
    const errors: unknown[] = [];

    for (const entry of snapshot) {
      if (!entry.active) continue;
      if (entry.filter.assistantId !== event.assistantId) continue;
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

    // Buffer the event for replay after subscriber fanout.
    this.bufferEvent(event);

    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        "One or more assistant-event subscribers threw",
      );
    }
  }

  /**
   * Returns true when at least one active subscriber would receive the given
   * event based on the same assistant/conversation matching rules as publish().
   */
  hasSubscribersForEvent(
    event: Pick<AssistantEvent, "assistantId" | "conversationId">,
  ): boolean {
    for (const entry of this.subscribers) {
      if (!entry.active) continue;
      if (entry.filter.assistantId !== event.assistantId) continue;
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

  // ── Ring-buffer API ──────────────────────────────────────────────────────

  /**
   * Return all buffered events for `conversationId` whose `id` is
   * lexicographically **after** `lastEventId` in publish order.
   *
   * Returns an empty array when:
   * - `lastEventId` is null/undefined (client has no checkpoint)
   * - `lastEventId` is not found in the buffer (too old — caller should
   *   fall back to a full history fetch via GET /conversations/:id/history)
   * - No events exist for this conversation
   */
  getEventsSince(
    conversationId: string,
    lastEventId: string | null,
  ): AssistantEvent[] {
    if (!lastEventId) return [];
    const buffer = this.conversationBuffers.get(conversationId);
    if (!buffer || buffer.length === 0) return [];

    const idx = buffer.findIndex((e) => e.id === lastEventId);
    if (idx === -1) return []; // id not in buffer — gap too large
    return buffer.slice(idx + 1);
  }

  /**
   * Remove the replay buffer for a deleted conversation to free memory.
   */
  onConversationDeleted(conversationId: string): void {
    this.conversationBuffers.delete(conversationId);
  }

  /** Number of conversations currently tracked in the replay buffer. */
  bufferedConversationCount(): number {
    return this.conversationBuffers.size;
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  /** Append an event to its conversation's ring buffer, enforcing caps. */
  private bufferEvent(event: AssistantEvent): void {
    const convId = event.conversationId;
    if (!convId) return; // system events with no conversationId are not buffered

    let buffer = this.conversationBuffers.get(convId);
    if (!buffer) {
      // Evict oldest conversation buffer if at capacity (Maps iterate in insertion order).
      if (this.conversationBuffers.size >= this.maxBufferedConversations) {
        const oldestKey = this.conversationBuffers.keys().next().value;
        if (oldestKey !== undefined) {
          this.conversationBuffers.delete(oldestKey);
        }
      }
      buffer = [];
      this.conversationBuffers.set(convId, buffer);
    }

    buffer.push(event);

    // Trim oldest entries when over capacity.
    if (buffer.length > this.eventBufferCapacity) {
      buffer.splice(0, buffer.length - this.eventBufferCapacity);
    }
  }
}

// ── Process-level singleton ───────────────────────────────────────────────────

/**
 * Singleton hub shared across the entire runtime process.
 *
 * Import and use this in daemon send paths and the SSE route.
 */
export const assistantEventHub = new AssistantEventHub({ maxSubscribers: 100 });
