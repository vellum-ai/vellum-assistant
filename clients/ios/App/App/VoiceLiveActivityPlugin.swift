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
/// `isAvailable` is both the shell-version probe (an older App Store shell
/// rejects the call with Capacitor's "not implemented") *and* the user-
/// preference probe: Live Activities can be switched off per-app in Settings,
/// which must read as `false`, never as an error.
///
/// ## No stranded islands
///
/// An island outlives its process unless something ends it, so teardown is
/// belt-and-braces: ``load()`` ends anything left over by a previous launch
/// (the crash case, where neither hook below runs), `applicationWillTerminate`
/// ends the running activity when the user force-quits a backgrounded voice
/// session, and `deinit` covers bridge teardown.
///
/// References:
/// - https://developer.apple.com/documentation/activitykit/activity
/// - https://developer.apple.com/documentation/activitykit/activityauthorizationinfo
@objc(VoiceLiveActivityPlugin)
public class VoiceLiveActivityPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VoiceLiveActivityPlugin"
    public let jsName = "VoiceLiveActivity"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "end", returnType: CAPPluginReturnPromise),
    ]

    /// Stable rejection code for every ActivityKit failure, so the web side can
    /// branch on it without matching against a localized message.
    private static let failureCode = "LIVE_ACTIVITY_FAILED"

    /// How long `applicationWillTerminate` may block the main thread waiting for
    /// the activity to actually end. iOS allows roughly five seconds before it
    /// kills the process; ending is asynchronous, so without a bounded wait the
    /// app can die first and strand the island.
    private static let terminationEndTimeout: DispatchTimeInterval = .milliseconds(1500)

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
        guard let activity else { return }
        Task { await activity.end(nil, dismissalPolicy: .immediate) }
    }

    // MARK: - isAvailable

    /// Capability probe: `false` when the user has turned Live Activities off
    /// for this app in Settings, and a rejection (which the web side reads as
    /// `false`) on a shell that predates this plugin.
    @objc public func isAvailable(_ call: CAPPluginCall) {
        call.resolve(["available": ActivityAuthorizationInfo().areActivitiesEnabled])
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
                await running.update(ActivityContent(state: state, staleDate: nil))
                call.resolve(["started": true])
                return
            }
            guard ActivityAuthorizationInfo().areActivitiesEnabled else {
                call.resolve(["started": false])
                return
            }
            do {
                self.activity = try Activity.request(
                    attributes: VoiceSessionAttributes(assistantName: assistantName),
                    content: ActivityContent(state: state, staleDate: nil)
                )
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
            guard let running = self?.activity else {
                call.resolve()
                return
            }
            await running.update(ActivityContent(state: state, staleDate: nil))
            call.resolve()
        }
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
            await running.end(nil, dismissalPolicy: .immediate)
            call.resolve()
        }
    }

    // MARK: - Teardown

    /// End the running activity as the app terminates. Called from
    /// `AppDelegate.applicationWillTerminate`, which is what a user swiping away
    /// a backgrounded voice session triggers.
    ///
    /// Blocks the main thread for at most ``terminationEndTimeout``: the process
    /// is about to go away, so fire-and-forget would lose the race and leave the
    /// island on screen with no owner. A launch-time sweep (``load()``) is the
    /// backstop for the paths this cannot cover, such as a crash.
    static func endRunningActivityBeforeTermination() {
        guard let activity = registered?.activity else { return }
        // Cleared so the `deinit` that follows during teardown does not fire a
        // second end at an activity already on its way out.
        registered?.activity = nil
        let ended = DispatchSemaphore(value: 0)
        Task {
            await activity.end(nil, dismissalPolicy: .immediate)
            ended.signal()
        }
        _ = ended.wait(timeout: .now() + terminationEndTimeout)
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

    /// Read the four `ContentState` fields off a bridge call. `phase` is
    /// required and must decode; the rest degrade to harmless defaults rather
    /// than failing a best-effort call. `accentHex` is canonicalized by
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
            muted: call.getBool("muted") ?? false
        )
    }
}
