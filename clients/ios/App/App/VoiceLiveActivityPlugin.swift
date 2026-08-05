import ActivityKit
import Capacitor
import Foundation

/// Capacitor plugin that owns the ActivityKit Live Activity mirroring a running
/// live-voice session — the Dynamic Island / Lock Screen presence for a session
/// that otherwise lives entirely in the web layer.
///
/// ## The wire contract
///
/// The web half is `clients/web/src/runtime/native-live-activity.ts`; the two
/// files are a pair and must change together. The activity's shape is
/// `VoiceSessionAttributes` (`App/Shared/VoiceSessionAttributes.swift`), which
/// is also compiled into the widget extension that renders it. This plugin only
/// *requests* activities — ActivityKit's request API is typed on the attributes,
/// not on the presentation, so this compiles and runs with or without the
/// extension. Without it, iOS simply has nothing to draw.
///
/// All user-facing copy (`label`) is passed through from the web side. The
/// native side never derives phase wording — see `VoiceSessionAttributes` for
/// why.
///
/// ## Traffic runs both ways
///
/// Content goes out (`start` / `update` / `end`); two things come back as
/// events. The ActivityKit push token, so the *server* can drive the island
/// while iOS has this web view suspended, and island button presses, which
/// arrive through ``deliverControl(_:)`` from an App Intent iOS performs in
/// this process. Both are events rather than promise results because neither
/// is the answer to a call the web side made.
///
/// ## At most one activity, ever
///
/// The plugin holds a single handle. `start` while one is already running
/// updates it rather than requesting a second: ActivityKit will happily create
/// a duplicate, and two islands for one voice session is a visible bug with no
/// way for the user to dismiss the stale one.
///
/// ## Nothing here may break a voice session
///
/// Every ActivityKit call is wrapped and rejects with the stable
/// ``failureCode``; the web side treats every method as best-effort and
/// swallows failures through `callNativeVoice`. A Live Activity is a flourish —
/// a session must run identically without it.
///
/// There is deliberately no separate availability probe. `start` resolving
/// `started: false` already covers every "no island here" case — an older App
/// Store shell (whose rejection `callNativeVoice` turns into the same `false`)
/// and Live Activities switched off per-app in Settings, which is a user
/// preference and never an error.
///
/// ## No stranded islands
///
/// An island outlives its process unless something ends it, so teardown is
/// belt-and-braces: ``load()`` ends anything left over by a previous launch —
/// the only *guarantee*, since it is the one hook that cannot be cut short by
/// the process going away — while `applicationWillTerminate` makes a
/// best-effort end when the user force-quits a backgrounded voice session and
/// `deinit` covers bridge teardown.
///
/// References:
/// - https://developer.apple.com/documentation/activitykit/activity
/// - https://developer.apple.com/documentation/activitykit/activityauthorizationinfo
@objc(VoiceLiveActivityPlugin)
public class VoiceLiveActivityPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VoiceLiveActivityPlugin"
    public let jsName = "VoiceLiveActivity"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "end", returnType: CAPPluginReturnPromise),
    ]

    /// Stable rejection code for every ActivityKit failure, so the web side can
    /// branch on it without matching against a localized message.
    private static let failureCode = "LIVE_ACTIVITY_FAILED"

    /// Event carrying an ActivityKit push token to JS. Must match the listener
    /// name in `clients/web/src/runtime/native-live-activity.ts`.
    private static let pushTokenEvent = "liveActivityPushToken"

    /// Event carrying an island button press to JS. Must match the listener
    /// name in `clients/web/src/runtime/native-live-activity.ts`.
    private static let controlEvent = "liveActivityControl"

    /// Watches ``Activity/pushTokenUpdates`` for the running activity.
    ///
    /// Cancelled and replaced whenever the activity is, so a token from a
    /// previous session can never be reported as the current one — the
    /// platform addresses activities by conversation, and a stale token there
    /// would push a live session's phase at an island that no longer exists.
    private var pushTokenTask: Task<Void, Never>?

    /// How long a pushed content state stays trustworthy before ActivityKit
    /// marks it stale.
    ///
    /// Every update comes from the web layer's JS main thread, which WebKit
    /// throttles and eventually suspends in a backgrounded app — so a session
    /// whose socket and mic are gone can leave a confident "Listening…" on the
    /// Lock Screen indefinitely. Past this horizon the system flips the
    /// activity to `ActivityState.stale` and sets `context.isStale`, which
    /// `VoiceSessionLiveActivity` renders as "no longer current" instead of a
    /// live phase.
    ///
    /// Two minutes is the shortest horizon that does not accuse a *healthy*
    /// session of being wedged: a real conversation changes phase every few
    /// seconds, and the only silence longer than this is a session nobody is
    /// talking to — which the island may as well show as idle. Shorter would
    /// flag long pauses; much longer and the wedged case, the one this exists
    /// for, keeps lying past the point the user would act on it.
    private static let contentStaleAfter: TimeInterval = 120

    /// Wrap a content state with the staleness horizon every push shares.
    private static func content(
        _ state: VoiceSessionAttributes.ContentState
    ) -> ActivityContent<VoiceSessionAttributes.ContentState> {
        ActivityContent(
            state: state,
            staleDate: Date().addingTimeInterval(contentStaleAfter)
        )
    }

    /// The live plugin instance, so `AppDelegate.applicationWillTerminate` can
    /// reach it. Weak: the bridge owns the plugin's lifetime, not this.
    private static weak var registered: VoiceLiveActivityPlugin?

    /// The one activity this plugin may have running, or `nil`.
    ///
    /// Touched only from the main thread: every mutation happens inside a
    /// `@MainActor` task, and both teardown hooks run on the main thread. That
    /// discipline — not a lock — is what makes "at most one" hold when `start`
    /// and `end` race.
    private var activity: Activity<VoiceSessionAttributes>?

    // MARK: - Lifecycle

    override public func load() {
        Self.registered = self
        Self.endActivitiesStrandedByAPreviousLaunch()
    }

    deinit {
        pushTokenTask?.cancel()
        guard let activity else { return }
        Task { await activity.end(nil, dismissalPolicy: .immediate) }
    }

    // MARK: - start

    /// Begin mirroring a voice session, resolving `{ started: Bool }`.
    ///
    /// Expects `{ assistantName, phase, label, accentHex, muted }`. Resolves
    /// `started: false` — rather than rejecting — when Live Activities are
    /// disabled in Settings, because that is a user preference and not a fault.
    /// Calling it while an activity is already running updates that activity and
    /// resolves `started: true`; it never requests a second one.
    @objc public func start(_ call: CAPPluginCall) {
        guard let assistantName = call.getString("assistantName"), !assistantName.isEmpty else {
            call.reject("Missing required option: assistantName", Self.failureCode)
            return
        }
        guard let state = Self.contentState(from: call) else {
            call.reject("Missing or unrecognized option: phase", Self.failureCode)
            return
        }

        Task { @MainActor [weak self] in
            guard let self else {
                call.resolve(["started": false])
                return
            }
            if let running = self.activity {
                let alert = self.alertConfiguration(for: state)
                self.lastApprovalRequestId = state.approvalRequestId
                await running.update(
                    Self.content(state),
                    alertConfiguration: alert
                )
                call.resolve(["started": true])
                return
            }
            guard ActivityAuthorizationInfo().areActivitiesEnabled else {
                call.resolve(["started": false])
                return
            }
            do {
                let requested = try Activity.request(
                    attributes: VoiceSessionAttributes(
                        assistantName: assistantName,
                        // Stamped here, at the one moment an activity begins.
                        // A `start` that lands on a running activity takes the
                        // branch above and only updates its content, so the
                        // timer keeps counting the session rather than
                        // restarting on a redundant start (the controller
                        // remounting across a route change issues exactly one).
                        startedAt: Date(),
                        avatarImageData: Self.avatarImageData(from: call)
                    ),
                    content: Self.content(state),
                    // `.token` is what makes this activity addressable from the
                    // server. Local updates keep working exactly as before; the
                    // token is the path that survives the web layer being
                    // suspended, which is the only state the island is ever
                    // seen in. Asking for it costs nothing when unused — a
                    // token nobody registers is simply never pushed to.
                    pushType: .token
                )
                self.activity = requested
                // A fresh activity has alerted for nothing yet, and its opening
                // content is almost never a wait. Seeding from it rather than
                // clearing keeps the one case that is — a session started while
                // a decision was already outstanding — from alerting again on
                // its first update.
                self.lastApprovalRequestId = state.approvalRequestId
                self.observePushToken(of: requested)
                call.resolve(["started": true])
            } catch {
                call.reject(
                    "Failed to start the voice Live Activity: \(error.localizedDescription)",
                    Self.failureCode,
                    error
                )
            }
        }
    }

    // MARK: - update

    /// Push new content to the running activity. Expects
    /// `{ phase, label, accentHex, muted }`. A no-op resolve when no activity is
    /// running — the web side mirrors store state and must not have to know
    /// whether the request ever succeeded.
    @objc public func update(_ call: CAPPluginCall) {
        guard let state = Self.contentState(from: call) else {
            call.reject("Missing or unrecognized option: phase", Self.failureCode)
            return
        }

        Task { @MainActor [weak self] in
            guard let self, let running = self.activity else {
                call.resolve()
                return
            }
            let alert = self.alertConfiguration(for: state)
            self.lastApprovalRequestId = state.approvalRequestId
            await running.update(Self.content(state), alertConfiguration: alert)
            call.resolve()
        }
    }

    /// The `approvalRequestId` of the last content pushed, so a *new* wait can
    /// be told from a repaint of one already on screen.
    @MainActor private var lastApprovalRequestId = ""

    /// The alert to raise with this update, or `nil` for a silent one.
    ///
    /// **Exactly one thing alerts: a decision the turn has just started waiting
    /// on.** A Live Activity update is silent by default, which is right for
    /// every other field here — a session moves through `listening`,
    /// `thinking`, and `speaking` many times a minute, and a phase change that
    /// buzzed the phone would make the island unbearable inside one call.
    ///
    /// A pending approval is the opposite case. The turn is *blocked*, the card
    /// that would normally carry it is behind a lock screen, and the daemon's
    /// fallback decides for the user in 45 seconds. A silent update there is a
    /// question asked of someone who was never told they were asked.
    ///
    /// Gated on the id *changing* to a non-empty value, not on it being
    /// non-empty: a wait outlives several pushes (a parallel tool starting, an
    /// accent arriving late), and re-alerting on each would be one prompt
    /// buzzing repeatedly.
    @MainActor
    private func alertConfiguration(
        for state: VoiceSessionAttributes.ContentState
    ) -> AlertConfiguration? {
        guard !state.approvalRequestId.isEmpty,
              state.approvalRequestId != lastApprovalRequestId
        else {
            return nil
        }
        // The title and body are the alert's own words, not the activity's, and
        // there is no passthrough to use: `detail` is written for a glance at a
        // running session ("Running a command — needs your okay"), while this is
        // a notification banner that has to make sense on its own. Kept generic
        // for the same reason the activity line names no arguments — it can be
        // read by anyone holding the phone.
        return AlertConfiguration(
            title: "Waiting on you",
            body: "Your assistant needs permission to continue.",
            sound: .default
        )
    }

    // MARK: - end

    /// Dismiss the running activity immediately — the session is over, so
    /// leaving the island up for ActivityKit's default grace period would show a
    /// stale state. A no-op resolve when nothing is running.
    @objc public func end(_ call: CAPPluginCall) {
        Task { @MainActor [weak self] in
            guard let self, let running = self.activity else {
                call.resolve()
                return
            }
            // Cleared before awaiting so a `start` that lands during teardown
            // requests a fresh activity instead of updating a dying one.
            self.activity = nil
            self.cancelPushTokenObservation()
            await running.end(nil, dismissalPolicy: .immediate)
            call.resolve()
        }
    }

    // MARK: - Push token

    /// Report every push token *activity* is issued, until it ends.
    ///
    /// The sequence yields more than once: iOS may rotate a token mid-activity,
    /// and each value invalidates the last. Every one is forwarded, and the web
    /// side re-registers — a rotation the platform never hears about leaves it
    /// pushing at a token APNs has stopped honouring, which fails as
    /// `BadDeviceToken` and looks exactly like a session that ended.
    ///
    /// Emitted as an event rather than resolved from `start`, because the first
    /// token arrives some time after the request returns and there may be more
    /// later; a promise could carry neither.
    @MainActor
    private func observePushToken(of activity: Activity<VoiceSessionAttributes>) {
        pushTokenTask?.cancel()
        pushTokenTask = Task { [weak self] in
            for await tokenData in activity.pushTokenUpdates {
                // APNs addresses devices by the hex string, not the bytes.
                let token = tokenData.map { String(format: "%02x", $0) }.joined()
                guard !Task.isCancelled else { return }
                self?.notifyListeners(Self.pushTokenEvent, data: ["token": token])
            }
        }
    }

    /// Stop watching for tokens. The activity is going away, so any token it
    /// issues from here is one nothing should register.
    private func cancelPushTokenObservation() {
        pushTokenTask?.cancel()
        pushTokenTask = nil
    }

    // MARK: - Controls

    /// Forward an island button press to the web layer, which owns the session.
    ///
    /// Called from ``VoiceSessionControlIntent/perform()``, which iOS runs in
    /// *this* process — so this is a direct call, not IPC, and there is no
    /// App Group, no shared file, and no server round trip between the button
    /// and the session. `registered` is how it finds the live plugin: an
    /// intent is not constructed by the bridge and has no handle of its own.
    ///
    /// **Best-effort, deliberately not retained.** Capacitor can hold an event
    /// until a listener attaches (`retainUntilConsumed`), which is right for
    /// facts and wrong for commands: a mute pressed against a session that is
    /// already gone would be replayed at whatever session attached next. A
    /// press that lands with nothing listening does nothing, and the user sees
    /// that it did nothing, because the island never claimed otherwise (see
    /// ``VoiceSessionControlIntent/perform()`` on why nothing is applied
    /// optimistically).
    ///
    /// In practice there IS a listener whenever there is an activity: a live
    /// session holds an active audio session, which is what keeps this app —
    /// and the web view driving it — running behind the Lock Screen at all.
    /// `requestId` is the confirmation an approve/deny press is answering and
    /// is empty for every other action. It is passed through untouched — the
    /// web layer is what decides whether it still matches the pending request,
    /// because it is the only side that knows.
    static func deliverControl(
        _ action: VoiceSessionControlAction,
        requestId: String = ""
    ) {
        guard let plugin = registered else {
            NSLog("[voice] Live Activity control with no plugin loaded; dropping")
            return
        }
        // Logged on every press, because this hop is otherwise invisible: an
        // island button leaves no trace in the app, `WKWebView` console output
        // never reaches the unified log, and a press that lands with nothing
        // listening is indistinguishable from one that was never made. The
        // listener count is what separates "the web layer never subscribed"
        // from "it subscribed and declined to act".
        NSLog(
            "[voice] Live Activity control %@ (listening: %@)",
            action.rawValue,
            plugin.hasListeners(controlEvent) ? "yes" : "no"
        )
        // The id is omitted rather than sent empty when there is none, so the
        // bridge payload matches the optional field the web type declares and
        // an action that carries no request cannot be read as carrying a
        // blank one.
        var payload: [String: Any] = ["action": action.rawValue]
        if !requestId.isEmpty {
            payload["requestId"] = requestId
        }
        plugin.notifyListeners(controlEvent, data: payload)
    }

    // MARK: - Teardown

    /// End the running activity as the app terminates. Called from
    /// `AppDelegate.applicationWillTerminate`, which is what a user swiping away
    /// a backgrounded voice session triggers.
    ///
    /// Best-effort and non-blocking. Waiting for the end to complete is the
    /// obvious thing to want here and is the wrong thing to do:
    /// `applicationWillTerminate` runs on the main thread inside iOS's ~5s
    /// termination budget, `Activity.end` is free to hop to the main actor
    /// internally, and a main-thread semaphore wait cannot let that
    /// continuation run — so the wait deadlocks until its own timeout, burns
    /// the budget, and strands the island anyway. Returning immediately at
    /// least lets the end task run before the process is torn down.
    ///
    /// The real guarantee is the launch-time sweep in ``load()``: anything that
    /// outlives this process is ended the next time the plugin loads. An island
    /// cleaned up on next launch beats a hung termination.
    static func endRunningActivityBeforeTermination() {
        guard let activity = registered?.activity else { return }
        // Cleared so the `deinit` that follows during teardown does not fire a
        // second end at an activity already on its way out.
        registered?.activity = nil
        registered?.cancelPushTokenObservation()
        // Detached so the end runs on the global executor rather than behind
        // whatever the terminating main thread is still doing.
        Task.detached(priority: .userInitiated) {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
    }

    /// Dismiss any voice activity still on screen from a previous process. A
    /// crash ends the session without running either teardown hook, and the
    /// island would otherwise sit there indefinitely showing a phase nothing is
    /// driving. Nothing can legitimately be running at plugin-load time, so
    /// everything found here is stale.
    private static func endActivitiesStrandedByAPreviousLaunch() {
        for stranded in Activity<VoiceSessionAttributes>.activities {
            Task { await stranded.end(nil, dismissalPolicy: .immediate) }
        }
    }

    // MARK: - Payload

    /// Decode the optional `avatarBase64` attribute off a bridge call.
    ///
    /// Best-effort in both directions: a bundle too old to send the field and
    /// a payload that is not valid base64 both resolve to `nil`, which the
    /// island renders as its accent glyph. Nothing about an avatar is worth
    /// failing a session over, and rejecting here would cost the user the
    /// whole Live Activity rather than just its picture.
    ///
    /// Size is deliberately not checked. `encodeAvatarForIsland` keeps the
    /// payload under budget on the web side, and the only authority on what
    /// actually fits is `Activity.request`, which throws
    /// `attributesTooLarge` and is already handled by the caller's `catch`.
    private static func avatarImageData(from call: CAPPluginCall) -> Data? {
        guard let base64 = call.getString("avatarBase64"), !base64.isEmpty else {
            return nil
        }
        return Data(base64Encoded: base64)
    }

    /// Read the `ContentState` fields off a bridge call. `phase` is required
    /// and must decode; the rest degrade to harmless defaults rather than
    /// failing a best-effort call. `accentHex` is canonicalized by
    /// `ContentState.init`, so an unparseable color lands as the neutral accent.
    private static func contentState(from call: CAPPluginCall) -> VoiceSessionAttributes.ContentState? {
        guard let rawPhase = call.getString("phase"),
              let phase = VoiceSessionAttributes.ContentState.Phase(rawValue: rawPhase)
        else {
            return nil
        }
        return VoiceSessionAttributes.ContentState(
            phase: phase,
            label: call.getString("label") ?? "",
            accentHex: call.getString("accentHex")
                ?? VoiceSessionAttributes.ContentState.neutralAccentHex,
            muted: call.getBool("muted") ?? false,
            // Absent from a web bundle older than this field, whose island
            // shows the assistant as audible. See the property's docs.
            outputMuted: call.getBool("outputMuted") ?? false,
            // Absent from a web bundle older than this field, which simply has
            // no activity line to show.
            detail: call.getString("detail") ?? "",
            // Absent from a web bundle older than this field, and from the
            // great majority of pushes a current one sends, since a turn is
            // seldom waiting on a decision. Both read as "nothing pending",
            // which offers no buttons.
            approvalRequestId: call.getString("approvalRequestId") ?? ""
        )
    }
}
