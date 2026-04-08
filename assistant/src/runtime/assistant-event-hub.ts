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

/**
 * Lightweight pub/sub hub for `AssistantEvent` messages.
 *
 * Filtering is applied at subscription level — subscribers receive only
 * events that match their `assistantId` (and optionally `conversationId`).
 *
 * The hub is intentionally simple: synchronous fanout, no buffering, no
 * backpressure. Slow-consumer protection lives in the SSE route (PR 7).
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
}

// ── Process-level singleton ───────────────────────────────────────────────────

/**
 * Singleton hub shared across the entire runtime process.
 *
 * Import and use this in daemon send paths (PR 3) and the SSE route (PR 5).
 */
export const assistantEventHub = new AssistantEventHub({ maxSubscribers: 100 });
