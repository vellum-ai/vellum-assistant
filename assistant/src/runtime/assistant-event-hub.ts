/**
 * In-process pub/sub hub for assistant events.
 *
 * Provides subscribe / publish primitives used by both the IPC daemon send
 * paths (PR 3) and the SSE route (PR 5). No runtime route or daemon
 * integration is wired here.
 */

import type { AssistantEvent } from './assistant-event.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Predicate that determines whether a subscriber wants a given event. */
export type AssistantEventFilter = {
  /** Only deliver events for this assistant. */
  assistantId: string;
  /** When set, further restrict to this session. */
  sessionId?: string;
};

export type AssistantEventCallback = (event: AssistantEvent) => void | Promise<void>;

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
}

/**
 * Lightweight pub/sub hub for `AssistantEvent` messages.
 *
 * Filtering is applied at subscription level — subscribers receive only
 * events that match their `assistantId` (and optionally `sessionId`).
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
   * Throws a `RangeError` when the subscriber cap (`maxSubscribers`) has
   * been reached. Callers should handle this and surface an appropriate
   * error to the client (e.g., HTTP 503).
   *
   * @returns A subscription handle. Call `dispose()` to unsubscribe.
   */
  subscribe(filter: AssistantEventFilter, callback: AssistantEventCallback): AssistantEventSubscription {
    if (this.subscribers.size >= this.maxSubscribers) {
      throw new RangeError(
        `AssistantEventHub: subscriber cap reached (${this.maxSubscribers})`,
      );
    }
    const entry: SubscriberEntry = { filter, callback, active: true };
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
   * - if `filter.sessionId` is set, `event.sessionId` must equal it
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
      if (entry.filter.sessionId != null && entry.filter.sessionId !== event.sessionId) continue;
      try {
        await entry.callback(event);
      } catch (err) {
        errors.push(err);
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, 'One or more assistant-event subscribers threw');
    }
  }

  /** Number of currently active subscribers (useful for tests and caps). */
  subscriberCount(): number {
    return this.subscribers.size;
  }

  /** Returns true if the hub can accept at least one more subscriber. */
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
export const assistantEventHub = new AssistantEventHub();
