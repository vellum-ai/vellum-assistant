/**
 * Client-side event bus for assistant-global signals.
 *
 * Provides a typed publish/subscribe surface that decouples SSE delivery,
 * page visibility, and online/offline transitions from the components that
 * react to them. Owned by `useEventBusInit` at the chat-layout level so a
 * single bus instance services every chat-layout child route.
 *
 * Scope (PR1, LUM-1812): introduce the bus, broadcast assistant-scoped
 * SSE events under `"sse.event"`, and emit synthetic `"app.resume"` /
 * `"app.hidden"` / `"app.online"` / `"app.offline"` events from
 * `document.visibilitychange`, Capacitor `appStateChange`, and the
 * `navigator.online`/`offline` window events.
 *
 * Future PRs migrate the conversation-scoped SSE handle owned by
 * `useEventStream`, the per-component visibility listeners, and the
 * polling loop in `useAttentionTracking` onto this same bus.
 */
import type { AssistantEvent } from "@/domains/chat/api/event-types.js";

/**
 * Source of a synthetic `"app.resume"` / `"app.hidden"` event.
 *
 * `"visibility"`: `document.visibilitychange` fired on a non-Capacitor
 * web client.
 * `"app_state"`: Capacitor `App.appStateChange` fired in the native
 * iOS shell. Dedup with `"visibility"` is the consumer's responsibility.
 * `"online"`: `window.online` fired after the browser saw the network
 * come back; surfaced as a resume so consumers can treat it as
 * "something probably changed while we were away."
 */
export type AppResumeSignal = "visibility" | "app_state" | "online";

/** Source of a synthetic `"app.hidden"` event. */
export type AppHiddenSignal = "visibility" | "app_state";

/**
 * Map of bus event name → payload type. New event names are added here
 * so subscribers get exact handler types via the `keyof` lookup.
 */
export interface BusEventMap {
  /**
   * One-to-one re-broadcast of an SSE event received on the
   * bus-owned assistant-scoped `/v1/events` connection.
   * Subscribers narrow on `payload.type`.
   */
  "sse.event": AssistantEvent;
  /** Page became visible / app foregrounded / network came back online. */
  "app.resume": { signal: AppResumeSignal };
  /** Page hidden / app backgrounded. */
  "app.hidden": { signal: AppHiddenSignal };
  /** Browser reported the network came back. Fires alongside `app.resume`. */
  "app.online": Record<string, never>;
  /** Browser reported the network went away. */
  "app.offline": Record<string, never>;
}

export type BusEventName = keyof BusEventMap;
export type BusEventPayload<K extends BusEventName> = BusEventMap[K];
export type BusHandler<K extends BusEventName> = (
  payload: BusEventPayload<K>,
) => void;

export interface EventBus {
  subscribe<K extends BusEventName>(event: K, handler: BusHandler<K>): () => void;
  publish<K extends BusEventName>(event: K, payload: BusEventPayload<K>): void;
}

/**
 * Construct a fresh, isolated bus. Tests use this to avoid bleeding
 * state across cases; production code reads the module singleton via
 * {@link getEventBus}.
 */
export function createEventBus(): EventBus {
  const handlers = new Map<BusEventName, Set<BusHandler<BusEventName>>>();

  return {
    subscribe(event, handler) {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(handler as BusHandler<BusEventName>);
      return () => {
        const current = handlers.get(event);
        if (!current) return;
        current.delete(handler as BusHandler<BusEventName>);
        if (current.size === 0) handlers.delete(event);
      };
    },
    publish(event, payload) {
      const set = handlers.get(event);
      if (!set || set.size === 0) return;
      // Snapshot before iterating so handlers that unsubscribe (or
      // resubscribe) during dispatch don't mutate the in-flight set.
      for (const handler of Array.from(set)) {
        try {
          (handler as BusHandler<typeof event>)(payload);
        } catch (err) {
          // One bad subscriber must not block downstream subscribers.
          // Surface via console so the failure is debuggable without
          // pulling Sentry into a primitive. Callers that need
          // observability can wrap their own handler.
          console.error("[event-bus] handler threw", event, err);
        }
      }
    },
  };
}

let singleton: EventBus | null = null;

/**
 * Module-level singleton accessor. Lazily constructed so SSR / Node
 * test setups that never read the bus don't pay for it. Hooks anywhere
 * in the chat-layout subtree can call this without prop drilling.
 */
export function getEventBus(): EventBus {
  if (!singleton) {
    singleton = createEventBus();
  }
  return singleton;
}

/**
 * Reset the module singleton. Used by tests to ensure isolation across
 * cases; not intended for production callers.
 */
export function __resetEventBusForTesting(): void {
  singleton = null;
}
