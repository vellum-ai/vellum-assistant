# Web App — Event Bus

How cross-domain push signals (SSE, app lifecycle, network reachability)
flow through `apps/web/`. One bus instance per tab, one SSE connection
per tab, typed events, synchronous delivery.

See also [`apps/web/AGENTS.md`](../AGENTS.md), the umbrella
[`CONVENTIONS.md`](./CONVENTIONS.md), and
[`STATE_MANAGEMENT.md`](./STATE_MANAGEMENT.md).

---

## Why a bus

The daemon serves SSE on `GET /v1/events` and identifies clients via a
stable per-browser `clientId` header. Each `clientId` may have at most
one active subscription — a second subscribe from the same id replaces
the first. A single bus owner is therefore the only correct way to
have multiple parts of the UI observe daemon events from the same tab.

Centralizing through a bus also gives us:

- **Typed delivery.** Subscribers narrow on event name and get a
  payload type from `BusEventMap` — no per-call casting, no string
  matching on event shapes.
- **One place for lifecycle policy.** Tab visibility, network
  reachability, and Capacitor app-state all interact with the SSE
  connection (tear down on hidden, reopen on resume, bounce on
  retry). Putting that policy in the bus owner keeps it consistent
  across every consumer.
- **No polling.** Components that need to react to server-side state
  changes subscribe to a typed event instead of running their own
  interval timer. If the daemon already knows when something
  resolves, it pushes the event; the client reacts.

## Where it lives

| Module | Role |
|---|---|
| `apps/web/src/stores/event-bus-store.ts` | The bus itself. Zustand store with `subscribe(event, handler)` / `publish(event, payload)` actions and a module-private handler registry. |
| `apps/web/src/hooks/use-event-bus-init.ts` | Wires the bus to its sources: opens the single assistant-scoped `/v1/events` SSE, registers `document.visibilitychange` + `window.online`/`offline` + Capacitor `App.appStateChange`. Mounted exactly once by `RootLayout` so the bus is alive on every authenticated route (chat, settings, logs, onboarding). |

The bus is a Zustand store per the [state-management
convention](./STATE_MANAGEMENT.md) — all shared client-state primitives
live in Zustand. The store's state is private; consumers only ever call
the action surface (`subscribe` / `publish`). Pub/sub semantics do not
flow through Zustand reactivity: handlers fire synchronously from
`publish()` so a burst of events isn't collapsed into a single React
commit cycle.

## Event protocol

Every event name in `BusEventMap` has a typed payload. The producer is
`useEventBusInit` for everything except `reachability.retry-requested`,
which is produced by the burst-limited reachability retry in
`use-event-stream.ts`.

| Event | Payload | Produced when |
|---|---|---|
| `sse.event` | `AssistantEvent` | Every event the bus-owned SSE connection sees. Consumers narrow on `payload.type` and filter on `payload.conversationId` themselves. |
| `sse.opened` | `{ assistantId; cause: "fresh" \| "error" \| "watchdog" \| "resume" }` | After each successful (re)open. `cause` lets consumers distinguish a fresh connection from a watchdog-driven recovery. |
| `sse.closed` | `{ reason }` | Transport error on the SSE connection. Not published for intentional teardowns (hidden tab, reachability bounce). |
| `app.resume` | `{ signal: "visibility" \| "app_state" \| "online" }` | Page visible, app foregrounded, or network came back online. |
| `app.hidden` | `{ signal: "visibility" \| "app_state" }` | Page hidden or app backgrounded. |
| `app.online` | `{}` | `window.online` fired. Always accompanies a paired `app.resume{signal:"online"}`. |
| `app.offline` | `{}` | `window.offline` fired. |
| `reachability.retry-requested` | `{}` | Burst-limited reachability retry succeeded; the bus bounces its SSE. |
| `power.suspend` | `{}` | Electron host: `powerMonitor` `suspend` — system going to sleep. Bus tears down its SSE so the daemon sees a clean disconnect. Off Electron (web / iOS) never fires. |
| `power.resume` | `{}` | Electron host: `powerMonitor` `resume` — system woke. Bus bounces (teardown + reopen) its SSE regardless of `current` state — the renderer may have stayed visible during sleep (tray-resident / full-screen) so the socket may be half-dead. Off Electron never fires. |
| `power.lock` | `{}` | Electron host: screen locked. No bus-owned action today. Off Electron never fires. |
| `power.unlock` | `{}` | Electron host: screen unlocked. Bus bounces its SSE (same shape as `power.resume`). Off Electron never fires. |
| `power.active` | `{}` | Electron host: `user-did-become-active` after idle. No bus-owned action today; future ticket may nudge stale state. Off Electron never fires. |

## Subscribing

In a React hook or component, use `useBusSubscription` from
`@/hooks/use-bus-subscription.js`. It wraps `useEffect` + `subscribe`
+ cleanup and stabilises the handler ref so inline arrows don't
re-register on every render.

```ts
import { useBusSubscription } from "@/hooks/use-bus-subscription";

useBusSubscription("app.resume", ({ signal }) => {
  // Refetch stale-while-revalidate data here.
});
```

In code outside the React tree (Zustand store bootstraps, route
loaders, middleware), use `subscribeBus` from the same module and
store the returned unsubscribe handle alongside the bootstrap's other
teardown:

```ts
import { subscribeBus } from "@/hooks/use-bus-subscription";

const unsubscribeResume = subscribeBus("app.resume", () => {
  refetchIfStale();
});
// Add unsubscribeResume() to the existing teardown closure.
```

Both helpers wrap `useEventBusStore.getState().subscribe(...)`. New
code should not call `useEventBusStore.getState()` directly for
subscriptions — use the helpers so the unsubscribe lifecycle is
consistent everywhere.

## Publishing

Publishing is reserved for the bus owner (`useEventBusInit`) and the
narrow surfaces that need to ask the bus to do something — today only
`reachability.retry-requested`. Don't add new producers without a
documented reason.

```ts
useEventBusStore.getState().publish("reachability.retry-requested", {});
```

## Adding a new event

1. Add the name + payload type to `BusEventMap` in
   `event-bus-store.ts`. Keep the JSDoc on the field — it's how
   consumers learn when the event fires.
2. Add the producer. SSE-derived events go in `use-event-bus-init.ts`'s
   SSE effect. DOM-derived events go in its lifecycle effect.
3. Add subscribers where needed via `useBusSubscription` (React) or
   `subscribeBus` (stores / non-React).
4. Test the producer (publish round-trip in `use-event-bus-init.test.tsx`
   or `event-bus-store.test.ts`) and at least one consumer.

## Conventions

- **Use the helpers, not the raw store.** `useBusSubscription` and
  `subscribeBus` from `@/hooks/use-bus-subscription.js` are the only
  blessed subscriber surfaces. Don't reach into
  `useEventBusStore.getState().subscribe(...)` from new code — the
  helpers exist to keep the unsubscribe lifecycle consistent.
- **Inline handlers are fine.** `useBusSubscription` stabilises the
  handler ref internally, so passing an arrow function does not
  re-register the subscription on every render. No `useCallback`
  ceremony required.
- **Subscribe at the right scope.** Bus subscribers belong in the
  layer that owns the resulting side-effect: the hook that mutates a
  query cache, the store whose state needs to refresh, the component
  whose visual state depends on it. Don't subscribe inside deeply
  nested presentational components.
- **Filter inside the handler.** `bus.sse.event` is unfiltered;
  consumers narrow on `payload.type` and (for conversation-scoped
  consumers) on `payload.conversationId`. The bus delivers every
  event the SSE connection sees.
- **Skip resume signals you don't care about.** `app.resume` fires for
  visibility, app foregrounding, AND network online. A handler that
  only cares about real foregrounding can early-return when
  `signal === "online"` (see `use-home-feed-query.ts`).

## Common patterns

### Invalidate a query cache on resume

```ts
const queryClient = useQueryClient();
useBusSubscription("app.resume", () => {
  void queryClient.invalidateQueries({ queryKey: ["my-data"] });
});
```

### Track time-away between hidden and resume

```ts
const hiddenAtRef = useRef<number | null>(null);
useBusSubscription("app.hidden", () => {
  hiddenAtRef.current = Date.now();
});
useBusSubscription("app.resume", ({ signal }) => {
  if (signal === "online") return; // network blip, not real time-away
  const hiddenAt = hiddenAtRef.current;
  hiddenAtRef.current = null;
  if (hiddenAt == null) return;
  const elapsedMs = Date.now() - hiddenAt;
  // Use elapsedMs.
});
```

### React to a typed SSE event

```ts
useBusSubscription("sse.event", (event) => {
  if (event.type !== "interaction_resolved") return;
  // event is narrowed to the InteractionResolvedEvent shape.
  queryClient.setQueryData(["interactions", event.requestId], { state: event.state });
});
```

### Imperative subscriber inside a store bootstrap

```ts
export function setupMyStore(): () => void {
  const unsubResume = subscribeBus("app.resume", () => {
    refetchIfStale();
  });
  return () => {
    unsubResume();
    // ...other teardown.
  };
}
```

## Don't do this

- **Don't call `subscribeChatEvents` directly outside `use-event-bus-init.ts`.** Every other consumer subscribes to `bus.sse.event`. A second SSE handle from the same `clientId` will evict the first on the daemon.
- **Don't register `document.addEventListener("visibilitychange", ...)`** in a component or store for data-refresh purposes. Subscribe to `bus.app.resume` instead. The only legitimate `visibilitychange` registration in the app is the one inside `use-event-bus-init.ts`.
- **Don't register `window.online` / `window.offline` listeners** in a component or store. Subscribe to `bus.app.online` / `bus.app.offline`.
- **Don't add polling intervals to discover state the daemon could push.** If the daemon already knows when something resolves, emit a typed event over `/v1/events` and subscribe to it via the bus.
- **Don't read `useEventBusStore.use.*` in a component render body.** The store's reactive surface is empty by design — there's no state worth subscribing to. Always use `.getState().subscribe(...)` inside an effect or bootstrap closure.

## Testing

`event-bus-store.test.ts` covers the pub/sub surface (subscribe,
unsubscribe, publish, isolation between event names, throwing-handler
robustness). `use-event-bus-init.test.tsx` covers the source-wiring:
SSE open gating, event re-broadcast, `sse.opened` cause tagging,
teardown on `app.hidden`, reopen on `app.resume`, and the dedup window.

`__resetEventBusForTesting()` is exported from
`event-bus-store.ts` for use in `beforeEach`/`afterEach`. Don't import
it from production code.

## References

- [Zustand — Reading/writing state outside components](https://zustand.docs.pmnd.rs/guides/reading-and-writing-state-outside-components)
- [`STATE_MANAGEMENT.md`](./STATE_MANAGEMENT.md) — why the bus is a
  Zustand store even though it doesn't expose reactive state.
- [`CAPACITOR.md`](./CAPACITOR.md) — Capacitor `App.appStateChange`
  feeds the bus's `app.resume` / `app.hidden` channels on iOS.
