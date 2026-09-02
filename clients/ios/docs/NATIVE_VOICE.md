# Native voice mode

How a live-voice session — which runs entirely in the web layer — reaches the
Dynamic Island, the Lock Screen, Siri, Spotlight, the Action Button, and
Control Center.

Read [`clients/web/docs/CAPACITOR.md` § Native voice bridge](../../web/docs/CAPACITOR.md#native-voice-bridge)
first if you are touching the web half. That document owns the skew rule; this
one owns the native contracts.

---

## What is native and what is not

Nothing about the *conversation* is native. Mic capture (`getUserMedia` →
AudioWorklet → PCM), the velay WebSocket, TTS playback, turn state, and every
user-facing string all live under
`clients/web/src/domains/chat/voice/live-voice/`. The native side contributes
exactly four things:

| Native surface | What it is |
| --- | --- |
| `VoiceAudioSessionPlugin` | Owns `AVAudioSession` for the duration of a session (`.playAndRecord` / `.voiceChat`), and reports interruptions |
| `VoiceLiveActivityPlugin` | Requests, updates, and ends the one ActivityKit activity mirroring the session |
| `VoiceActivity` widget extension | Renders that activity on the Lock Screen and in the Dynamic Island, plus the two Control Center / Lock Screen controls (the voice one below, and the non-voice "Open Vellum" app launcher). The same bundle also hosts three non-voice Home Screen widgets, Catch Up, Status, and Quick Actions, which draw the shared App Group snapshot and carry a voice button of their own |
| App Intents + `AppShortcutsProvider` | Turn a Siri phrase, a Spotlight hit, an Action Button press, a control tap, or a widget button into a `<scheme>://voice` URL |

Everything native is *additive*. Remove all of it and voice still works — that
property is load-bearing, because the shell ships on App Store review cadence
while the web bundle it hosts deploys continuously.

## Architecture

One direction of data (web → native) and one of commands (native → web).

**State, web → island:**

```
live-voice-store.ts            zustand store; `state`, `muted`, `reconnecting`
        │  subscribeSettledLiveVoiceState (inside an effect, never a selector)
        ▼
use-live-activity-mirror.ts    diffs the ContentState fields, drops no-op pushes
        │  startVoiceLiveActivity / updateVoiceLiveActivity / endVoiceLiveActivity
        ▼
runtime/native-live-activity.ts   every call wrapped in callNativeVoice
        │  Capacitor bridge
        ▼
VoiceLiveActivityPlugin.swift  holds at most one Activity handle
        │  ActivityKit
        ▼
VoiceActivity.appex            VoiceSessionLiveActivity + VoiceSessionIslandViews
```

The mirror is mounted by `use-live-voice-session-controller.ts` (at `ChatLayout`
scope), so its lifetime is exactly the session's. It is a separate module from
the controller on purpose: the controller owns session lifecycle, the mirror owns
an optional platform flourish, and conflating them makes both harder to test.

**Commands, native → web:**

```
Siri phrase / Spotlight / Action Button   →  StartVoiceModeIntent
                                             StartNewVoiceConversationIntent
                                             AskVellumIntent
Control Center / Lock Screen control      →  StartNewVoiceConversationIntent
Home Screen widget voice button           →  StartNewVoiceConversationIntent
Dynamic Island / Lock Screen tap          →  .widgetURL(VoiceModeDeepLink.resume.url())
Safari, a test link, another app          →  application(_:open:) / launchOptions[.url]
        │                        all of them produce  <scheme>://voice?mode=…
        ▼
AppDelegate.deliverCommandURL(_:)  →  ApplicationDelegateProxy  →  Capacitor `appUrlOpen`
        ▼
capacitor-deep-links.ts  →  parseStartVoiceDeepLink  →  bus `deeplink.startVoice`
        ▼
use-global-deep-link-consumer.ts  →  navigate + the live-voice `starter`
```

## The two enums that must change together

`LiveVoiceSessionState` in
[`live-voice-store.ts`](../../web/src/domains/chat/voice/live-voice/live-voice-store.ts)
is the source of truth:

```
idle | connecting | listening | transcribing | thinking | speaking | ending | failed
```

`VoiceSessionAttributes.ContentState.Phase` in
[`App/App/Shared/VoiceSessionAttributes.swift`](../App/App/Shared/VoiceSessionAttributes.swift)
declares the same cases **minus `idle` and `failed`**, with raw values that
string-match. The web side sends those raw strings across the Capacitor bridge
and `VoiceLiveActivityPlugin.contentState(from:)` decodes them with
`Phase(rawValue:)`, so a case added or renamed on one side without the other
fails to decode and the plugin rejects the call. The TypeScript type is
`ActiveLiveVoiceSessionState` — the type `isLiveVoiceSessionActive()` narrows
to, derived rather than restated — so a web-side rename is a compile error on
the web and a silent decode failure natively. **The native enum is the half that
has to be remembered.**

Both omissions are the same rule: a Live Activity exists only for a *running*
session. `idle` is the absence of one, and on a failure `toActivityContent()`
returns `null` and the mirror *ends* the activity rather than rendering it — the
failure is surfaced in the app, where it can be dismissed, and an island the user
cannot act on is worse than none. A case for either would be unreachable state
the island UI would still have to handle.

### Why label copy comes from the web

`ContentState.label` is a string the web resolves out of its own catalog, keyed
by `liveVoiceSurfaceLabelKey(state, reconnecting, assistantAudioActive, muted)`:
the *same call the voice room makes*, so the island reads exactly what the room
reads, in the language the app is in. The
native side never switches on `phase` to produce wording — not in the expanded
island, not in the compact slots, not on the Lock Screen. Three reasons, in order
of importance:

1. **Cadence.** `LIVE_VOICE_STATE_KEYS` and the catalog behind it deploy
   continuously; this shell ships
   on App Store review. A native `switch` would fossilize whatever wording was
   current at submission and drift silently from the room the user is looking at.
2. **Two relabel rules, neither derivable from `phase` alone.**
   `liveVoiceSurfaceLabelKey` maps `connecting` + `reconnecting` to "Reconnecting…",
   and a `speaking` with no audio actually playing to "Thinking…" — `speaking`
   stays set across a mid-turn tool run (JARVIS-1279). Reproducing either
   natively means shipping more state across the bridge and duplicating the rule.
3. **Localization.** The web layer owns user-facing copy, and the label crosses
   the bridge already translated, so the island follows the app language with no
   catalog on this side.

Wherever the label *is* rendered it is only ever truncated (`.lineLimit(1)` +
`.truncationMode(.tail)` in `VoiceSessionText`), never swapped for a shorter
native string. Every phase that reaches an activity has a non-empty label, so
there is no empty-string case for `VoiceSessionText` to handle.

### What the native side may derive: the phase glyph

The rule above is about *wording*, and `ContentState.phaseSymbol` is the one
place that switches on `phase` without breaking it. An SF Symbol has no
second source deploying on a different cadence to drift from, and the phase
vocabulary it switches over is already a contract both sides must change
together, so a new case is a Swift compile error rather than silent drift.

It exists because the inline slots are a few characters wide. The passed label
truncates to a fragment there, and the fragments of "Listening…" and
"Thinking…" are not worth telling apart. Those slots render the glyph; the
roomier presentations render glyph *and* label. If short *wording* is ever
wanted inline, it belongs to the web layer that owns the wording, as a second
short label, not to a native `switch`.

### Which presentation a voice session actually gets

Probably the minimal one, which is why the phase glyph is what it renders.

iOS falls back to the minimal presentation when the Dynamic Island is shared,
and a live-voice session always shares it: the system's microphone privacy
indicator is on for the entire call. It stays on while muted, too, because
muting streams silence rather than stopping capture. That indicator cannot be
suppressed and should not be.

Two consequences worth keeping in mind when changing these views:

- **The minimal slot is the island, for most of a call.** It carries the phase
  rather than the avatar: identity is the fact that does not change and that
  the user already knows, and the accent tint keeps it weakly present anyway.
  It falls back to the identity mark when the content is stale, because a
  presentation that renders nothing reads as a broken app.
- **The expanded presentation is reached deliberately**, by touch and hold
  (a tap opens the app through `widgetURL`; the gesture mapping is the
  system's). Someone who held is asking for what the inline slots dropped, so
  it shows everything the activity knows: avatar, name, elapsed time, mute,
  phase glyph, phase label, and the activity line.

None of this is verifiable in the simulator, which has no island and no real
microphone. It is a device check.

### Alerting updates are reserved

`AlertConfiguration` forces a brief expanded presentation plus a haptic, a
sound, a Lock Screen banner, and an Apple Watch forward. No phase change ever
uses it: at the rate a conversation changes phase it would be intolerable, and
the phase is not something the user must be interrupted for. It is reserved for
a state change that genuinely requires attention, the first of which is an
approval request the turn is blocked on.

### The activity line: wording from a third layer

`ContentState.detail` is one short line saying what the turn is doing right now
("Reading a file"), or `""` when nothing nameable is. The phase says whether it
is your turn to talk; this says what it is busy with, and a turn can be
thinking *and* reading a file.

Its wording comes from neither this shell nor the web layer but from the
**daemon** (`assistant/src/live-voice/activity-label.ts`). Two reasons, and the
first is the binding one:

1. The island has two drivers carrying identical content state, and only one of
   them runs web code. A label composed in the web layer could not be
   reproduced by the APNs push that takes over once that layer is suspended, so
   both are handed the same string: the daemon sends an `activity` frame down
   the socket *and* the same text in its dispatch.
2. The daemon is the only layer that knows a tool ran at all.

This does not reopen the cadence question the phase-label rule answers. That
rule exists because *this shell* ships on App Store review; the daemon deploys
continuously, like the web bundle.

The label names what the user would say is happening, never the tool and never
its arguments: a path or a URL is unreadable at a glance and may be something
the user would not choose to show whoever else can see the Lock Screen. Every
tool gets a line, including ones the map has never seen, because the vocabulary
is open (plugins, MCP, skills) and a blank line at the busiest moment is the
worst of the options.

### What moves without an update: the elapsed timer

`VoiceSessionAttributes.startedAt` is stamped natively at `Activity.request`,
and `VoiceSessionTimer` renders it with `Text(timerInterval:)`, a
system-driven timer. It therefore keeps counting with no `ContentState` update
at all: through a suspended web layer, through a dropped push, and through
ActivityKit's update rate limit. For a session whose phase can legitimately sit
unchanged for minutes, it is what distinguishes an island that looks frozen
from one that visibly is not.

It is an attribute rather than content for two reasons: it is fixed for the
activity's lifetime, and being an attribute is what keeps a server-driven push
(which replaces the content state wholesale) from touching it. Stamping it
natively also puts it on the same clock as the device rendering it, which a
timestamp composed on the platform would not be.

Everything phase-derived (label, glyph, the activity line, and the timer)
drops when `context.isStale` goes true. Identity (avatar, name, accent) stays: that a
session with this assistant exists is still true, and tapping through still
reaches it.

## The deep-link contract

```
<scheme>://voice?mode=new|resume[&prompt=<percent-encoded text>]
```

- `<scheme>` is the running build's own: `vellum-assistant`,
  `vellum-assistant-staging`, or `vellum-assistant-dev`, set per environment as
  `BUNDLE_URL_SCHEME` in `App/App/Config/App*.xcconfig`.
- `mode` defaults to `new` for anything that is not exactly `resume`.
- `resume` puts a running session back on screen; with nothing running it
  degrades to `new`.
- `prompt` is optional free-form text (`AskVellumIntent`). The **web parser**
  bounds and sanitizes it — 2000 characters max, control characters rejected —
  because a deep link is reachable from any app or web page that can open a URL.
  A rejected prompt does not reject the link: the session still starts.
- `src=intent` is the provenance marker, added by `AppDelegate.deliverCommandURL`
  and stripped from every externally opened URL; see "Delivery paths" below.
  Producers never set it themselves.

Native producers build the URL through `VoiceModeDeepLink.url(prompt:)`
([`App/App/Shared/VoiceModeDeepLink.swift`](../App/App/Shared/VoiceModeDeepLink.swift)),
never by hand. That function assigns through `percentEncodedQueryItems` with
`&=+?#` removed from the allowed set, because `URLComponents.queryItems` encodes
with `urlQueryAllowed`, which permits those sub-delimiters — correct for a whole
query string, wrong for a single value inside one. A spoken "Ben & Jerry's" would
otherwise arrive as a `prompt` of `Ben ` plus a stray parameter.

### Producers

| Producer | Mode | Where |
| --- | --- | --- |
| `StartVoiceModeIntent` (Siri: "Talk to Vellum") | `resume` | `App/App/Intents/` |
| `StartNewVoiceConversationIntent` (Action Button, Control Center, Home Screen widgets) | `new` | `App/App/Shared/` |
| `AskVellumIntent` (Siri collects the question) | `new` + `prompt` | `App/App/Intents/` |
| Live Activity `widgetURL` (island / Lock Screen tap) | `resume` | `App/VoiceActivity/VoiceSessionLiveActivity.swift` |
| Safari, a note, another app, a test link | either | — |

### Delivery paths, and why a cold launch delivers exactly once

Intents run **in the app process** and never pass through
`application(_:open:)`, so `VoiceModeDeepLink.route()` hands the URL directly to
`AppDelegate.deliverCommandURL(_:)`. That method stashes the URL and replays it
through `ApplicationDelegateProxy` — the exact channel a warm open uses — once
the bridge web view exists, so the URL surfaces to JS as Capacitor's `appUrlOpen`
and needs no new web code. `AppPlugin` posts that event with
`retainUntilConsumed: true`, so a command delivered before the SPA registers its
listener is replayed rather than lost.

That in-process path is also what lets the SPA *trust* an intent's text.
`deliverCommandURL(_:)` adds a `src=intent` query item, and the two methods
through which a URL can arrive from outside the process,
`application(_:open:options:)` and `launchOptions[.url]`, strip it before
storing or forwarding (`App/App/CommandURLProvenance.swift`). Because intents
never pass through those methods and nothing else calls `deliverCommandURL`,
the marker reaches `appUrlOpen` exactly when an App Intent produced the URL. The
web parser reads it as `provenance: "intent"` (only when told the running shell
strips it, which is iOS alone), and on that evidence the consumer sends the
text on the user's behalf instead of staging it (LUM-3281). The Live Activity's
`widgetURL` and any Safari test link go through `application(_:open:)`, so they
never carry it, and a link that arrives with a forged marker is stripped and
logged.

The strip (Foundation) and the read (WHATWG `URL`) are different parsers over
the same string, and they disagree about percent-decoding: `URLSearchParams`
decodes item names, `percentEncodedQueryItems` does not, so a strip keyed on
the decoded name and a read keyed on the raw one (or vice versa) leaves a
spelling such as `s%72c=intent` that one side keeps and the other honors
(ATL-1293). Both sides therefore work on the raw `&`-split query: the web
parser honors only an item byte-equal to `src=intent`, and the shell drops
every item whose raw *or* percent-decoded name is `src`, a strict superset. A
URL the shell cannot take apart at all is refused at the entry point rather
than forwarded unstripped.

A **terminated** launch is the case that needs care, and the reason is the
opposite of the obvious one: the launch URL arrives **twice**, not zero times.

This app declares no `UIApplicationSceneManifest`, so it is a non-scene app and
`launchOptions[.url]` is populated ("If the app supports scenes, this is `nil`" —
[`application(_:didFinishLaunchingWithOptions:)`](https://developer.apple.com/documentation/uikit/uiapplicationdelegate/application(_:didfinishlaunchingwithoptions:))).
`application(_:open:options:)` is then called for that same URL as well:

> This method is not called if your implementations return `false` from both the
> `application(_:willFinishLaunchingWithOptions:)` and
> `application(_:didFinishLaunchingWithOptions:)` methods.
>
> — [`application(_:open:options:)`](https://developer.apple.com/documentation/uikit/uiapplicationdelegate/application(_:open:options:))

`AppDelegate` implements only `didFinishLaunchingWithOptions` and returns `true`
unconditionally, so the `open:` call always comes. That is also why a stock
Capacitor app — whose delegate handles URLs *only* in `application(_:open:)` —
receives `appUrlOpen` from a terminated state at all.

So `application(_:open:)` is the delivery. The launch stash is kept as a
**backstop**, because the `open:` route has a race of its own:
`ApplicationDelegateProxy` delivers by posting `.capacitorOpenURL`, and
`AppPlugin` only subscribes in its `load()` — a URL that arrives before the
bridge finishes registering plugins has no observer and is dropped, and nothing
in the web layer calls `App.getLaunchUrl()`, Capacitor's usual escape hatch for
exactly that. See [capacitor#5584](https://github.com/ionic-team/capacitor/issues/5584).

The two are deduped on the launch URL's identity, so the command reaches the web
layer exactly once whichever route wins:

- `AppDelegate.launchURL` holds the URL while it is still eligible to arrive a
  second time, and is cleared on the first background transition (re-opening the
  same URL requires leaving the app, so anything after that is genuinely new).
- If the `viewDidAppear` replay gets there first, it records
  `launchURLWasReplayed` and the `open:` call that follows is swallowed.
- If `application(_:open:)` gets there first **and the bridge web view exists**,
  the forward will be observed, so the backstop is dropped.
- If it gets there first with **no** web view yet, the forward goes nowhere and
  the backstop is deliberately kept — that is the case it was added for.
  `webView != nil` is the test because `CAPBridgeViewController` builds the web
  view and registers plugins in one synchronous `viewDidLoad`.

**No `connect` URL ever reaches any of this.** `handleConnectDeepLink` returns
`true` for *every* URL whose host is `connect`, malformed ones included (it logs
and returns `true`), and it is the guard on both the stash in
`didFinishLaunchingWithOptions` and the early return in `application(_:open:)`.
A cold-launch connect URL is therefore handled twice by `handleConnectDeepLink`
itself, which is harmless: it re-persists the same base and re-stashes the same
pair URL, and `deliverPendingConnectNavigation` clears
`pendingConnectPairURL` before loading, so the pair page loads once.

There are **two** independent cold-launch races and both fixes are required:

- **Native**: the URL reaches the web layer once — never twice, never zero times
  (above).
- **Web**: the URL arrives before `ChatLayout` registers the live-voice
  `starter`. `start-voice-deep-link.ts` parks the request and
  `use-live-voice-session-controller.ts` drains it when the starter registers.

Neither can cover for the other.

## App Intents: the availability duplication is load-bearing

Every voice intent declares **both**:

```swift
@available(iOS 26.0, *)
static var supportedModes: IntentModes { .foreground(.immediate) }

static var openAppWhenRun: Bool { true }
```

This is not leftover. iOS 26 soft-deprecated `openAppWhenRun` in favor of
`supportedModes`, but `supportedModes` is itself iOS 26.0+ while this app
deploys to **17.0**. Drop `openAppWhenRun` and every intent stops launching the
app on 17.0–25.x; drop `supportedModes` and you are shipping a deprecated
declaration on the current OS. `.foreground(.immediate)` is the documented exact
equivalent of `openAppWhenRun = true`, so the two agree.

**Do not "clean this up".** It reads like a redundant pair and is not. The
duplication can go away only when the deployment target reaches 26.0.

Neither alternative fits: `OpenIntent` needs a `target` `AppEntity` and SwiftUI's
`onAppIntentExecution` (there is no entity to open), and iOS 26 snippet intents
render a result in place, which is the opposite of launching the app.

`perform()` returns immediately — App Intents run under a short execution budget,
so it hands off rather than waiting for a session to start.

## `\(.applicationName)` — silent failure in two directions

Every phrase in `VoiceAppShortcuts.swift` must interpolate `\(.applicationName)`:

```swift
"Talk to \(.applicationName)"
```

App Intents **drops** phrases that omit the token, and the drop is silent at
runtime: the shortcut still appears in the Shortcuts app, so it looks registered
— Siri simply never matches a word of it. There is no build error and no log.

The token resolves from **`CFBundleDisplayName`**, which `App/Info.plist` sets to
`$(BUNDLE_DISPLAY_NAME)` and each environment's xcconfig supplies: "Vellum",
"Vellum Staging", "Vellum Dev". All three are pronounceable, which is why one
phrase list serves every build. If `BUNDLE_DISPLAY_NAME` were ever dropped from
an xcconfig, `CFBundleDisplayName` would expand to an empty string and the token
would fall back to `CFBundleName` — which is `$(PRODUCT_NAME)`, itself
XcodeGen's `$(TARGET_NAME)` default, so **"App"** / "App Staging" / "App Dev" —
and every phrase would silently stop matching while still appearing correct
everywhere you would think to look.

**No test can catch either failure.** Phrase registration happens in the system's
App Intents database at install time, outside the app's process. Verification is
manual: install, wait for indexing, and say each phrase to Siri.

Translations live in `App/App/Intents/<locale>.lproj/AppShortcuts.strings`, keyed
by the English phrase with the token spelled `${applicationName}` — the
strings-file form of the same token. Every phrase in every locale must keep it.
There is no `en.lproj`: App Intents falls back to the Swift literals, so an
English table would be identity mappings and a second place for the phrases to
drift.

## `VOICE_ACTIVITY_EXTENSION` — what compiles out of the appex

`App/App/Shared/` is compiled into the app targets *and* the three
`VoiceActivity` extension targets from one copy on disk. The extension targets
set `SWIFT_ACTIVE_COMPILATION_CONDITIONS = … VOICE_ACTIVITY_EXTENSION` (see
`project.yml`'s `ExtensionEnvironment` template), and exactly one body is guarded
by it: `VoiceModeDeepLink.route()`.

```swift
#if VOICE_ACTIVITY_EXTENSION
assertionFailure("Voice intents are performed in the app process, not the appex")
#else
(UIApplication.shared.delegate as? AppDelegate)?.deliverCommandURL(url)
#endif
```

Two things make the body impossible to compile into the appex. Delete the guard
and build `VoiceActivity Dev` to see both:

- **`UIApplication.shared` is unavailable under
  `APPLICATION_EXTENSION_API_ONLY`** — `error: 'shared' is unavailable in
  application extensions for iOS`. A hard compile error, not a warning. The
  setting is pinned in
  [`App/Config/Extension-Base.xcconfig`](../App/App/Config/Extension-Base.xcconfig)
  so the guarantee is the repo's rather than an Xcode default's.
- **`AppDelegate` links Capacitor**, which the appex does not — and must not. It
  is not even compiled into the extension, whose sources are `VoiceActivity/`
  plus `App/Shared/`: `error: cannot find type 'AppDelegate' in scope`.

The signature stays, so callers compile on both sides. That matters because
`StartNewVoiceConversationIntent` lives in `Shared/`: `StartVoiceControl` builds
a `ControlWidgetButton` around that exact type, and a control is code in the
appex, so the appex needs the intent *type* to exist. It never runs it — both
intents declare `openAppWhenRun` / `.foreground(.immediate)`, so the system
performs them in the app process even when the tap came from Control Center.
Sharing one intent type is what makes Control Center, the Action Button, and Siri
the same action rather than three lookalikes; compiling the body out is what
keeps that safe.

`import UIKit` at the top of the file is guarded the same way.

## `BundleURLScheme.current` is deliberately optional

[`App/App/Shared/BundleURLScheme.swift`](../App/App/Shared/BundleURLScheme.swift)
resolves the running bundle's scheme and returns `String?` with **no universal
fallback**. Substituting the production scheme on a misconfigured Dev or Staging
build is precisely the cross-environment mis-routing the type exists to prevent:
if the production app happens to be installed, iOS opens *that* one.

Each caller decides:

- **Auth** (`NativeAuthPlugin`) falls back to the production scheme. An OAuth
  callback is not a cross-app launch, and a sign-in that reaches a working
  callback beats one that fails outright.
- **Voice deep links** do **not** fall back. `VoiceModeDeepLink.url()` returns
  `nil`, `route()` logs and drops, and `.widgetURL(_:)` — which takes an optional
  — leaves the presentation untappable. **An untappable island beats one that
  opens the wrong app.**

The app and the appex read different keys, because they play different roles. The
app *registers* the scheme in `CFBundleURLTypes`, which is what iOS routes on, so
that is read first. An appex registers nothing — a widget extension must not
claim a URL type — so it carries the scheme as the plain `VellumURLScheme`
Info.plist string, populated from the same `$(BUNDLE_URL_SCHEME)` variable. Both
reject an empty value and one Xcode never expanded (`$(BUNDLE_URL_SCHEME)`
verbatim), either of which would produce an unopenable URL.

**The `BUNDLE_URL_SCHEME` value is restated in each `Extension-*.xcconfig` and
must match its `App-*.xcconfig` character for character.** A mismatch sends a Dev
island's tap into the production app.

## Design decisions

Three shape-the-whole-thing decisions, with what would have to change to
revisit each. The third has already been revisited once — it is kept here,
rewritten, rather than deleted, because the reasoning that overturned it is
what a future button has to satisfy too.

### 1. Live Activity updates come from two drivers

The app process issues `Activity.update` locally, **and** the platform pushes
the same content state over APNs. Both drive the same activity; they are not
alternatives.

*Why both.* The local path is lower-latency and needs no server round trip, but
it runs on the JS main thread of a `WKWebView` that iOS throttles and eventually
suspends once the app is backgrounded — which is the only state in which the
Lock Screen and the Dynamic Island are visible at all. The push path costs a
round trip and reaches the activity with no app process involved. Each covers
the other's blind spot, they carry identical `ContentState`, and ActivityKit
applies whichever arrives newest.

The push path, end to end:

```
live-voice-session.ts (daemon)      every phase-bearing frame passes sendFrame
        │  LiveActivityReporter — maps frame → phase, drops repeats
        ▼
POST /v1/assistants/{id}/live-activity/dispatch/     {conversation_id, phase, event}
        ▼
app/push (platform)                 looks the phase up in the registered lexicon
        │  APNsSender.send_live_activity_sync
        ▼
APNs      apns-push-type: liveactivity
          apns-topic: <bundle_id>.push-type.liveactivity
        ▼
iOS applies content-state to the activity — no app process involved
```

and the registration that makes an activity addressable:

```
VoiceLiveActivityPlugin   Activity.request(pushType: .token)
        │  activity.pushTokenUpdates → `liveActivityPushToken` event
        ▼
live-activity-push-registration.ts   POST .../live-activity/tokens/
        │  token + conversation id + the phase→label lexicon
        ▼
LiveActivityPushToken (platform)     expires on its own; deleted on session end
```

Three rules fall out of this:

- **The server never invents phase wording.** The reason the native side owns
  no copy — the shell ships on App Store cadence while the web bundle deploys
  continuously — applies to the platform too, one layer further out. The client
  registers a phase→label map and dispatch only ever looks a phase up in it,
  skipping a phase it has no label for.
- **Nor does it invent the rest of the content state.** A push replaces
  `ContentState` wholesale, and two of its fields (`accentHex` and `muted`)
  are things only the client can see: the accent is the avatar color this web
  layer renders, and mute is a local control the daemon's session never hears
  about. They are therefore stored on the token row at registration and
  composed from there, and the client re-registers whenever either moves. When
  the dispatch payload carried them instead, the daemon (which has neither) sent
  nothing and every field defaulted, so the first server-driven update grayed
  the island's accent out and dropped its mute glyph, which is to say it did so
  the moment the app was backgrounded.
- **`aps.timestamp` is a counter, not wall time.** iOS discards a push whose
  timestamp is not newer than the state it holds, and `transcribing` →
  `thinking` is routinely sub-second.
- **The daemon's reporter mirrors the client's mapping.** `phaseForFrame` and
  the frame handlers in `use-live-voice.ts` must agree; the client's stay
  authoritative for anything only it can observe (reconnects, mute, whether TTS
  audio is actually audible).

Even with both drivers, a push can be missed — so every update still carries a
`staleDate` (`VoiceLiveActivityPlugin.contentStaleAfter`), and the views drop
everything phase-derived once `context.isStale` goes true. An island frozen on
"Listening…" is a claim about a live socket and a live mic that nothing is
checking; the horizon does not make it correct, only honest about not knowing.

**Both drivers must use the same horizon**, since either can deliver the state
whose staleness is being judged. They are two constants in two repos
(`VoiceLiveActivityPlugin.contentStaleAfter` and the platform's
`STALE_AFTER_SECONDS`), and they had already drifted (120 against 45) once.
The client's 120 is the correct one: a quiet call emits no frames, so nothing
dispatches, and a 45-second horizon would strip the phase off a perfectly
healthy session that nobody happens to be talking to.

### 2. The Live Activity needs no App Group

`ContentState` carries only primitives (`phase`, `label`, `detail`,
`accentHex`, `muted`, `outputMuted`, `approvalRequestId`), and the attributes
carry `assistantName`, `startedAt`, and the
avatar as `Data`. Nothing on this path touches a shared container.

*Why:* an App Group is only needed to share *files*, and nothing here needs
one. The obvious candidate was the avatar, but `ActivityAttributes` is
`Codable`, so the bytes travel in the attributes and render via
`Image(uiImage:)`: nothing the island renders reaches a shared container, and
nothing on this path waits on an Apple Developer portal capability being in
sync across six App IDs (an entitlement enabled in the portal but not
satisfiable by the build is a provisioning failure waiting to happen).

What is genuinely impossible is fetching anything at render time: a Live
Activity draws from a snapshot, so a URL would only ever render `AsyncImage`'s
placeholder. That is also why the avatar is sized to a measured byte ceiling
before it is sent. See `ISLAND_AVATAR_MAX_BYTES` in
`clients/web/src/utils/avatar-island-encode.ts`, where oversize kills the whole
activity rather than degrading the image.

*The appex does carry one App Group, for a different path:* the group named by
`APP_GROUP_ID` is the shared container for widget snapshot data, the one place
the app and its widget extension both reach, since a widget draws from storage
rather than from an ActivityKit payload. `App/App/Extension.entitlements`
declares that group and nothing else, `APP_GROUP_ID` names it per environment
in every app and extension xcconfig, and the `VellumAppGroupId` Info.plist key
carries the identifier into both bundles, because the entitlement that grants
access is not readable from Swift. Enabling the capability on the six App IDs
is portal work; see `clients/ios/README.md`.

Nothing else joins that entitlements file, push included: only a capability the
build satisfies ships. And the container takes **non-secret display data only**
(ids, titles, group names, counts, timestamps), because a widget renders
without the app being unlocked, so no token, credential, or message body
belongs in it.

### 3. The island's buttons act in the app process, with no credential

This section used to record the opposite — "tap-to-return only, no interactive
End button" — on two arguments that have both since dissolved. The room stopped
being a full-app takeover (it minimizes, and the session runs on), so "act on
the call" was already not room-shaped; and `LiveActivityIntent` turned out to
need no signalling path worth the name.

The mechanism, which is the part worth knowing before adding a button:

```
Button(intent: VoiceSessionControlIntent(action:requestId:))   rendered by the appex
        │  iOS performs a LiveActivityIntent in the APP process, without foregrounding
        ▼
VoiceLiveActivityPlugin.deliverControl(_:requestId:)           a direct call, not IPC
        │  notifyListeners("liveActivityControl")
        ▼
use-live-activity-controls.ts                                  the session's own layer
```

**There is no endpoint, no token, and no network hop**, and that is not an
optimization — it is why this is buildable at all. The session lives in the web
layer inside this process's `WKWebView`; the intent runs in the same process, so
a press is one bridge event away from the code that already owns the socket. An
island button that had to authenticate would need a credential the app process
does not hold (the session token is in the web view's cookie jar), and every
proposal for getting one there — reading `WKWebsiteDataStore`, minting a scoped
token at session start — is a security question this design never has to ask.

The intent must be a `LiveActivityIntent`, not an `AppIntent`: it is the variant
performed in the app process without foregrounding. The voice-*launching*
intents deliberately do the opposite (`openAppWhenRun`), because starting a
conversation means putting the room on screen. Muting a call must not unlock the
phone.

Two rules govern what a button may send:

- **A status control sends the state its own label promised**, not a toggle. The
  island renders content that can be seconds old — and on the APNs path content
  composed without `outputMuted` at all — so a toggle resolved against live
  session state would be self-consistent and still invert what the user asked
  for. A stale absolute command is a no-op the next push corrects.
- **A decision names the request it is answering.** Approve/Deny carry the
  `approvalRequestId` they were drawn from, and the web layer answers *that*
  request or drops the press. The staleness that makes a mute harmless makes an
  approval dangerous: between the push and the press the request can be decided
  in the app, hit the daemon's 45-second fallback, or be superseded, and a press
  without an id would land on whatever came next.

Nothing is applied optimistically to the activity. The web layer is the only
thing that knows whether a command took, so it stays the only writer; the island
repaints through the mirror's own `update`.

Which presentations carry buttons: the Lock Screen card and the expanded island
only. The compact and minimal slots stay pure status, because reaching them
takes no gesture at all and a control there is one a pocket can press.

*Known gap:* `outputMuted` and `approvalRequestId` are local-path only. The
platform composes server-driven pushes from the fields registered on the token
row, which has neither, so an island being driven by APNs shows the assistant as
audible and offers no approval buttons. The wait itself still shows, because the
daemon words it into `detail`, which *is* on the push path. Registering the two
fields is the fix and it is a platform-side change — though for approvals the
gap is close to moot: a suspended web layer is precisely the state in which no
press could be acted on anyway.

## Background audio: what is known and what is not

`UIBackgroundModes: audio` (in `App/Info.plist`) plus an active
`.playAndRecord` / `.voiceChat` session buys the *audio* half: the app keeps its
audio session and its route while backgrounded or locked, output goes to the
loudspeaker rather than the earpiece via `.defaultToSpeaker`, and hardware echo
cancellation and AGC are engaged.

It does **not** buy the *web* half. WebKit throttles and eventually suspends JS
timers and main-thread work in a backgrounded web process. The AudioWorklet runs
on the audio render thread, but the velay socket send happens on the main JS
thread.

**Whether a WKWebView voice session actually survives lock is empirically
unknown.** The device spike that was meant to answer it was never run, and no
findings document exists. The background/foreground hardening that was planned on
top of it — `AudioContext` resume on `app.resume`, a socket-liveness probe, a
bounded background grace period — was never implemented either. Do not assume
coverage that is not there. Anyone picking this up should measure, on a physical
device, whether `getUserMedia` keeps producing PCM and whether the socket keeps
pumping once the app is backgrounded and once the screen is locked, and for how
long.

If that measurement says "must move native", capture and the socket move to
`AVAudioEngine` + `URLSessionWebSocketTask` and `VoiceAudioSessionPlugin` becomes
the audio-session half of that path rather than a hint to the webview.
Everything in this document above that line — the Live Activity, the deep-link
contract, the intents — is unaffected either way: it consumes store state and a
URL contract, not the audio transport.

A related open item: `.voiceChat` adds hardware AEC, which changes the
assumptions the software echo-adaptive barge-in gate was tuned against. Worth
measuring on device; deliberately not tuned as part of this work, so the gate's
behavior can be compared against a stable baseline.

## Testing

### Simulator-coverable

An iPhone 17 Pro simulator on the iOS 26.2 runtime covers more than you would
expect.

| What | How |
| --- | --- |
| Deep-link contract, both modes | `xcrun simctl openurl booted "vellum-assistant-dev://voice?mode=new"` — and `…?mode=resume`, and a `&prompt=` variant with `&`, `#`, and emoji to check the round trip |
| Terminated-launch delivery | Force-quit the app in the simulator first, then `openurl`. This is the path that used to drop; a warm-open pass proves nothing about it |
| Scheme isolation | Open a `vellum-assistant://` link with only the Dev build installed — nothing should happen |
| Live Activity presentations | Start a session, then background the app (`xcrun simctl launch booted com.apple.Preferences`; there is no home key). **The Dynamic Island renders in the simulator** on a Pro device: compact inline, and expanded on a touch and hold. Lock (⌘L) for the Lock Screen presentation, and check both appearances (Features → Toggle Appearance) since the accent is an arbitrary avatar color over a wallpaper |
| The mic privacy indicator competing for the island | Also reproducible: a session holds the mic for the whole call, muted included, so the island is shared and iOS falls back to the minimal presentation. This is the one that decides whether the compact slots are ever seen during a call |
| App Intents in the Shortcuts app | The three intents appear under the app with their icons and short titles |
| Control Center control | Add "New voice conversation" from the gallery and tap it |
| Extension builds (compile check only) | `cd clients/ios/App && xcodebuild -project App.xcodeproj -target "VoiceActivity Dev" -sdk iphonesimulator CODE_SIGNING_ALLOWED=NO` after `bun run ios:setup`. **Never install a build made with that flag**; see below |

**`CODE_SIGNING_ALLOWED=NO` silently kills Live Activities.** It is fine for a
compile check and wrong for anything you install: it strips the signature *and*
the entitlements, and an unsigned widget extension is never loaded, so the app
runs, the session runs, and the activity simply has nothing to render it. There
is no error anywhere, on either side, which makes it look like backgrounding
stopped working. Simulator builds ad-hoc sign without a team, so the flag buys
nothing there: build with signing on and install that.

Note on local builds: a full-app local build has been failing while resolving the
Capacitor SPM graph (`IONFilesystemLib`), which is environmental and pre-existing
— unrelated to anything here. **CI is the app-build gate**: `pr-ios.yaml` builds
the `App Dev` scheme unsigned on every PR touching `clients/ios/**`, and the
extension is embedded, so it builds too. Do not treat a green extension-only
build as a green app build. `ci-main-ios.yaml` runs the same build on pushes to
`main`, because both workflows are path-filtered: two PRs that pass
independently can still merge into a broken `main`.

### Device-only

The Simulator does not faithfully reproduce any of these.

| What | Why the simulator can't |
| --- | --- |
| Backgrounded and locked audio | The simulator does not suspend the web process the way real iOS does — this is exactly the measurement the missing spike needs |
| Siri phrase matching | Needs the on-device App Intents index and real speech. Allow a few minutes after install before the phrases resolve |
| Action Button | iPhone 15 Pro or newer. Settings → Action Button → Shortcut → Vellum → "New voice conversation" |
| Spotlight surfacing | Device-side indexing, which lags install |
| Apple Intelligence routing | Requires a device where Apple Intelligence is available |
| `.notifyOthersOnDeactivation` | Start music, run a voice session, end it, confirm the music resumes |
| Interruption handling | Take a real phone call mid-session; the session should end, not keep "listening" into a dead mic |
| Bluetooth / AirPods routing | `.voiceChat` HFP routing needs real hardware |
| No stranded island | Force-quit mid-session; the `applicationWillTerminate` end is fire-and-forget, so it may or may not win the race — relaunch and confirm `load()`'s sweep clears whatever survived. Same check after a crash |
| Stale island | Background a session and leave it long enough for iOS to suspend the web view; past the two-minute `staleDate` the island must stop showing a phase label rather than keep claiming "Listening…" |

## Shipping prerequisites

Each app target embeds a `VoiceActivity` extension whose bundle ID is prefixed by
its host app's, and Apple treats that appex as its own App ID with its own
provisioning profile. **Every environment signs with two profiles, not one.**
Three extension bundle IDs, three distribution profiles, and three
`IOS_PROVISIONING_PROFILE_EXT*` GitHub secrets have to exist before a release
build of that environment can archive and export.

None of it is created by any script. The full step-by-step checklist — exact
bundle IDs, exact profile names, secret names, and how to verify the signature on
the exported appex — is in
[`clients/ios/README.md` § Manual Apple Developer portal setup](../README.md#manual-apple-developer-portal-setup).
It is not duplicated here; a second copy would go stale and the names have to
agree character for character across the portal, the xcconfigs, and
`release-ios.yaml`.

## File map

| Path | Role |
| --- | --- |
| `App/App/VoiceAudioSessionPlugin.swift` | `AVAudioSession` ownership, interruption events |
| `App/App/VoiceLiveActivityPlugin.swift` | ActivityKit lifecycle, at most one activity |
| `App/App/MyViewController.swift` | Registers all four plugins in `capacitorDidLoad()` |
| `App/App/AppDelegate.swift` | Voice command stash + replay; `applicationWillTerminate` island teardown |
| `App/App/Shared/VoiceSessionAttributes.swift` | The ActivityKit wire model (app + appex) |
| `App/App/Shared/VoiceModeDeepLink.swift` | The one URL builder + the app-only `route()` |
| `App/App/Shared/BundleURLScheme.swift` | Per-build scheme resolution, deliberately optional |
| `App/App/Shared/CSSHexColor.swift` | `UIColor`/`Color` from a CSS hex, plus contrast-picking |
| `App/App/Shared/StartNewVoiceConversationIntent.swift` | In `Shared/` because the Control Center control needs the type |
| `App/App/Shared/VoiceSessionControlIntent.swift` | The intent behind every island button; in `Shared/` so the appex can name it |
| `App/App/Intents/` | The other two intents and `VoiceAppShortcuts` |
| `App/VoiceActivity/` | Widget extension: bundle, Live Activity, island views, Control Center controls |
| `App/VoiceActivity/Widgets/` | The three Home Screen widgets, their shared snapshot timeline, and the widget palette; snapshot-driven and unrelated to voice apart from a shared voice button |
| `App/App/Config/Extension*.xcconfig` | Extension build settings; bundle IDs, schemes, profile specifiers |
| `App/project.yml` | Six targets, `VOICE_ACTIVITY_EXTENSION`, embed relationships |

Web-side counterparts:

| Path | Role |
| --- | --- |
| `clients/web/src/runtime/native-voice.ts` | `callNativeVoice` — the skew-safe seam |
| `clients/web/src/runtime/native-audio-session.ts` | `VoiceAudioSession` bridge |
| `clients/web/src/runtime/native-live-activity.ts` | `VoiceLiveActivity` bridge — content out, button presses back |
| `clients/web/src/runtime/native-deep-link.ts` | `parseStartVoiceDeepLink` and prompt sanitization |
| `clients/web/src/domains/chat/voice/live-voice/use-live-activity-mirror.ts` | Store → island mirror |
| `clients/web/src/domains/chat/voice/live-voice/use-live-voice-session-controller.ts` | Mounts the mirror and the audio-session lifecycle |
| `clients/web/src/hooks/use-global-deep-link-consumer.ts` | `deeplink.startVoice` consumer |

## See also

- [`clients/ios/README.md`](../README.md) — shell setup, targets, release pipeline, portal checklist.
- [`clients/web/docs/CAPACITOR.md`](../../web/docs/CAPACITOR.md) — the web-side rules, including the skew rule.
- [Apple — ActivityKit](https://developer.apple.com/documentation/activitykit)
- [Apple — App Intents](https://developer.apple.com/documentation/appintents)
- [Apple — `AVAudioSession`](https://developer.apple.com/documentation/avfaudio/avaudiosession)
