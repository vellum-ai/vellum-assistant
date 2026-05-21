# Capacitor / iOS Conventions

The web app ships as both a browser SPA and the JS layer of a [Capacitor](https://capacitorjs.com/) iOS shell that loads it in a `WKWebView`. The patterns below are mandatory for any code path that might run inside Capacitor iOS — most of them address real iOS-specific failure modes that desktop browsers silently tolerate.

> **Read this only if your change touches iOS code paths.** For browser-only contributions you can skip this document. Building the iOS app itself additionally requires macOS and Xcode; the native shell lives in [`apps/ios/`](../../../apps/ios/).

If you're touching anything in `apps/web/src/runtime/`, anything that calls a `@capacitor/*` plugin, anything that streams from the daemon, anything that auto-resizes based on content, or anything that gates a browser API that triggers an OS permission alert — start here.

---

## Capacitor plugins must be destructured inline (lazy-import rule)

Capacitor plugins (`@capacitor/<name>`, `@capacitor-community/<name>`) are not plain JS objects — they are `Proxy` objects whose `get` trap returns a callable method wrapper for **any** property name not in a tiny allowlist (`$$typeof`, `toJSON`, `addListener`, `removeListener`). That includes `.then` — so any context that triggers JS's [Promise thenable adoption](https://tc39.es/ecma262/#sec-promiseresolvethenablejob) on the plugin (most commonly: returning the plugin from an `async` function) will silently dispatch a `then()` method call to the native plugin, throw `"<Plugin>.then() is not implemented on <platform>"`, and **hang the outer `await` forever** because `then()` never calls `resolve` or `reject`. The `try/catch` around the `await` cannot reach it.

**Always destructure the plugin inline at the call site.** Never expose a plugin Proxy through an `async` return or any other Promise-resolution context.

```ts
// Good — Proxy never crosses an async return.
const { PushNotifications } = await import("@capacitor/push-notifications");
const { Haptics, ImpactStyle }  = await import("@capacitor/haptics");
const { Browser }               = await import("@capacitor/browser");
```

```ts
// Bad — returns the Proxy from an async function. Hangs on iOS/Android.
async function getPushPlugin() {
  const mod = await import("@capacitor/push-notifications");
  return mod.PushNotifications;
}
```

If you genuinely need to pass a plugin around, wrap it in a non-thenable container (`{ plugin }`) so `Promise.resolve` doesn't see a `.then` on the value it inspects.

References:
- `@capacitor/core` proxy `get` trap — [`global.ts` in `ionic-team/capacitor`](https://github.com/ionic-team/capacitor/blob/main/core/src/global.ts) (search `createPluginMethod`).
- ECMAScript spec — [`PromiseResolveThenableJob`](https://tc39.es/ecma262/#sec-promiseresolvethenablejob) (the runtime hook this footgun rides on).

---

## Native auth on iOS

Native auth uses [`ASWebAuthenticationSession`](https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession) (Safari sheet) via a `NativeAuth` Capacitor plugin — see [`src/runtime/native-auth.ts`](../src/runtime/native-auth.ts) and the Swift side at [`apps/ios/App/App/NativeAuthPlugin.swift`](../../../apps/ios/App/App/NativeAuthPlugin.swift).

- **Protected (app) routes**: route protection middleware (see [`CONVENTIONS.md` § Route protection via middleware](./CONVENTIONS.md#route-protection-via-middleware)) redirects unauthenticated users to `/account/login?returnTo=…`. Individual pages should **not** render inline sign-in gates. Return `null` when `!isLoggedIn` and let the middleware handle the redirect. The branded login page (`/account/login`) renders a native login form (inside [`NativeSplash`](../src/components/native-splash.tsx)) on Capacitor iOS and a web login form on web.
- **iOS login — no `providerHint`**: the iOS login form must use a single "Sign in" button with **no `providerHint`**. Do NOT add individual provider buttons or pass `providerHint` from the iOS login screen — see [Apple App Store Review Guideline 4](https://developer.apple.com/app-store/review/guidelines/#design) and [Guideline 4.8 — Sign in with Apple](https://developer.apple.com/app-store/review/guidelines/#login-services). The `providerHint` / `loginHint` parameters remain in the helper API for web and other use cases but must not be used from the iOS login entry point.
- **Pre-fill identity-derived inputs from the auth claim**: when the platform / IdP returns identity claims on signup (Apple SIWA `given_name`/`family_name`, Google `given_name`/`family_name`, etc.), pre-fill any user-facing input that asks for that identity (e.g. "Your name") from the claim instead of forcing the user to retype it — [Apple Guideline 4](https://developer.apple.com/app-store/review/guidelines/#design) and [Apple HIG: Sign in with Apple](https://developer.apple.com/design/human-interface-guidelines/sign-in-with-apple) treat asking again as a violation. The field stays editable so users can pick a preferred nickname.
- **Sign-in actions outside the app shell**: wrap sign-in links in a shared component that renders a native `startAuthFlow()` button on Capacitor iOS and a router `<Link>` on web — never a plain `<a href="/account/login">`, which on iOS would navigate the WKWebView away from the running SPA.
- **Platform detection in JSX**: use a `useIsNativePlatform()` hook (which returns `false` during the first paint and settles to the real value on mount) — not the bare `isNativePlatform()` function — to avoid render flicker and hydration mismatches in any SSR/prerender path. If the hook doesn't exist yet at the call site, add it next to [`src/runtime/native-auth.ts`](../src/runtime/native-auth.ts).

### Platform short-circuits in capability detection

When a capability-detection helper (e.g. `isXSupported()`) or feature gate uses `isNativePlatform()` to short-circuit, leave an inline comment naming the underlying constraint, the conditions that would invalidate the check, and a link to the upstream source code or vendor documentation that proves the runtime is broken (not hearsay). Capacitor iOS is a remote-loaded WKWebView and supports the standard W3C media APIs that ship in Safari/WKWebView; UA/platform branching is appropriate only when an API is *present but broken* on a specific runtime, and that fact must be discoverable at the call site.

The general rule is to test the feature itself — see [MDN: Implementing feature detection](https://developer.mozilla.org/en-US/docs/Learn_web_development/Extensions/Testing/Feature_detection). Without a citation, prefer running the feature and letting failures surface through the API's own error channel.

### OS permission requests on iOS

Any UI that gates a browser API which triggers an OS permission alert (`getUserMedia`, `Notification.requestPermission`, geolocation, etc.) must, on Capacitor iOS, either:

- **skip rendering** so the API call fires directly into the system alert, OR
- **render with zero exit affordances** — no Cancel button, no auto-rendered close-X, no backdrop dismiss, no Escape key.

Apple's [HIG — Requesting permission](https://developer.apple.com/design/human-interface-guidelines/requesting-permission) and [App Store Review Guideline 5.1.1(iv)](https://developer.apple.com/app-store/review/guidelines/#5.1.1) require any pre-prompt screen to lead directly to the alert. Pair `isXSupported()` capability checks with `useIsNativePlatform()` for any pre-permission UI: capability detection alone is not sufficient.

### Keyboard-only affordances on touch devices

When the *only* way to act on a UI element is a hardware-keyboard gesture (e.g. `Tab` to accept an inline suggestion, `Cmd+Enter` to submit), gate its rendering on `!isPointerCoarse()` from [`@/utils/pointer`](../src/utils/pointer.ts). Touch soft keyboards on iOS and Android do not expose `Tab` or most modifier-key combinations, so the affordance is non-actionable on coarse-pointer devices and may also overflow narrow viewports if its layout depends on a paired keypress. To support touch as well, add a tap-equivalent (button, gesture) instead of suppressing.

Reference: [MDN: `(pointer)` media feature](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/pointer).

---

## Deep links (Capacitor `appUrlOpen`)

Native OAuth completion auto-dismisses `SFSafariViewController` by redirecting to a registered custom URL scheme (`vellum-assistant://`, `-dev`, `-staging`) and routing the URL via the `@capacitor/app` plugin's `appUrlOpen` listener. The router is mounted globally for the app routes; pure utilities and the typed `WindowEventMap` augmentation live in [`src/runtime/native-deep-link.ts`](../src/runtime/native-deep-link.ts).

- **Build deep links via `buildOAuthCompleteDeepLink()`.** Don't hand-construct URLs — the helper picks the right scheme per host (`getNativeUrlSchemeForHost`) and encodes the payload consistently.
- **Parse via `parseOAuthCompleteDeepLink()`.** It exact-matches the scheme against the apex allow-list, rejects look-alikes (e.g. `vellum-assistant-evil://`), requires the `oauth-complete` host, and enforces a non-empty `requestId`. Adding a new scheme means adding it to the allow-list — do not loosen the matcher to a `startsWith` check.
- **Consume via a typed window-event listener hook** that registers for the `"vellum:oauth-complete-deeplink"` event and cleans up on unmount.
- **Pair the deep-link listener with a `browserFinished` poll fallback** when the consumer must work on builds where the listener doesn't fire (e.g. iOS dispatch hiccups, user-cancel paths). Today's UX must remain the worst case in every failure mode.

References:
- Apple — [`SFSafariViewControllerDelegate.safariViewController(_:initialLoadDidRedirectTo:)`](https://developer.apple.com/documentation/safariservices/sfsafariviewcontrollerdelegate/safariviewcontroller(_:initialloaddidredirectto:)) — custom URL scheme dismissal is the recommended pattern.
- Capacitor — [`App` plugin · `appUrlOpen`](https://capacitorjs.com/docs/apis/app#addlistenerappurlopen).
- Apple HIG — [Supporting universal links and custom URL schemes](https://developer.apple.com/documentation/xcode/allowing-apps-and-websites-to-link-to-your-content).

---

## No JS height sync for auto-growing textareas

Do not use JavaScript (`scrollHeight`, `offsetHeight`, `el.style.height = …`) to auto-resize `<textarea>` elements. iOS `WKWebView` re-dispatches native `input` events when it detects DOM geometry changes during input processing. In a controlled React component, JS height sync triggers `setState` → re-render → DOM mutation → re-fire, cascading until React hits its 50-update depth limit and throws `Maximum update depth exceeded`. Desktop browsers tolerate this pattern; iOS does not.

**Use the CSS Grid hidden-mirror technique instead.** Place an invisible `<div>` that mirrors the textarea content in the same CSS Grid cell. The grid auto-sizes to `max(mirror_height, textarea_intrinsic_height)`, and the textarea stretches to fill the cell — no JS measurement or DOM mutation needed. The chat composer is the canonical implementation in this repo.

Once browser support is broad enough across your target matrix, CSS [`field-sizing: content`](https://developer.mozilla.org/docs/Web/CSS/field-sizing) is an even simpler alternative that eliminates the mirror div entirely — check the MDN compatibility table before adopting since iOS Safari support is recent.

References:
- CSS-Tricks — [The Cleanest Trick for Autogrowing Textareas](https://css-tricks.com/the-cleanest-trick-for-autogrowing-textareas/)
- React Native — [#46850 (same bug class on iOS)](https://github.com/facebook/react-native/issues/46850)
- MUI — [#40557 (textarea height sync infinite re-renders)](https://github.com/mui/material-ui/issues/40557)
- MDN — [`field-sizing`](https://developer.mozilla.org/docs/Web/CSS/field-sizing)

---

## Long-lived streaming consumers need a client-side idle watchdog

`WKWebView` on Capacitor iOS can hold a streaming `fetch` open at the network layer with no bytes flowing and no error surfaced to JavaScript, so the for-await loop blocks indefinitely and any reconnect/reconcile path gated on a fetch error never runs. Server heartbeats alone are not a liveness signal unless the client checks them.

**Pair every long-lived stream (SSE, chunked fetch, WebSocket-equivalents) with a timer that resets on every received byte — including SSE comment frames, which most SDKs expose through `onSseEvent` even when they don't yield through the iterator — and force-reconnects after a bounded window of silence.** See `subscribeChatEvents` in the chat domain for the canonical pattern.

References:
- MDN — [Using server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)
- WHATWG SSE spec — [comments and dispatch](https://html.spec.whatwg.org/multipage/server-sent-events.html#dispatchMessage)
- MDN — [`AbortController`](https://developer.mozilla.org/en-US/docs/Web/API/AbortController)

---

## See also

- [`CONVENTIONS.md`](./CONVENTIONS.md) — architecture, code organization, component patterns.
- [`STATE_MANAGEMENT.md`](./STATE_MANAGEMENT.md) — Zustand stores, atomic selectors, TanStack Query.
- [`STYLE_GUIDE.md`](./STYLE_GUIDE.md) — naming, imports, TypeScript, component authoring.
- [`apps/ios/README.md`](../../../apps/ios/README.md) — Capacitor iOS shell setup, Xcode targets, release pipeline.
