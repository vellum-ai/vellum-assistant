/**
 * Cross-domain typed publish/subscribe surface for assistant-global
 * signals (SSE events, app lifecycle, network reachability).
 *
 * Pub/sub semantics intentionally do not flow through Zustand
 * reactivity — handlers fire synchronously from `publish()` rather
 * than via state-change subscriptions, so a single batched react
 * commit cycle does not collapse a burst of events. The Zustand
 * wrapper exists for codebase consistency and the `.getState()`
 * non-React entry point, not for React reactivity.
 *
 * Sources are wired by `useEventBusInit` at chat-layout scope: a
 * single assistant-scoped SSE connection and DOM lifecycle events
 * (visibility, online, offline, Capacitor app-state). Consumers
 * anywhere in the chat-layout subtree subscribe via
 * `useEventBusStore.getState()`.
 *
 * @see {@link https://zustand.docs.pmnd.rs/}
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";
import type { AssistantEvent } from "@/types/event-types";

/**
 * Source of a synthetic `"app.resume"` event.
 *
 * `"visibility"`: `document.visibilitychange` fired with
 * `visibilityState === "visible"` on a web client.
 * `"app_state"`: Capacitor `App.appStateChange` fired with `isActive`
 * in the iOS native shell. Web + Capacitor consumers must dedup
 * `"visibility"` and `"app_state"` themselves when both arrive in
 * close succession (the bus does not — its purpose is to deliver
 * every signal it sees).
 * `"online"`: `window.online` fired after `navigator.onLine` flipped
 * back to true; surfaced as a resume so consumers that just want
 * "we're probably stale, refresh" can subscribe to a single channel.
 */
export type AppResumeSignal = "visibility" | "app_state" | "online";

/** Source of a synthetic `"app.hidden"` event. */
export type AppHiddenSignal = "visibility" | "app_state";

/**
 * Map of bus event name → payload type. New event names are added
 * here so subscribers get exact handler types via the `keyof` lookup.
 */
export interface BusEventMap {
  /**
   * Re-broadcast of an SSE event received on the bus-owned
   * assistant-scoped `/v1/events` connection. Subscribers narrow on
   * `payload.type`. Conversation-scoped consumers must filter on
   * `event.conversationId` themselves — the bus delivers every
   * event the underlying stream sees.
   */
  "sse.event": AssistantEvent;
  /**
   * The bus-owned SSE connection just opened (or reopened). Carries the
   * `cause` of the (re)open so consumers can distinguish a fresh
   * connection from a transport-error reconnect or a watchdog-driven
   * recovery. Conversation-scoped consumers use this to schedule a
   * post-reconnect reconciliation pass.
   */
  "sse.opened": {
    assistantId: string;
    cause: "fresh" | "error" | "watchdog" | "resume";
  };
  /**
   * The bus-owned SSE connection closed for a non-cancel reason
   * (network error, etc). Carries a short reason tag for diagnostics.
   * The bus will attempt to reopen on its own; consumers use this to
   * recover conversation-scoped turn state (e.g. clear `isStreaming`
   * flags, kick reachability probes).
   */
  "sse.closed": { reason: string };
  /**
   * Published by `useEventStream`'s reachability-retry burst limiter
   * after the reachability probe flips back to "ready". Tells the bus
   * to close + reopen its SSE connection so the conversation-scoped
   * reconcile pass can run.
   */
  "reachability.retry-requested": Record<string, never>;
  /** Page visible / app foregrounded / network came back online. */
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

// ---------------------------------------------------------------------------
// Internal handler registry
// ---------------------------------------------------------------------------
//
// Handlers live outside Zustand state on purpose. React-Query-style
// reactivity (re-render on every state change) is not what consumers
// want from a pub/sub: every subscribe call would re-render every
// other subscriber, and a burst publish would coalesce into a single
// commit.
//
// Encapsulated in a module-private map so tests reset it via the
// exported `__resetEventBusForTesting` hook.

type AnyHandler = (payload: never) => void;
let handlers: Map<BusEventName, Set<AnyHandler>> = new Map();

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface EventBusState {
  /**
   * Reserved for future internals. Kept here so future state fields
   * (e.g. last-seen connection status) can be added without churning
   * every consumer's import path. Tests must not depend on this shape.
   */
  readonly _version: 1;
}

export interface EventBusActions {
  /**
   * Subscribe a handler to a bus event. Returns an unsubscribe
   * function; safe to call multiple times. Handlers are invoked
   * synchronously in registration order; a thrown handler is logged
   * and does not block downstream handlers.
   */
  subscribe<K extends BusEventName>(
    event: K,
    handler: BusHandler<K>,
  ): () => void;
  /** Publish a payload to every handler subscribed to `event`. */
  publish<K extends BusEventName>(event: K, payload: BusEventPayload<K>): void;
}

export type EventBusStore = EventBusState & EventBusActions;

const useEventBusStoreBase = create<EventBusStore>()(() => ({
  _version: 1,

  subscribe(event, handler) {
    let set = handlers.get(event);
    if (!set) {
      set = new Set();
      handlers.set(event, set);
    }
    set.add(handler as AnyHandler);
    return () => {
      const current = handlers.get(event);
      if (!current) return;
      current.delete(handler as AnyHandler);
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
        (handler as (p: typeof payload) => void)(payload);
      } catch (err) {
        // One bad subscriber must not block downstream subscribers.
        // Surface via console so the failure is debuggable without
        // pulling Sentry into a primitive.
        console.error("[event-bus] handler threw", event, err);
      }
    }
  },
}));

export const useEventBusStore = createSelectors(useEventBusStoreBase);

/**
 * Reset the handler registry. Tests use this between cases to ensure
 * isolation; not intended for production callers.
 */
export function __resetEventBusForTesting(): void {
  handlers = new Map();
}
