# Capacitor / Native Conventions

The web app ships as both a browser SPA and the JS layer of [Capacitor](https://capacitorjs.com/) iOS and Android shells that load it in native WebViews. The patterns below are mandatory for any code path that might run inside a Capacitor shell. Several sections call out iOS-specific failure modes that desktop browsers silently tolerate.

> **Read this only if your change touches native Capacitor code paths.** For browser-only contributions you can skip this document. The native shells live in [`clients/ios/`](../../../clients/ios/) and [`clients/android/`](../../../clients/android/).

If you're touching anything in `clients/web/src/runtime/`, anything that calls a `@capacitor/*` plugin, anything that streams from the daemon, anything that auto-resizes based on content, or anything that gates a browser API that triggers an OS permission alert — start here.

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

### Linking a plugin runs its native `load()`

Capacitor calls every linked plugin's `load()` at bridge init, before any JS imports it and whether or not `capacitor.config.ts` configures it. An iOS Capacitor plugin dependency is therefore never runtime-neutral, and "we only added the dependency, nothing imports it" says nothing about behavior.

**Before adding an iOS Capacitor plugin dependency, read its native `load()` and account for every side effect it has.** A plugin is not dependency-only until that read says so.

`@capacitor/keyboard` is the worked example. Its `load()`:

- Sets `hideFormAccessoryBar = YES` with no config gate (`Keyboard.m:187`). That is the mechanism that hides the input accessory bar (prev/next chevrons plus Done) above the iOS keyboard in this shell. The `setAccessoryBarVisible({ isVisible: false })` call in [`src/runtime/native-keyboard.ts`](../src/runtime/native-keyboard.ts) only states the same intent explicitly and pins it against an upstream default change.
- Removes `WKWebView`'s own keyboard-avoidance observers, unsubscribing the web view from the `UIKeyboardWillShow`, `UIKeyboardWillHide`, and keyboard frame-change notifications (`Keyboard.m:196-199`), and substitutes a web view frame resize the plugin drives itself. On show, that resize is deferred by the keyboard animation duration plus `0.2` seconds (`Keyboard.m:256-257`); on hide it runs at `delay:0.01` (`Keyboard.m:214`). So `visualViewport` learns the keyboard height well after the system animation has started.

[`useVisibleViewport`](../src/hooks/use-visible-viewport.ts) bridges that gap through [`subscribeNativeKeyboardHeight`](../src/runtime/native-keyboard.ts), which registers a `keyboardWillShow` plugin listener and so reports the keyboard height at the leading edge of the animation instead of after the deferred resize.

Register these through `Keyboard.addListener`, not the same-named `window` events the bridge also dispatches: `cap.createEvent` builds those with `document.createEvent('Events')` and copies each payload key straight onto the event object, so `event.detail` is always `undefined` and a `detail.keyboardHeight` read silently yields `0`.

---

## Native auth on iOS

Native auth uses [`ASWebAuthenticationSession`](https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession) (Safari sheet) via a `NativeAuth` Capacitor plugin — see [`src/runtime/native-auth.ts`](../src/runtime/native-auth.ts) and the Swift side at [`clients/ios/App/App/NativeAuthPlugin.swift`](../../../clients/ios/App/App/NativeAuthPlugin.swift).

- **Protected (app) routes**: route protection middleware (see [`CONVENTIONS.md` § Route protection via middleware](./CONVENTIONS.md#route-protection-via-middleware)) redirects unauthenticated users to `/account/login?returnTo=…`. Individual pages should **not** render inline sign-in gates. Return `null` when `!isLoggedIn` and let the middleware handle the redirect. The branded login page (`/account/login`) renders a native login form (inside [`NativeSplash`](../src/components/native-splash.tsx)) on Capacitor iOS and a web login form on web.
- **iOS login — single AuthKit button**: the iOS login form must use a single "Sign in" button that hands off to WorkOS AuthKit. Do NOT add individual provider buttons (Google/Apple/etc.) or otherwise pin the flow to a specific provider — see [Apple App Store Review Guideline 4](https://developer.apple.com/app-store/review/guidelines/#design) and [Guideline 4.8 — Sign in with Apple](https://developer.apple.com/app-store/review/guidelines/#login-services). AuthKit hosts the provider selection, so the app never names a provider itself.
- **Pre-fill identity-derived inputs from the auth claim**: when the platform / IdP returns identity claims on signup (Apple SIWA `given_name`/`family_name`, Google `given_name`/`family_name`, etc.), pre-fill any user-facing input that asks for that identity (e.g. "Your name") from the claim instead of forcing the user to retype it — [Apple Guideline 4](https://developer.apple.com/app-store/review/guidelines/#design) and [Apple HIG: Sign in with Apple](https://developer.apple.com/design/human-interface-guidelines/sign-in-with-apple) treat asking again as a violation. The field stays editable so users can pick a preferred nickname.
- **Auth failures carry a cause, never just "try again"**: a rejected auth flow reaches JS as a Capacitor error whose `code` is `AUTH_ERROR` and whose `data.authError` names why the platform refused the sign-in (`signup_closed`, `provider_signup`, `login_incomplete`, or allauth's own code on a 400). Both native shells classify the non-200 statuses the headless schema documents for `/_allauth/app/v1/auth/provider/token` (the exchange that runs *after* the auth sheet closes, and therefore the failure users report as "it errored the moment I signed in"). Map codes to catalog keys only in [`src/domains/account/native-auth-error.ts`](../src/domains/account/native-auth-error.ts), and route every auth-entry catch through its `nativeAuthErrorKey()` / `isUserCancelledAuthError()` helpers plus a `captureError()` tagged with `nativeAuthErrorDetail()`. Adding a new refusal means a code in both `WorkOSAuth.sessionExchangeErrorCode` implementations (Swift and Java) and an entry in that map; an unmapped code degrades to the generic message rather than breaking.
- **Sign-in actions outside the app shell**: wrap sign-in links in a shared component that renders a native `startAuthFlow()` button on Capacitor iOS and a router `<Link>` on web — never a plain `<a href="/account/login">`, which on iOS would navigate the WKWebView away from the running SPA.
- **Platform detection in JSX**: prefer the hook form (`useIsNativePlatform()`, `useIsNativeIOS()`) over the bare `isNativePlatform()` / `isNativeIOS()` functions. Capacitor injects `native-bridge.js` as a `WKUserScript` at `.atDocumentStart`, so the value is already correct on the first render and constant thereafter; there is no first-paint flicker to settle. The hook exists for render-safety, for consistency across the platform hooks, and so call sites stay correct if an SSR or prerender path is ever added. Inside effects and event handlers the bare function is fine. `useIsNativePlatform()` lives in [`src/runtime/native-auth.ts`](../src/runtime/native-auth.ts); the rest live in [`src/runtime/platform-detection.ts`](../src/runtime/platform-detection.ts), which is where new ones belong.

### Platform short-circuits in capability detection

When a capability-detection helper (e.g. `isXSupported()`) or feature gate uses `isNativePlatform()` to short-circuit, leave an inline comment naming the underlying constraint, the conditions that would invalidate the check, and a link to the upstream source code or vendor documentation that proves the runtime is broken (not hearsay). Capacitor iOS is a remote-loaded WKWebView and supports the standard W3C media APIs that ship in Safari/WKWebView; UA/platform branching is appropriate only when an API is *present but broken* on a specific runtime, and that fact must be discoverable at the call site.

The general rule is to test the feature itself — see [MDN: Implementing feature detection](https://developer.mozilla.org/en-US/docs/Learn_web_development/Extensions/Testing/Feature_detection). Without a citation, prefer running the feature and letting failures surface through the API's own error channel.

### OS permission requests on iOS

Any UI that gates a browser API which triggers an OS permission alert (`getUserMedia`, `Notification.requestPermission`, geolocation, etc.) must, on Capacitor iOS, either:

- **skip rendering** so the API call fires directly into the system alert, OR
- **render with zero exit affordances** — no Cancel button, no auto-rendered close-X, no backdrop dismiss, no Escape key.

Apple's [HIG — Requesting permission](https://developer.apple.com/design/human-interface-guidelines/requesting-permission) and [App Store Review Guideline 5.1.1(iv)](https://developer.apple.com/app-store/review/guidelines/#5.1.1) require any pre-prompt screen to lead directly to the alert. Pair `isXSupported()` capability checks with `useIsNativePlatform()` for any pre-permission UI: capability detection alone is not sufficient.

### Keyboard-only affordances on touch devices

Which signal to reach for (viewport size vs pointer capability vs native platform) and where the branch belongs is covered in [`PLATFORM_ADAPTATION.md`](./PLATFORM_ADAPTATION.md).

When the *only* way to act on a UI element is a hardware-keyboard gesture (e.g. `Tab` to accept an inline suggestion, `Cmd+Enter` to submit), gate its rendering on the coarse-pointer signal from [`@/utils/pointer`](../src/utils/pointer.ts). Touch soft keyboards on iOS and Android do not expose `Tab` or most modifier-key combinations, so the affordance is non-actionable on coarse-pointer devices and may also overflow narrow viewports if its layout depends on a paired keypress. To support touch as well, add a tap-equivalent (button, gesture) instead of suppressing.

Which of the two forms depends on whether the answer has to survive the pointer changing. **A gate on rendering wants `!usePointerCoarse()`**, the subscribed hook: the affordance is on screen while a convertible's keyboard comes off or a tablet is docked into one, and a one-shot read would leave it advertising a chord the device can no longer press (or hiding one it now can). Reserve the imperative `isPointerCoarse()` for a decision taken at a moment rather than held on screen: inside an event handler, or seeding state that deliberately should not move mid-session.

Reference: [MDN: `(pointer)` media feature](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/pointer).

---

## Click events require interactive elements on iOS

iOS Safari/WKWebView does not fire `click` events from elements it does not consider "clickable" — plain `<div>`, `<span>`, or other non-interactive elements will receive `pointerdown`/`touchstart` but the synthesized `click` event will not fire or bubble to `document`. An element is "clickable" if it has any of: an `onclick`/`onClick` handler, `cursor: pointer`, `tabindex`, or is a natively interactive element (`<a>`, `<button>`, `<input>`, etc.).

This matters for any library that defers touch-initiated logic to a `click` event listener on the document (e.g. Radix UI's `DismissableLayer` uses this pattern for dismiss-on-tap-outside). If the tap target is a non-interactive overlay `<div>`, the deferred `click` never fires on iOS and the interaction silently fails.

**When adding overlay or backdrop elements that need to respond to taps, always attach an explicit `onClick` handler or use a `<button>`.** Do not rely on document-level `click` listeners reaching non-interactive elements on iOS.

References:
- Apple — [Handling Events in Safari on iOS](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/HandlingEvents/HandlingEvents.html)
- Radix — [`DismissableLayer` source (`usePointerDownOutside`)](https://github.com/radix-ui/primitives/blob/main/packages/react/dismissable-layer/src/dismissable-layer.tsx)

---

## Cancelling `pointerdown` also cancels the tap's `click` on iOS

A tap on iOS Safari/WKWebView produces `pointerdown`, `touchstart`, `pointerup`, `touchend`, then the compatibility `mousedown`, `mouseup`, and `click`. Calling `preventDefault()` on `pointerdown` suppresses **the entire remainder of that sequence, `click` included**. The Pointer Events spec says `click` should still be dispatched, and Chromium does dispatch it, so this is a WebKit-only divergence that a desktop or Android check will not catch.

The practical case is holding focus on an input while a button is pressed, which needs the focus transfer suppressed without losing the activation. The focus transfer rides on the compatibility `mousedown`, so cancel that one:

```tsx
// Keeps the textarea focused; the button's click still fires.
<button onMouseDown={(event) => event.preventDefault()} />
```

Cancelling `touchstart` has the same fatal effect as cancelling `pointerdown`. Reach for `pointerdown` only when you actually want to swallow the whole gesture, and remember that Radix menus (`DropdownMenu`, `Select`, `ContextMenu`) open **on `pointerdown`**, so cancelling it there makes the trigger inert; Radix `Dialog` and `BottomSheet` triggers open on `click` and are the ones this section is about.

References:
- W3C: [Pointer Events, compatibility mouse events](https://www.w3.org/TR/pointerevents/#compatibility-mapping-with-mouse-events)
- MDN: [`preventDefault()` on pointer events](https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events)

---

## Programmatic text selection requires frame deferral on iOS

iOS Safari/WKWebView ignores `HTMLInputElement.select()` and `setSelectionRange()` when called synchronously during `focus()` — the editing context (keyboard, selection system) isn't initialized until the next animation frame. This affects any code that programmatically focuses an input and immediately tries to select its content.

**Always defer selection to the next frame after focus:**

```ts
input.focus();
requestAnimationFrame(() => {
  input.setSelectionRange(0, input.value.length);
});
```

Prefer `setSelectionRange(start, end)` over `select()` — it's more explicit about the selection range and behaves consistently across browsers. The single-frame delay is imperceptible on all platforms.

This commonly arises with Radix Dialog's `onOpenAutoFocus`, which fires synchronously when the dialog content mounts. Desktop browsers tolerate synchronous focus + select, so the issue only surfaces on iOS.

References:
- WebKit — [Bug 224425: `select()` does not work in programmatically focused input](https://bugs.webkit.org/show_bug.cgi?id=224425)
- MDN — [`HTMLInputElement.setSelectionRange()`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLInputElement/setSelectionRange)
- MDN — [`requestAnimationFrame()`](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame)

---

## Deep links (Capacitor `appUrlOpen`)

Native OAuth completion auto-dismisses `SFSafariViewController` by redirecting to a registered custom URL scheme (`vellum-assistant://`, `-dev`, `-staging`) and routing the URL via the `@capacitor/app` plugin's `appUrlOpen` listener. The router is mounted globally for the app routes; pure utilities and the typed `WindowEventMap` augmentation live in [`src/runtime/native-deep-link.ts`](../src/runtime/native-deep-link.ts).

- **Build deep links via `buildOAuthCompleteDeepLink()`.** Don't hand-construct URLs — the helper picks the right scheme per host (`getNativeUrlSchemeForHost`) and encodes the payload consistently.
- **Parse via `parseOAuthCompleteDeepLink()`.** It exact-matches the scheme against the apex allow-list, rejects look-alikes (e.g. `vellum-assistant-evil://`), requires the `oauth-complete` host, and enforces a non-empty `requestId`. Adding a new scheme means adding it to the allow-list — do not loosen the matcher to a `startsWith` check.
- **Consume via a typed window-event listener hook** that registers for the `"vellum:oauth-complete-deeplink"` event and cleans up on unmount.
- **Pair the deep-link listener with a `browserFinished` poll fallback** when the consumer must work on builds where the listener doesn't fire (e.g. iOS dispatch hiccups, user-cancel paths). Today's UX must remain the worst case in every failure mode.
- **Read `App.getLaunchUrl()` only on Android.** The iOS `AppDelegate` replays cold-launch URLs through `appUrlOpen`, while Capacitor retains its last iOS URL for the process. Reading it again would duplicate the deep link.
- **`<scheme>://voice?mode=new|resume[&prompt=…]`** is the start-voice contract (`parseStartVoiceDeepLink` → `deeplink.startVoice`). Siri, the Action Button, Control Center, the Live Activity's `widgetURL`, and a link typed into Safari all converge on it — see [`clients/ios/docs/NATIVE_VOICE.md` § The deep-link contract](../../../clients/ios/docs/NATIVE_VOICE.md#the-deep-link-contract). `prompt` is untrusted free-form text and is bounded and sanitized *in the parser*, not at the consumer.
- **`<scheme>://camera` and `<scheme>://new-chat`** are the Home Screen widgets' command contracts (`parseOpenCameraDeepLink` → `deeplink.openCamera`, `parseNewChatDeepLink` → `deeplink.newChat`). Neither takes a parameter: the host is the whole request, so a URL carrying a path is rejected, while extra query items are ignored rather than rejected, so a producer that grows one later degrades to the plain command on an older bundle. The camera command parks in `usePendingDeepLinkStore` and is drained by the composer's attachment layer (`useCameraDeepLink`), which owns the 60s age bound and spends the request unopened while a live-voice call holds the camera layer.
- **A deep link cannot open a file input.** WKWebView presents an `<input type="file">` picker only for a click carrying transient DOM user activation, and a URL drained from `appUrlOpen` establishes none, because the gesture happened outside the web view. A `.click()` from the draining effect is consumed in silence. Any command that has to raise a camera or a file picker must therefore go through a plugin bridge, which has no such requirement: `deeplink.openCamera` raises `CameraCaptureOverlay`, an in-app viewfinder over the `@capacitor-community/camera-preview` layer, and falls back to `getUserMedia` on a shell that does not register the plugin.

References:
- Apple — [`SFSafariViewControllerDelegate.safariViewController(_:initialLoadDidRedirectTo:)`](https://developer.apple.com/documentation/safariservices/sfsafariviewcontrollerdelegate/safariviewcontroller(_:initialloaddidredirectto:)) — custom URL scheme dismissal is the recommended pattern.
- Capacitor — [`App` plugin · `appUrlOpen`](https://capacitorjs.com/docs/apis/app#addlistenerappurlopen).
- Apple HIG — [Supporting universal links and custom URL schemes](https://developer.apple.com/documentation/xcode/allowing-apps-and-websites-to-link-to-your-content).

---

## Native voice bridge

Live voice is a web feature with native accessories. The session, including mic capture, the velay socket, TTS playback, and every user-facing string, lives under `src/domains/chat/voice/live-voice/`. iOS adds interruption reporting, a Dynamic Island and Lock Screen presence, and App Intents. Android adds foreground audio focus, a microphone foreground service, and an ongoing status notification. The voice-room camera is the capture exception: native mobile shells use `@capacitor-community/camera-preview`, while browsers and older shells use a web `MediaStream` fallback.

The shell registers **eight app-local** Capacitor plugins in [`MyViewController.capacitorDidLoad()`](../../../clients/ios/App/App/MyViewController.swift) (count them there, not from prose). `CameraPreview` is an external SPM/Gradle dependency that Capacitor discovers automatically, so it is not registered in that method.

| Plugin | Web module | What it does |
| --- | --- | --- |
| `NativeAuth` | [`src/runtime/native-auth.ts`](../src/runtime/native-auth.ts) | `ASWebAuthenticationSession` OIDC flow |
| `NativeBiometric` | [`src/runtime/native-biometric.ts`](../src/runtime/native-biometric.ts) | Face ID / Touch ID Keychain |
| `VoiceAudioSession` | [`src/runtime/native-audio-session.ts`](../src/runtime/native-audio-session.ts) | iOS interruption events and Android audio-focus and microphone-service lifecycle. See the background-audio contract below |
| `VoiceLiveActivity` | [`src/runtime/native-live-activity.ts`](../src/runtime/native-live-activity.ts) | One ActivityKit activity on iOS or ongoing notification on Android |
| `ApnsEnvironment` | [`src/runtime/apns-environment.ts`](../src/runtime/apns-environment.ts) | The build's real APNs entitlement environment (`development` / `production` / `unknown`), read from the embedded provisioning profile |
| `SelfHostedServers` | [`src/runtime/self-hosted-servers.ts`](../src/runtime/self-hosted-servers.ts) | List, add, remove, and switch between self-hosted server origins; `switchTo` swaps the shell's configured origin and reloads without leaving the app. See the section below |
| `RecentChats` | [`src/runtime/recent-chats.ts`](../src/runtime/recent-chats.ts) | Mirrors the sidebar conversation list (ids + titles) into a UserDefaults cache that backs the Shortcuts app's chat picker (`ChatEntityQuery`); synced from `ChatLayout` once the list query has resolved |
| `WidgetSnapshot` | [`src/runtime/widget-snapshot.ts`](../src/runtime/widget-snapshot.ts) | Mirrors a conversation summary (unread and in-progress counts plus the three most recent threads) into App Group UserDefaults for the Home Screen widgets, reloading their timelines after each write. `sync` replaces the whole snapshot; `clear` drops it, so a signed-out account's titles do not outlive the session on a surface that renders without unlocking the app |

The two voice plugins are consumed only through `use-live-voice-session-controller.ts` (audio session) and `use-live-activity-mirror.ts` (Live Activity), both mounted at `ChatLayout` scope so their lifetime is exactly the session's.

### The skew rule

**A native voice call may always be absent. A missing plugin must degrade to a working voice session, never to an error.**

This is a rule, not a caveat. The iOS app is a `server.url` shell: it bundles no web assets and navigates `WKWebView` straight at the deployed origin at launch (see [`clients/ios/README.md` § Web content delivery](../../../clients/ios/README.md#web-content-delivery)). So this bundle is live for every iOS user on their next app load, while the shell hosting it only changes after an App Store review cycle. At any moment an arbitrarily old shell can be running an arbitrarily new bundle. There is no build flag that tells you which.

**Route every JS to native voice call through `callNativeVoice`** ([`src/runtime/native-voice.ts`](../src/runtime/native-voice.ts)). It short-circuits outside the native mobile shells, swallows any bridge failure into the caller's fallback, and never throws or rejects.

Three things follow from the rule:

- **Pick a fallback the caller can proceed with.** `startVoiceLiveActivity()` resolves `false`, `endVoiceLiveActivity()` resolves `undefined`. There is no error branch to write, and no call site may treat a `false` as a reason not to start a session.
- **Fire and forget at the call site.** A bare `void` is enough: because every export in these modules goes through `callNativeVoice`, none of them can reject, so there is no rejection for a call site to handle. A hung or failed bridge call must never delay a voice session.
- **Destructure the plugin inline inside `invoke`.** The lazy-import rule at the top of this document applies verbatim: only the *result* may cross the `async` boundary, never the plugin Proxy.

**No capability probes.** Neither voice plugin exposes an `isAvailable`, and neither web module wants one: `startVoiceLiveActivity()` resolving `false` already covers every reason there is no native side: outside a native mobile shell, an older shell, or a disabled platform status surface. A probe that can itself be absent just moves the problem, and it is the only answer a caller could act on anyway.

### Native voice-room camera

[`native-voice-camera.ts`](../src/runtime/native-voice-camera.ts) is the only web module that calls `CameraPreview`. The mobile preview is a native camera layer behind the Capacitor web view, not an HTML media element. Opening it makes the web canvas transparent and keeps the voice-room controls visible in front; closing it restores the active theme through the iOS `--surface-overlay` bridge. The dependency is patched so its cleanup does not force an opaque or white web view over the app's own theme.

The camera call has one hard audio rule: `disableAudio: true` is mandatory. Live voice already owns microphone capture, and the viewfinder must not add an audio input or reconfigure the session underneath it. `enableHighResolution: true` requests the iOS high-resolution photo path, `toBack: true` keeps the HTML controls above the preview, and `storeToFile: false` returns captured JPEG bytes directly to the existing attachment pipeline.

Camera permission is declared in both shells: `NSCameraUsageDescription` on iOS and `android.permission.CAMERA` on Android. Android marks camera hardware optional so devices without a camera remain installable and fail through the existing no-device path.

The skew rule applies to every camera call through `callNativeVoice`. `startNativeVoiceCamera()` resolving `false` is the availability result. Do not add a separate probe. When the plugin is missing from an older installed shell, `voice-camera.ts` falls through to video-only `getUserMedia` with ideal 1920 by 1080 constraints and logs the negotiated non-identifying track settings. Desktop web and Electron use that same fallback. The native path renders no `<video>`, so it has no browser playback state or media-element play affordance.

The iOS Simulator does not provide a real camera feed. A native build verifies linking and compilation, but preview sharpness, camera switching, tap focus, audio continuity, and the permission path require a physical handset.

### The background-audio contract

**Read § "Full-duplex TTS must render through a MediaStream track" before you touch the iOS implementation.** That section warns against reconfiguring the shared `AVAudioSession` around microphone capture. The iOS `activate` method has no production caller by the decision recorded below. Android's `useNativeAudioSessionLifecycle` caller uses the same bridge method to request audio focus and start a microphone foreground service, without reconfiguring WebView capture.

That history is the reason this is device-only territory. A change here that looks obviously correct and passes in the Simulator is precisely the failure mode that has now shipped twice.

**Echo cancellation does not depend on this.** It used to be the argument for `.voiceChat`; since #39347 it comes from WebKit's own voice-processing unit, reached by routing TTS through a `MediaStreamAudioDestinationNode`. So if this plugin ever has to go, AEC does not go with it.

**The iOS rule: the web layer does not activate an audio session.** Settled the hard way, because the pattern broke live voice on a handset twice. First as #39331 (no capture at all, reverted in #39345), then again when it returned in #39306, where a session died roughly 60ms after its WebSocket opened while the Simulator sustained one normally against the same backend. The second failure went unattributed for a day because every #39306 upload was rejected by App Store Connect until #39556, so the plugin had never actually run on a device. `useNativeAudioSessionLifecycle` subscribes to iOS interruptions but never calls iOS `activate`. Do not reintroduce iOS activation without a device test, and note that a green Simulator run is not one.

Android's `useNativeAudioSessionLifecycle` calls `activateVoiceAudioSession()`
after WebView microphone capture succeeds. The native plugin requests transient
audio focus and starts a microphone foreground service while the app is still
visible. Capture, playback, and the voice socket stay in the WebView, while the
service keeps that process active across screen locks and app switches. The
service stays active through voice reconnects, stops with audio focus when the
session ends, and is released before a new top-level page load replaces the web
session.

The iOS `VoiceAudioSession` plugin stays in the shell: its interruption reporting listens to `AVAudioSession.sharedInstance()`, so it still hears a phone call or Siri taking the input from WebKit's session, which is unrelated to owning a session ourselves.

What is genuinely still open on iOS is **background audio**. The list below describes what an active iOS session *would* buy. None of it is in effect today because iOS never activates one. `UIBackgroundModes: audio` in `clients/ios/App/App/Info.plist`, plus an active `.playAndRecord` / `.voiceChat` session, would buy:

- audio keeps playing while the app is backgrounded or the screen is locked;
- the mic route survives backgrounding;
- output goes to the loudspeaker rather than the earpiece (`.defaultToSpeaker`);
- AirPods / Bluetooth-HFP routing (`.voiceChat`);
- other apps' audio resumes on `deactivate` (`.notifyOthersOnDeactivation`).

It does **not** buy a running web layer. WebKit throttles and eventually suspends JS timers and main-thread work in a backgrounded web process. The AudioWorklet runs on the audio render thread, but the socket send happens on the main JS thread — so "audio is allowed in the background" and "this voice session keeps working in the background" are different claims.

**Both claims are unverified, and the first one may not even need this plugin.** WebKit already holds a play-and-record session with voice processing for `getUserMedia`, so a locked session may survive on `UIBackgroundModes: audio` alone. Worth measuring before assuming the plugin is what is carrying it — if it is not, the safest version of this feature is the one that deletes the plugin and keeps the plist entry. The device spike that was meant to answer any of this — does `getUserMedia` keep producing PCM, does the velay socket keep pumping, and for how long — was never run, and there is no findings document. The background/foreground hardening planned on top of it (`AudioContext.resume()` on `app.resume`, a socket-liveness probe, a bounded background grace period) was never implemented.

**The Simulator cannot answer any of it.** It exposes a mock audio device — no mic, no speaker, no acoustic path — so it neither reproduces the capture regression nor exercises background audio. Every Simulator run passed while the device was dead in #39331. Measure on a physical handset or do not claim it.

For the native side of all of this — the enum-parity rule, the deep-link contract, the App Intents availability duplication, the extension compilation condition, and the v1 scope decisions — see [`clients/ios/docs/NATIVE_VOICE.md`](../../../clients/ios/docs/NATIVE_VOICE.md).

References:
- Apple — [Playing audio in the background](https://developer.apple.com/documentation/avfaudio/audio_session/enabling_background_audio).
- Apple — [`AVAudioSession.Mode.voiceChat`](https://developer.apple.com/documentation/avfaudio/avaudiosession/mode/voicechat).
- Apple — [ActivityKit](https://developer.apple.com/documentation/activitykit).

---

## Self-hosted origins (`SelfHostedServers`)

The assistant chooser offers every origin this device knows about. On a native
mobile shell those origins live natively, not in web storage, because the shell
is the only thing that can point its web view somewhere else without leaving
the app, and because the same list is written by the `<scheme>://connect` deep
link (and, on iOS, the native Settings pane). The web side is
[`src/runtime/self-hosted-servers.ts`](../src/runtime/self-hosted-servers.ts);
the native side is
[`SelfHostedServersPlugin.swift`](../../../clients/ios/App/App/SelfHostedServersPlugin.swift)
over [`SelfHostedServer.swift`](../../../clients/ios/App/App/SelfHostedServer.swift)
on iOS, and
[`SelfHostedServersPlugin.java`](../../../clients/android/app/src/main/java/ai/vellum/assistant/SelfHostedServersPlugin.java)
over
[`SelfHostedServer.java`](../../../clients/android/app/src/main/java/ai/vellum/assistant/SelfHostedServer.java)
on Android.

The bridge contract:

| Method | Resolves | Notes |
| --- | --- | --- |
| `list()` | `{ servers: [{name?, url}], activeUrl, bakedUrl }` | `activeUrl` is the configured self-hosted slot (`null` means the shell serves its baked origin); `bakedUrl` is the Vellum Cloud origin the build ships with |
| `add({url, name?})` | `{ ok }` | Deduped by canonical url. A nameless re-add keeps the stored label |
| `remove({url})` | `{ ok }` | Forgetting the active url also clears the active slot, so the shell returns to the baked origin |
| `switchTo({url?})` | `{ ok }` | Swaps the active slot and reloads the shell onto it (see the per-surface list below). An absent or empty `url` returns to the baked origin |
| `switchToPath({url?, path})` | `{ ok }` | `switchTo` plus an initial in-app route loaded relative to the destination's app entry URL. A malformed `path` (empty, absolute, containing `://`, or carrying a fragment) rejects up front; a path that passes those checks but fails route building still switches and falls back to the app entry URL |

Only genuinely invalid caller input rejects (an `add`/`switchTo`/`switchToPath`
url that fails `SelfHostedServer.validate`, or a malformed `switchToPath`
path). Empty state resolves with an empty list and nulls, so there is no "not
configured" error branch to write.

Urls cross the bridge in one canonical form: `SelfHostedServer.canonicalize` and
the store's `normalizeOriginUrl` implement the same rules (lowercase scheme and
host, userinfo dropped, trailing slashes stripped, query and fragment dropped,
path and port preserved), so both sides agree on which strings mean the same
HTTPS server. Changing one means changing the others. The one divergence is
deliberate: the Android shell also accepts cleartext development hosts
(`http://localhost` and friends) that `normalizeOriginUrl` rejects, so those
entries live in the native list but never surface as chooser cards.

**Switching is per surface, and every surface has a working answer.**

- Browser: `switchToOrigin` navigates to the origin's SPA root. A remembered
  origin is a separate deployment, so this is a full navigation, not a route
  change.
- Electron: the same navigation, but it does not land in the app window. The
  main window's `will-navigate` guard
  ([`main-window.ts`](../../macos/src/main/main-window.ts)) sends any
  cross-origin https target to the system browser, so the origin opens there.
- Native mobile with the plugin: `nativeSwitchToOrigin` hands the url to the
  shell. iOS reloads the `WKWebView` in place; Android recreates the activity
  onto a rebuilt Capacitor config, so a brief relaunch flash is expected.
  Either way the user never leaves the app, and a "Vellum Cloud" card sourced
  from `list().bakedUrl` is the way back.
- Native mobile without the plugin: the same navigation the browser takes. That
  leaves the app for the system browser, which is degraded but is exactly what
  the pair-page path already does there.

**Storage follows the same fork.** The chooser calls
`installNativeRememberedOrigins()` from its flag-gated mount, which swaps the
remembered-origins store onto a plugin-backed provider on native mobile only.
The store persists a whole list while the plugin exposes per-entry `add` and
`remove`, so the provider's `save` diffs the desired list against `list()` and
issues the delta. A rejected write propagates, because the store treats a failed
save as a failed mutation and must not publish an entry the shell does not hold.

**The skew rule from the voice section applies verbatim.** The plugin may always
be absent, so every bridge call is wrapped: a failure logs `console.debug`
(never `captureError`, since an older App Store shell is an expected state on
every web deploy) and falls back to the behavior that shell already had, which
is the localStorage provider for storage and a plain navigation for switching.
`load()` in particular degrades to localStorage data rather than rejecting: the
store treats a rejected load as transient and would otherwise stay unhydrated
and retry forever.

**No availability probe.** There is no `isAvailable` and there must not be one:
a probe can itself be absent, and the failure of the call the caller wanted to
make is the same answer one turn earlier. `nativeSwitchToOrigin` resolving
`false` and `nativeVellumCloudOrigin` resolving `null` already cover every
reason there is no native side.

The module is a plain static import from both the chooser and
`switch-origin.ts`: the chooser needs it on mount to install the provider, and
`registerPlugin` only builds the bridge Proxy, so importing it reaches nothing
on any surface. Every method call sits behind `isNativeMobile()` or the
flag-gated install. The inline-destructure rule at the top of this document
applies to every call: only results cross an `async` boundary, never the plugin
Proxy.

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

**Pair every long-lived stream (SSE, chunked fetch, WebSocket-equivalents) with a timer that resets on every received byte (including SSE comment frames, which most SDKs expose through `onSseEvent` even when they don't yield through the iterator) and force-reconnects after a bounded window of silence.** The canonical pattern is [`src/lib/streaming/stream-watchdog.ts`](../src/lib/streaming/stream-watchdog.ts), armed per frame (comment frames included) by [`src/lib/streaming/stream-transport.ts`](../src/lib/streaming/stream-transport.ts).

References:
- MDN — [Using server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)
- WHATWG SSE spec — [comments and dispatch](https://html.spec.whatwg.org/multipage/server-sent-events.html#dispatchMessage)
- MDN — [`AbortController`](https://developer.mozilla.org/en-US/docs/Web/API/AbortController)

---

## Full-duplex TTS must render through a MediaStream track

WebKit owns the shared `AVAudioSession` used by `getUserMedia()` in a
`WKWebView`: it selects a play-and-record category and voice-processing mode,
and it creates a `VoiceProcessingIO` capture unit when echo cancellation is
requested. Do not add a Capacitor plugin that reconfigures or reactivates that
session around microphone capture. Changing the active session underneath
WebKit can leave its live capture unit detached from the microphone.

The iOS `VoiceAudioSession` plugin can perform that reconfiguration, but its
`activate` method has no production caller. Android requests audio focus and
starts its microphone foreground service, but it does not change the WebView
audio mode or capture path.

Direct `AudioContext.destination` playback is not supplied to WebKit's capture
unit as far-end audio for acoustic echo cancellation. On Capacitor iOS, route
full-duplex TTS into a `MediaStreamAudioDestinationNode` and play that stream
through an `HTMLAudioElement`. WebKit routes default-device MediaStream-track
playback through the same voice-processing unit and can use it as the echo
reference. `LiveVoiceAudioPlayer` is the canonical implementation.

Start the media element from the same user gesture that prewarms the
`AudioContext`, before awaiting readiness preflight or any other asynchronous
work. On teardown, pause it, clear `srcObject`, and stop every track owned by
the destination stream. Automatic reconnects must reuse the already-started
player and MediaStream element: creating a replacement from a backoff timer
loses the original user activation and can make `play()` fail.

**Re-render the track once the microphone is live.** WebKit binds a MediaStream
renderer to whichever capture unit is active when the renderer starts, and the
echo reference belongs to that unit. Starting the element in the entry gesture
is therefore necessary but not sufficient: at that moment `getUserMedia` has not
run, so the renderer can come up bound to a plain output unit and never acquire
a reference. `LiveVoiceAudioPlayer.restartOutputRoute()` pauses and replays the
element, and the session calls it once capture reports running. The queue is
silent at that point, so the restart is inaudible.

It also **rebuilds a route that has already fallen back**, which is what the
gesture-less entry points depend on. A session started from Siri, the Action
Button, or a Live Activity has no activation to borrow, so its prewarm `play()`
is refused and the fallback tears the route down; by capture time the page holds
a live `getUserMedia` stream, which is grounds for playing a MediaStream element
that an unactivated page could not. Treating a fallen-back route as nothing to
retry would strand exactly those sessions on the direct path for their whole
lifetime.

**The route degrades silently.** A refused `play()` falls back to
`AudioContext.destination`: audio still plays and echo cancellation is simply
gone, which surfaces only as the assistant transcribing fragments of its own
speech. `getOutputRouteDiagnostics()` reports the resolved route, the `play()`
rejection, and live element state. It exists so the fallback path is testable
(`tts-playback.test.ts`), and nothing in production consumes it.

**The live-voice path writes nothing to the diagnostics rings, deliberately.** A
voice session is the most private surface the app has, and the rings are carried
off the device inside support bundles. Anything derived from the microphone is
out of bounds outright: not only speech, but aggregates over it, such as an
amplitude envelope, a correlation, or a room noise floor. Those characterise a
user's home. This was instrumented once, in #39687, to prove the rebind above
engaged; it did, on device and on the web, and the instrumentation was removed
with the question it answered.

Console output is held to the same intent but is not yet the same rule. The
session's own logging is error-path `console.warn`s carrying codes and reasons,
never content. The one exception is a per-turn
`console.debug("[live-voice] turn latency", ...)` in `use-live-voice.ts`,
carrying a turn id and timings (added in #37710, awaiting a debug panel). It
predates this section and is listed here so the paragraph stays honest, not as a
precedent: new per-turn logging does not belong on this path.

If echo returns, that is a device-debugging session with a build that carries a
probe, not a reason to reinstate one in the shipped bundle. Prefer a temporary
branch over a permanent field, and delete it the same way.

References:

- WebKit — [`MediaSessionManagerCocoa` selects the capture audio-session category and mode](https://github.com/WebKit/WebKit/blob/41daa01748411a95855d8b6a0f0ffbd54f729a08/Source/WebCore/platform/audio/cocoa/MediaSessionManagerCocoa.mm#L174-L218)
- WebKit — [`CoreAudioCaptureUnit` selects `VoiceProcessingIO` for echo cancellation](https://github.com/WebKit/WebKit/blob/41daa01748411a95855d8b6a0f0ffbd54f729a08/Source/WebCore/platform/mediastream/cocoa/CoreAudioCaptureUnit.cpp#L75-L87)
- WebKit — [MediaStream-track playback is rendered through the active capture unit](https://github.com/WebKit/WebKit/blob/41daa01748411a95855d8b6a0f0ffbd54f729a08/Source/WebKit/GPUProcess/webrtc/RemoteAudioMediaStreamTrackRendererInternalUnitManager.cpp#L228-L292)

---

## Full-screen overlays must respect safe-area insets

Any element that takes over the full viewport (modals, detail panels, drawers) via `position: fixed; inset: 0` **must** apply safe-area padding so content does not render behind the iPhone status bar, Dynamic Island, or home indicator. The `ChatLayoutHeader` handles this for the persistent top bar, but overlays that cover the header lose its protection.

Use the CSS custom properties set by `capacitor-plugin-safe-area`:

```css
padding-top: var(--safe-area-inset-top, env(safe-area-inset-top, 0px));
padding-bottom: var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px));
```

The double fallback (`var()` → `env()` → `0px`) covers Capacitor iOS (plugin sets `--safe-area-inset-*`), standard browsers (`env()` from `viewport-fit=cover`), and desktop/non-notch devices (`0px`).

If the overlay includes its own nav bar, the nav bar itself should sit below the safe-area padding — don't push the inset down into child elements where it's easy to lose.

References:
- MDN — [`env()` safe area insets](https://developer.mozilla.org/en-US/docs/Web/CSS/env#safe_area_insets)
- Apple HIG — [Layout: Safe area](https://developer.apple.com/design/human-interface-guidelines/layout#Safe-area)

---

## iOS-only viewport constraints belong in native injection

`clients/web/index.html` serves both the Capacitor WKWebView shell and regular mobile browsers. **Do not add iOS-specific viewport properties** (e.g. `maximum-scale=1.0`, `user-scalable=no`) directly in the HTML — this disables pinch-zoom for all mobile-browser users, which is an accessibility regression.

Instead, inject iOS-only viewport constraints via a `WKUserScript` in [`MyViewController.swift`](../../../clients/ios/App/App/MyViewController.swift). The native injection runs only inside the Capacitor shell and doesn't affect other platforms.

When modifying the viewport meta tag, check whether the change affects zoom behaviour in the WKWebView shell — the [default `maximum-scale` is 5.0](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariHTMLRef/Articles/MetaTags.html), and Capacitor's built-in zoom prevention does not cover programmatic zoom changes (e.g. during device rotation).

References:
- Apple — [Configuring the Viewport](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/UsingtheViewport/UsingtheViewport.html)
- Apple — [Supported Meta Tags (`viewport`)](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariHTMLRef/Articles/MetaTags.html)

---

## See also

- [`CONVENTIONS.md`](./CONVENTIONS.md) — architecture, code organization, component patterns.
- [`STATE_MANAGEMENT.md`](./STATE_MANAGEMENT.md) — Zustand stores, atomic selectors, TanStack Query.
- [`STYLE_GUIDE.md`](./STYLE_GUIDE.md) — naming, imports, TypeScript, component authoring.
- [`clients/ios/README.md`](../../../clients/ios/README.md) — Capacitor iOS shell setup, Xcode targets, release pipeline.
- [`clients/ios/docs/NATIVE_VOICE.md`](../../../clients/ios/docs/NATIVE_VOICE.md) — the native voice surfaces: Live Activity, App Intents, the deep-link contract, and the v1 scope decisions.
