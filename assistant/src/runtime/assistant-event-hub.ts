/**
 * In-process pub/sub hub for assistant events.
 *
 * Provides subscribe / publish primitives used by both the IPC daemon send
 * paths (PR 3) and the SSE route (PR 5). No runtime route or daemon
 * integration is wired here.
 */

import type { AssistantEvent } from './assistant-event.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('assistant-event-hub');

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
 * backpressure. Slow-consumer protection is added in PR 7.
 */
export class AssistantEventHub {
  private readonly subscribers = new Set<SubscriberEntry>();

  /**
   * Register a subscriber that will be called for each matching event.
   *
   * @returns A subscription handle. Call `dispose()` to unsubscribe.
   */
  subscribe(filter: AssistantEventFilter, callback: AssistantEventCallback): AssistantEventSubscription {
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
    let matched = 0;

    for (const entry of snapshot) {
      if (!entry.active) continue;
      if (entry.filter.assistantId !== event.assistantId) continue;
      if (entry.filter.sessionId != null && entry.filter.sessionId !== event.sessionId) continue;
      matched++;
      try {
        await entry.callback(event);
      } catch (err) {
        errors.push(err);
      }
    }

    const msgType = (event.message as { type?: string }).type ?? 'unknown';
    log.info(
      {
        eventAssistantId: event.assistantId,
        eventSessionId: event.sessionId,
        msgType,
        totalSubscribers: snapshot.length,
        matched,
      },
      'Event published to hub',
    );

    if (errors.length > 0) {
      throw new AggregateError(errors, 'One or more assistant-event subscribers threw');
    }
  }

  /** Number of currently active subscribers (useful for tests and caps). */
  subscriberCount(): number {
    return this.subscribers.size;
  }
}

// ── Process-level singleton ───────────────────────────────────────────────────

/**
 * Singleton hub shared across the entire runtime process.
 *
 * Import and use this in daemon send paths (PR 3) and the SSE route (PR 5).
 */
export const assistantEventHub = new AssistantEventHub();
