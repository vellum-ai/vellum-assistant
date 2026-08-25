# Web App — Event Bus

How cross-domain push signals (SSE, app lifecycle, network reachability)
flow through `clients/web/`. One bus instance per tab, one SSE connection
per tab, typed events, synchronous delivery.

See also [`clients/web/AGENTS.md`](../AGENTS.md), the umbrella
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
| `clients/web/src/lib/event-bus.ts` | The bus itself. Plain module with `publish` / `subscribe` / `__resetForTesting` exports and a module-private handler `Map`. Not a Zustand store — no state, just a registry. See the [stateless-registries carve-out](./STATE_MANAGEMENT.md#when-zustand-does-not-apply-stateless-registries). |
| `clients/web/src/hooks/use-bus-subscription.ts` | React hook wrapping `useEffect` + `subscribe` with a stable handler ref so inline arrows don't re-register on every render. |
| `clients/web/src/hooks/use-event-bus-init.ts` | Thin React adapter. Wires the signal sources at mount and calls `sseService.attach` whenever the active assistant changes. Mounted exactly once by `RootLayout` so the bus is alive on every authenticated route. |
| `clients/web/src/runtime/event-sources/*` | One file per host-environment signal (DOM visibility, network online/offline, Capacitor app state, Electron `powerMonitor`, Electron deep links). Each calls `publish` directly and returns an unsubscribe. |
| `clients/web/src/runtime/event-sources/lifecycle-edge.ts` | Not a source: the shared seam the DOM-visibility and Capacitor app-state sources publish through. Collapses their two reports of one physical foreground / background edge into a single `app.resume` / `app.hidden`. |
| `clients/web/src/lib/lifecycle-diagnostics.ts` | Bus consumer that records `app.*` / `power.*` signals into the durable lifecycle diagnostics ring so support bundles show whether any resume / visibility / network signal fired. Attached once alongside the signal sources in `use-event-bus-init.ts`. |
| `clients/web/src/assistant/sse-service.ts` | Non-React owner of the assistant-scoped SSE connection. Opens the stream, republishes envelopes as `sse.event`, drives the bounce policy from `app.*` / `power.*` / `reachability.*` signals. |

The bus is a plain pub/sub module. Handlers fire synchronously from
`publish()` so a burst of events isn't collapsed into a single React
commit cycle. The handler `Map` lives in module scope, not in any
Zustand store — consumers never read it, only register handlers into
it and dispatch through it.

## Event protocol

Every event name in `BusEventMap` has a typed payload. Producers:

- `runtime/event-sources/*` for host-environment signals (`app.*`, `power.*`, `deeplink.*`).
- `assistant/sse-service.ts` for SSE-derived signals (`sse.*`).
- `use-event-stream.ts`'s burst-limited reachability retry for `reachability.retry-requested`.
- `hooks/use-notification-tap-navigation.ts` and `runtime/push-registration.ts` for notification-tap `deeplink.openThread`.
- `lib/api-interceptors.ts`'s daemon response interceptor for `assistant.unreachable`, and its local-gateway 401 recovery for `gateway.guardian-repair-required`.

| Event | Payload | Produced when |
|---|---|---|
| `sse.event` | `AssistantEventEnvelope` | Every event the bus-owned SSE connection sees. The envelope carries transport metadata (`seq`, `conversationId`, `emittedAt`); subscribers narrow on `envelope.message.type` and filter on `envelope.conversationId` themselves. |
| `sse.opened` | `{ assistantId; cause: "fresh" \| "error" \| "watchdog" \| "resume" \| "debug" \| "anchor" }` | After each successful (re)open. `cause` lets consumers distinguish a fresh connection from a reconnect. `"debug"` is a manual `_vellumDebug.events.reconnectClient()` trigger; `"anchor"` is a cold-start anchored-replay reopen. |
| `sse.closed` | `{ reason }` | Transport error on the SSE connection. Not published for intentional teardowns (hidden tab, reachability bounce). |
| `assistant.unreachable` | `{}` | A daemon SDK request came back 502/503/504: it reached the platform but not the assistant's runtime. `daemonUnreachableInterceptor` publishes it so the connecting overlay appears even when the failure lands on an incidental request rather than on the SSE stream; `lifecycle-service.ts` subscribes and kicks its retry probe. |
| `app.resume` | `{ signal: "visibility" \| "app_state" \| "online" }` | Page visible, app foregrounded, or network came back online. At most one per physical foreground edge: iOS reports the same edge twice (`visibilitychange` and Capacitor `appStateChange`, milliseconds apart) and `runtime/event-sources/lifecycle-edge.ts` collapses the pair, keeping the label of whichever source arrived first. `signal: "online"` is outside that dedup and always fires. |
| `app.hidden` | `{ signal: "visibility" \| "app_state" }` | Page hidden or app backgrounded. Deduped per physical edge exactly like `app.resume`. Only repeats of the same edge collapse, so a hide landing between two foregrounds is always delivered. |
| `app.online` | `{}` | `window.online` fired. Always accompanies a paired `app.resume{signal:"online"}`. |
| `app.offline` | `{}` | `window.offline` fired. |
| `reachability.retry-requested` | `{}` | Burst-limited reachability retry succeeded on recovery into `"ready"` from a degraded phase (`"connecting"`, `"checking"`, or `"failed"`); the bus bounces its SSE. A `"ready"` entered from `"idle"` or `"ready"` confirms an already-healthy stream (boot, remount) and does not publish. |
| `power.suspend` | `{}` | Electron host: `powerMonitor` `suspend` — system going to sleep. Bus tears down its SSE so the daemon sees a clean disconnect. Off Electron (web / iOS) never fires. |
| `power.resume` | `{}` | Electron host: `powerMonitor` `resume` — system woke. Bus bounces (teardown + reopen) its SSE regardless of `current` state — the renderer may have stayed visible during sleep (tray-resident / full-screen) so the socket may be half-dead. Off Electron never fires. |
| `power.lock` | `{}` | Electron host: screen locked. No bus-owned action today. Off Electron never fires. |
| `power.unlock` | `{}` | Electron host: screen unlocked. Bus bounces its SSE (same shape as `power.resume`). Off Electron never fires. |
| `power.active` | `{}` | Electron host: `user-did-become-active` after idle. No bus-owned action today; future ticket may nudge stale state. Off Electron never fires. |
| `deeplink.send` | `{ message }` | Electron host only: inbound `vellum://send?message=…` URL routed by Launch Services. Chat domain consumes to pre-fill the composer. |
| `deeplink.openThread` | `{ threadId }` | Electron host: inbound `vellum://thread/<id>` URL. Also published by the notification-tap handler (`hooks/use-notification-tap-navigation.ts`) on every platform — Capacitor local notifications, Electron notification actions, browser `Notification.onclick` — and by APNs remote-push taps on Capacitor iOS (`runtime/push-registration.ts`). Chat domain consumes to navigate. |
| `deeplink.sendToThread` | `{ threadId, message, provenance: "intent" \| null }` | Capacitor iOS: inbound `vellum-assistant://thread/<id>?message=…` URL (`runtime/event-sources/capacitor-deep-links.ts`), produced by the "Send Message to Chat" App Intent (LUM-3230). `parseOpenThreadDeepLink` validates the id's shape and bounds/sanitizes the message (2000 chars, typed-text control-character rules, CRLF normalized); a thread link whose message fails sanitization publishes plain `deeplink.openThread` instead, so this event always carries usable text. `provenance` is `"intent"` only when the iOS shell proved an App Intent produced the URL (see the provenance note below the table). `useGlobalDeepLinkConsumer` navigates to the conversation either way; with proven provenance it parks a *send request* that `useDeepLinkThreadSend` (chat domain) fulfils once the target thread is confirmed to exist and demotes to a pre-fill when it is gone or the park has aged out; without it, it parks the message as a composer pre-fill and requests focus, one tap from sent. |
| `deeplink.billingCheckoutComplete` | `{ status, sessionId, flow: "subscription" \| "top_up" }` | Electron host (`runtime/event-sources/electron-deep-links.ts`) and Capacitor iOS (`runtime/event-sources/capacitor-deep-links.ts`): inbound `<scheme>://billing/checkout-complete?status=…&session_id=…&flow=…` URL. The platform bounces a native-initiated Stripe Checkout here once the user finishes in the system browser (Electron) or the in-app `SFSafariViewController` (iOS). Parsers default an absent `flow` param to `subscription` (all released clients and current Pro links). `useGlobalDeepLinkConsumer` branches on `flow`: a `subscription` checkout navigates to billing with the `session_id` (opening the Pro onboarding wizard) or to the upgrade-cancel page on `status: "cancel"`; a `top_up` checkout toasts + refetches the billing summary on success with no forced navigation, and on cancel lands on billing with `billing_status=cancel`, funneling into the billing page's server-verified checkout-bonus offer flow. `AddCreditsModal` also subscribes and dismisses itself on any `top_up` return, close-only: the summary refetch on success is owned by `useGlobalDeepLinkConsumer` via `notifyCheckoutSuccess`, and the modal's Capacitor `browserFinished` listener (also close-only) cannot fire on Electron, so this event is the desktop shell's only close signal. |
| `deeplink.startVoice` | `{ mode: "new" \| "resume", prompt: string \| null, provenance: "intent" \| null }` | Capacitor iOS: inbound `vellum-assistant://voice?mode=…&prompt=…` URL (`runtime/event-sources/capacitor-deep-links.ts`). The single native→SPA voice command channel: Siri and the Action Button (App Intents), the Dynamic Island Live Activity's tap-to-return `widgetURL`, and manual test links all arrive here. `useGlobalDeepLinkConsumer` navigates and hands the request to the live-voice starter, parking it while the layout-scoped session controller is unmounted (cold launch). `mode: "resume"` only navigates back to a running session. `prompt` is what Siri's "Ask …" intent collected before the app was up: `parseStartVoiceDeepLink` bounds it (2000 chars) and rejects control characters. With no call running the consumer skips the voice session either way (it has no text-turn frame; JARVIS-1522) and then branches on `provenance`: proven, the prompt is asked as a text turn in a fresh conversation via `navigateToNewConversation`'s `?prompt=` auto-send; unproven, it is parked in the composer inbox (`deeplink.send`'s one-shot store) with focus requested and never auto-sent. A prompt arriving mid-call parks as a pre-fill regardless. See the hook's docstring. |
| `deeplink.openCamera` | `{ provenance: "intent" \| null }` | Capacitor iOS: inbound `vellum-assistant://camera` URL (`runtime/event-sources/capacitor-deep-links.ts`), produced by the Quick Actions Home Screen widget's camera button (`OpenCameraIntent`). No parameters: the host is the whole request. `useGlobalDeepLinkConsumer` navigates to `/assistant` and parks the request; the composer's attachment layer (`useCameraDeepLink`) drains it and mounts `CameraCaptureOverlay`, a full-screen modal viewfinder over the camera bridge (the `@capacitor-community/camera-preview` layer, with a `getUserMedia` `<video>` on a shell that does not register the plugin), so a cold launch behaves like a tap into a running app. The shutter's frame goes to the composer's own attachment pipeline, so a deep-linked photo picks up the same vision gate, resize and HEIC conversion a dropped or picked file does. A file input is unreachable from this path: WKWebView presents one only for a click carrying transient DOM user activation, and a URL drained from `appUrlOpen` carries none. A drain landing during a live-voice call spends the request without raising anything, since the call owns the one camera layer. The park ages out after a minute, as the voice start's does. `provenance` is carried for parity with the other command parsers; no consumer gates on it, since the command moves no untrusted content into the app. |
| `deeplink.newChat` | `{ provenance: "intent" \| null }` | Capacitor iOS: inbound `vellum-assistant://new-chat` URL (`runtime/event-sources/capacitor-deep-links.ts`), produced by the Home Screen widgets' New Chat buttons (`OpenNewChatIntent`). No parameters. `useGlobalDeepLinkConsumer` calls `navigateToNewConversation`, the same helper the in-app new-chat controls use, so the tap lands on a registered draft with the composer focused. `provenance` as on `deeplink.openCamera`. |
| `deeplink.connect` | `{ url: string \| null, bundle: string \| null }` | Electron host only: inbound `<scheme>://connect` URL from the SPA pair page's "Open in the Vellum app" button or a `vellum pair --qr --app` QR code. `bundle` is a pairing bundle that prefills the Connect a Remote Assistant dialog; it is secret material, never logged or breadcrumbed (the device `code` a url+code link carries is dropped at the bridge for the same reason). `useGlobalDeepLinkConsumer` parks the request in the connect-dialog store and navigates to the assistant chooser; bundle-less links get guidance copy naming `url`'s host. |
| `gateway.guardian-repair-required` | `{}` | The local gateway's `/auth/token` mint still answers 401 after the wake `primeLocalGatewayConnectionWithRepair` ran. A plain wake never re-leases a guardian token, so only a guardian re-provision clears this, and that revokes the assistant's other device-bound tokens, so no automatic path may run it. `localGatewayAuthRecoveryInterceptor` has no route to the user, so it publishes here after dropping the rejected token; `useGuardianRepairRoute` sends the session to the assistant chooser, whose connect path owns the re-provision. |
| `deeplink.unknown` | `{ url }` | Parser fallback for foreign schemes / malformed URLs — from the Electron deep-link path and from Capacitor iOS `App.appUrlOpen` URLs no handler claims (`runtime/event-sources/capacitor-deep-links.ts`). Consumers typically log + drop; exists so the bridge surface is exhaustive. |

**Command-URL provenance.** A custom URL scheme carries no caller identity: any installed app or web page can open `vellum-assistant://voice?prompt=…`. So deep-linked text is untrusted by default and only ever *staged* for the user to send. The one exception is proven: the iOS shell adds a `src=intent` query item inside `AppDelegate.deliverCommandURL(_:)`, which only in-process App Intents call, and strips that item from every URL arriving through `application(_:open:)` or `launchOptions[.url]`, the complete external entry surface (`clients/ios/App/App/CommandURLProvenance.swift`). By the time a URL reaches Capacitor's `appUrlOpen` the marker is present exactly when an intent produced it. `parseStartVoiceDeepLink` / `parseOpenThreadDeepLink` read it into `provenance` only when the caller passes `{ acceptProvenance: true }`, and `capacitor-deep-links.ts` passes that only on iOS: Android registers the same scheme (auth callback host) and strips nothing, so it must never be trusted there even if a future intent-filter widens what it accepts. LUM-3281. The read is on the raw `&`-split query, an item byte-equal to `src=intent`, never `URLSearchParams`: the shell (Foundation) and this parser (WHATWG) disagree about percent-decoding item names, so the raw item is the one spelling both see identically (ATL-1293). The shell strips that item and its percent-decoded spellings, so what the web side honors is a strict subset of what the shell strips.

## Subscribing

In a React hook or component, use `useBusSubscription` from
`@/hooks/use-bus-subscription`. It wraps `useEffect` + `subscribe` +
cleanup and stabilises the handler ref so inline arrows don't
re-register on every render.

```ts
import { useBusSubscription } from "@/hooks/use-bus-subscription";

useBusSubscription("app.resume", ({ signal }) => {
  // Refetch stale-while-revalidate data here.
});
```

In code outside the React tree (Zustand store bootstraps, route
loaders, middleware, services), import `subscribe` from
`@/lib/event-bus` directly and store the returned unsubscribe
handle alongside the bootstrap's other teardown:

```ts
import { subscribe } from "@/lib/event-bus";

const unsubscribeResume = subscribe("app.resume", () => {
  refetchIfStale();
});
// Add unsubscribeResume() to the existing teardown closure.
```

## Publishing

Publishing is reserved for the bus's owner files (`sseService`,
`runtime/event-sources/*`) and the narrow surfaces that need to ask
the bus to do something — today `reachability.retry-requested` and
the notification-tap `deeplink.openThread` publishers
(`hooks/use-notification-tap-navigation.ts`,
`runtime/push-registration.ts`), and both
`assistant.unreachable` and `gateway.guardian-repair-required` from
`lib/api-interceptors.ts`, whose response interceptors observe transport
and auth conditions only the UI can act on and have no other route to
it. Don't add new producers without a documented reason.

```ts
import { publish } from "@/lib/event-bus";

publish("reachability.retry-requested", {});
```

## Adding a new event

1. Add the name + payload type to `BusEventMap` in
   `lib/event-bus.ts`. Keep the JSDoc on the field — it's how
   consumers learn when the event fires.
2. Add the producer. SSE-derived events go in `assistant/sse-service.ts`
   (the non-React owner of the bus's SSE connection). Host-environment
   signals (DOM, Capacitor, Electron) go in a new file under
   `runtime/event-sources/` — see "Adding a new signal source" below.
3. Add subscribers where needed via `useBusSubscription` (React) or
   `import { subscribe }` (stores / services / non-React).
4. Test the producer (publish round-trip in `event-bus.test.ts` or a
   colocated unit test) and at least one consumer.

## Adding a new signal source

A *signal source* is the bridge between a host-environment event
(DOM visibility, `window.online`, Capacitor `appStateChange`, Electron
`powerMonitor`, deep links) and the bus. Each one lives in its own
file under `runtime/event-sources/`. The shape is intentionally
narrow:

```ts
import { publish } from "@/lib/event-bus";

export function publishMySignalSource(): () => void {
  // ...attach listener, call `publish("my.event", payload)`...
  return () => {
    // ...detach listener...
  };
}
```

Rules:

1. **One source per file.** New host-environment signal → new file
   in `runtime/event-sources/`. Don't add another `if` branch to
   `useEventBusInit`'s lifecycle effect.
2. **No `bus` parameter.** Sources call `publish` directly from
   `@/lib/event-bus`. Tests spy on `eventBus.publish` via
   `spyOn(eventBus, "publish")` after `import * as eventBus from "@/lib/event-bus"`.
   The lifecycle pair is the one exception: the DOM-visibility and
   Capacitor app-state sources call `publishLifecycleEdge` instead, so
   the edge they both observe reaches the bus once.
3. **No-op off-platform.** If the source is platform-conditioned
   (Capacitor-only, Electron-only), early-return a no-op
   unsubscribe. `useEventBusInit` calls every source unconditionally.
4. **Synchronous return.** Even lazy plugin imports (Capacitor) must
   return the unsubscribe synchronously — use an internal
   `cancelled` flag if the listener registration is async.
   See `capacitor-app-state.ts` for the pattern.
5. **Colocated unit test.** Test in isolation via
   `spyOn(eventBus, "publish")` on an `import * as eventBus from
   "@/lib/event-bus"` namespace — don't reach for the integration
   test in `use-event-bus-init.test.tsx`. The integration test is
   for SSE-policy behavior, not source wiring.
6. **Wire it in.** Add a single line to `useEventBusInit`'s Effect 1:
   ```ts
   const unsubscribers = [
     publishVisibilitySource(),
     // ...
     publishMySignalSource(),
   ];
   ```

## Conventions

- **Two subscriber surfaces.** `useBusSubscription` from
  `@/hooks/use-bus-subscription` for React; `subscribe` from
  `@/lib/event-bus` for non-React (stores, services, loaders).
  Both wrap the same module-private handler registry.
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
- **One resume per foreground, plus a separate `"online"`.** A handler
  does not have to collapse the iOS `"visibility"` + `"app_state"`
  double-fire itself: `lifecycle-edge.ts` publishes that pair once, and
  which of the two labels survives depends on which source the OS
  reached first, so treat them as interchangeable. The `"online"`
  caveat above still stands, because a reachability flip is published
  independently and can land right next to a foreground.

## Common patterns

### Invalidate a query cache on resume

For generic "refetch stale data on foreground" behaviour, **don't
subscribe to `app.resume` manually** — TQ's `focusManager` already
handles it globally (configured in `lib/query-focus-manager.ts`).
Every query with `refetchOnWindowFocus` (the default) re-fetches
automatically on tab-visible and Capacitor foregrounding.

Only subscribe to `app.resume` when you need *domain-specific*
side effects that go beyond cache invalidation — for example,
tracking time-away:

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

### Event-driven cache refresh via `fetchQuery`

When a bus event signals that server data changed but doesn't carry the
new data inline, use `queryClient.fetchQuery` with the generated
query-options factory to fetch and cache the fresh state. This is the
TanStack Query pattern for [programmatic (non-rendering) data
fetching](https://tanstack.com/query/latest/docs/reference/QueryClient#queryclientfetchquery)
— the hook equivalent (`useXxxQuery`) cannot be called inside event
handlers because of the
[Rules of Hooks](https://react.dev/reference/rules/rules-of-hooks).

```ts
import { conversationsByIdGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";

useBusSubscription("sse.event", (envelope) => {
  if (envelope.message.type !== "sync_changed") return;
  // fetchQuery deduplicates concurrent calls for the same query key.
  void queryClient.fetchQuery({
    ...conversationsByIdGetOptions({ path: { assistant_id: id, id: convId } }),
    retry: false, // next sync_changed event is a natural retry
  });
});
```

See [`STATE_MANAGEMENT.md` — Event-driven cache
updates](./STATE_MANAGEMENT.md#event-driven-cache-updates) for the
full decision table on hooks vs `fetchQuery`.

### Imperative subscriber inside a store bootstrap

```ts
import { subscribe } from "@/lib/event-bus";

export function setupMyStore(): () => void {
  const unsubResume = subscribe("app.resume", () => {
    refetchIfStale();
  });
  return () => {
    unsubResume();
    // ...other teardown.
  };
}
```

## Don't do this

- **Don't call `sseService.attach()` outside `hooks/use-event-bus-init.ts`.** Every other consumer subscribes to `bus.sse.event`. A second SSE handle from the same `clientId` will evict the first on the daemon.
- **Don't register `document.addEventListener("visibilitychange", ...)`** in a component or store for data-refresh purposes. The bus's `app.resume` signal and TQ's `focusManager` (configured in `lib/query-focus-manager.ts`) handle it. The only legitimate `visibilitychange` registration in the app is `runtime/event-sources/dom-visibility.ts`.
- **Don't manually `invalidateQueries` inside an `app.resume` handler** for generic cache refresh. TQ's `focusManager` already re-fetches stale queries automatically. Only subscribe to `app.resume` for domain-specific side effects (e.g. computing `timeAwaySeconds`).
- **Don't register `window.online` / `window.offline` listeners** in a component or store. Subscribe to `bus.app.online` / `bus.app.offline`.
- **Don't add polling intervals to discover state the daemon could push.** If the daemon already knows when something resolves, emit a typed event over `/v1/events` and subscribe to it via the bus.
- **Don't reach for the handler registry directly.** The bus exports `publish` / `subscribe` / `__resetForTesting`. The internal `Map` is module-private — there's no reactive surface to subscribe to (and that's the point; see [STATE_MANAGEMENT.md](./STATE_MANAGEMENT.md#when-zustand-does-not-apply-stateless-registries)).

## Testing

`lib/event-bus.test.ts` covers the pub/sub surface (subscribe,
unsubscribe, publish, isolation between event names, throwing-handler
robustness). `assistant/sse-service.test.ts` covers SSE behavior:
open gating, event re-broadcast, `sse.opened` cause tagging, teardown
on `app.hidden`, reopen on `app.resume`, the dedup window, and the
power-driven bounce paths. `use-event-bus-init.test.tsx` asserts the
thin React-adapter contract (don't attach without a resolved id /
without an active assistant). Each `runtime/event-sources/*` file
has a colocated unit test exercising its publish contract via
`spyOn(eventBus, "publish")` on the module namespace.

`__resetForTesting()` is exported from `lib/event-bus.ts` for use in
`beforeEach` / `afterEach`. Don't import it from production code.

## References

- [`STATE_MANAGEMENT.md`](./STATE_MANAGEMENT.md#when-zustand-does-not-apply-stateless-registries)
  — why the bus is a plain pub/sub module, not a Zustand store.
- [`CAPACITOR.md`](./CAPACITOR.md) — Capacitor `App.appStateChange`
  feeds the bus's `app.resume` / `app.hidden` channels on iOS.
