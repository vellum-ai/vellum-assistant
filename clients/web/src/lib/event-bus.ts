/**
 * Cross-domain typed publish/subscribe registry for assistant-global
 * signals (SSE events, app lifecycle, network reachability, deep
 * links). Plain module — `publish` and `subscribe` are exported
 * functions, the handler registry is module-private.
 *
 * Not a Zustand store. The bus has no state; what looks like state
 * (the handler set) is a registry, not user-observable application
 * state, so Zustand's selector + re-render machinery does not apply.
 * Handlers fire synchronously from `publish()` so a burst of events
 * is not collapsed into a single React commit. See
 * `STATE_MANAGEMENT.md` for the convention carve-out.
 *
 * Producers:
 *   - `runtime/event-sources/*` for host-environment signals
 *   - `assistant/sse-service.ts` for SSE-derived signals
 *   - `domains/chat/hooks/use-event-stream.ts` for
 *     `reachability.retry-requested`
 *   - `hooks/use-notification-tap-navigation.ts` and
 *     `runtime/push-registration.ts` for notification-tap
 *     `deeplink.openThread`
 *
 * Consumers: `useBusSubscription` (React) or `subscribe` directly
 * (non-React).
 */

import type { AssistantEventEnvelope } from "@vellumai/assistant-api";

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
   * assistant-scoped `/v1/events` connection. The envelope carries
   * transport metadata (`seq`, `conversationId`, `emittedAt`);
   * subscribers read the semantic event from `envelope.message`.
   */
  "sse.event": AssistantEventEnvelope;
  /**
   * The bus-owned SSE connection just opened (or reopened). Carries the
   * `cause` of the (re)open so consumers can distinguish a fresh
   * connection from a transport-error reconnect, a watchdog-driven
   * recovery, or a manual `_vellumDebug.events.reconnectClient()`
   * trigger. Conversation-scoped consumers use this to schedule a
   * post-reconnect reconciliation pass.
   *
   * `"anchor"` is the cold-start anchored-replay reopen (see
   * `cold-anchor.ts`): the connection re-attaches carrying
   * `lastSeenSeq = S` so the daemon ring-replays the snapshot→attach
   * gap. It deliberately does NOT trigger a post-reopen `/messages`
   * reconcile — the ring replay is the catch-up mechanism, and ring
   * eviction is handled by the consumer's seq-gap detector.
   */
  "sse.opened": {
    assistantId: string;
    cause: "fresh" | "error" | "watchdog" | "resume" | "debug" | "anchor";
  };
  /**
   * The bus-owned SSE connection closed for a non-cancel reason
   * (network error, etc). Carries a short reason tag for diagnostics.
   * The bus will attempt to reopen on its own; consumers use this to
   * recover conversation-scoped turn state (e.g. settle processing
   * state, kick reachability probes).
   */
  "sse.closed": { reason: string };
  /**
   * Published by `useEventStream`'s reachability-retry burst limiter
   * after the reachability probe flips back to "ready". Tells the bus
   * to close + reopen its SSE connection so the conversation-scoped
   * reconcile pass can run.
   */
  "reachability.retry-requested": Record<string, never>;
  /**
   * Published by `cold-anchor.ts` once `/messages` has resolved with a
   * snapshot watermark `S` on a cold session. Tells the bus to bounce
   * its SSE connection so the reopen carries `lastSeenSeq = S` and the
   * daemon ring-replays the snapshot→attach gap. The cursor is already
   * seeded at `S` before this fires; if no connection is attached yet
   * the bounce is a no-op and the upcoming cold connect carries the
   * cursor directly.
   */
  "sse.anchor-requested": Record<string, never>;
  /** Page visible / app foregrounded / network came back online. */
  "app.resume": { signal: AppResumeSignal };
  /** Page hidden / app backgrounded. */
  "app.hidden": { signal: AppHiddenSignal };
  /** Browser reported the network came back. Fires alongside `app.resume`. */
  "app.online": Record<string, never>;
  /** Browser reported the network went away. */
  "app.offline": Record<string, never>;
  /**
   * System-level power events from the Electron host. Distinct from
   * `app.resume` / `app.hidden` because a tray-resident or
   * full-screen Electron app stays "visible" during system sleep —
   * the renderer never sees `visibilitychange`, but `powerMonitor`
   * does. Long-running consumers (SSE, WebSockets, refresh timers)
   * use these to bounce-and-reconnect because browser timers freeze
   * during system suspend and sockets may appear "open" but be
   * half-dead on wake.
   *
   * Off Electron (web build, Capacitor iOS) these never fire — the
   * platform's resume signals come through `app.resume` instead.
   */
  "power.suspend": Record<string, never>;
  "power.resume": Record<string, never>;
  "power.lock": Record<string, never>;
  "power.unlock": Record<string, never>;
  "power.active": Record<string, never>;
  /**
   * Inbound deep links — `vellum://` / `vellum-assistant://` URLs
   * the OS routed to us, plus notification taps that resolve to a
   * conversation. Domain consumers (chat composer, conversation
   * router) subscribe here to take action.
   *
   * Publishers: Electron deep links, the notification tap handler,
   * push-registration, and Capacitor `appUrlOpen` — see
   * docs/EVENT_BUS.md for the per-event table. `deeplink.unknown` is a
   * no-action signal (consumers log and drop it) so the bridge surface
   * stays exhaustive.
   */
  "deeplink.send": { message: string };
  "deeplink.openThread": { threadId: string };
  "deeplink.unknown": { url: string };
  /**
   * Connectivity state change from the Electron host. Main fuses
   * device-level online/offline with backend health-probe results into
   * three states: `"online"`, `"device-offline"`, `"backend-unreachable"`.
   *
   * Off Electron this never fires.
   */
  "connectivity.state": {
    state: "online" | "device-offline" | "backend-unreachable";
  };
}

export type BusEventName = keyof BusEventMap;
export type BusEventPayload<K extends BusEventName> = BusEventMap[K];
export type BusHandler<K extends BusEventName> = (
  payload: BusEventPayload<K>,
) => void;

type AnyHandler = (payload: never) => void;
// `let` (not `const`) because `__resetForTesting` reassigns to a
// fresh Map rather than clearing in place. After reset the module-
// level `handlers` points to an empty Map, so any old unsubscribe
// closure (which reads `handlers` through the binding, not by value)
// sees `handlers.get(event) === undefined` and early-returns — that's
// the property the "unsubscribe-after-reset is a no-op" test relies on.
let handlers: Map<BusEventName, Set<AnyHandler>> = new Map();

/**
 * Subscribe a handler to a bus event. Returns an unsubscribe
 * function; safe to call multiple times. Handlers are invoked
 * synchronously in registration order; a thrown handler is logged
 * and does not block downstream handlers.
 */
export function subscribe<K extends BusEventName>(
  event: K,
  handler: BusHandler<K>,
): () => void {
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
}

/** Publish a payload to every handler subscribed to `event`. */
export function publish<K extends BusEventName>(
  event: K,
  payload: BusEventPayload<K>,
): void {
  const set = handlers.get(event);
  if (!set || set.size === 0) return;
  // Snapshot before iterating so handlers that unsubscribe (or
  // resubscribe) during dispatch don't mutate the in-flight set.
  for (const handler of Array.from(set)) {
    try {
      (handler as (p: typeof payload) => void)(payload);
    } catch (err) {
      // One bad subscriber must not block downstream subscribers.
      // Console-log rather than re-throw or call Sentry directly so
      // the bus stays free of a hard dependency on the reporting
      // layer (subscribers already log their own captures via Sentry
      // when they care about it).
      console.error("[event-bus] handler threw", event, err);
    }
  }
}

/**
 * Reset the handler registry. Tests use this between cases to ensure
 * isolation; not intended for production callers.
 */
export function __resetForTesting(): void {
  handlers = new Map();
}
