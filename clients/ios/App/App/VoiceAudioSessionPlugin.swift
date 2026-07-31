import AVFoundation
import Capacitor

/// Capacitor plugin that owns the app's `AVAudioSession` for the duration of a
/// live-voice session, and reports the system interruptions that can take it
/// away.
///
/// ## Why this exists
///
/// Live voice runs entirely in the web layer today (mic capture, the velay
/// WebSocket, and TTS playback all live under
/// `clients/web/src/domains/chat/voice/live-voice/`). `WKWebView` configures a
/// default audio session on the app's behalf, and that default is wrong for a
/// full-duplex voice assistant in two ways: it does not survive the app going
/// to the background, and it does not engage the system voice-processing I/O
/// unit. This plugin lets the web layer request the right session at the start
/// of a voice session and hand it back at the end.
///
/// Paired with `audio` in `UIBackgroundModes` (see `Info.plist`), an active
/// `.playAndRecord` session keeps the app's audio running while the app is
/// backgrounded or the screen is locked. Note that the background mode buys
/// *audio*; it does not by itself guarantee that a backgrounded web process
/// keeps feeding that audio pipeline.
///
/// ## Unresolved: does the webview voice session actually survive backgrounding?
///
/// The empirical verdict is **still outstanding**. The device spike that was
/// meant to answer it (does `getUserMedia` keep producing PCM, and does the
/// velay WebSocket keep pumping, once `WKWebView` is backgrounded or the screen
/// is locked?) has not been run, and no findings document exists. If that spike
/// concludes "must move native", capture and the socket move to
/// `AVAudioEngine` + `URLSessionWebSocketTask` in Swift — and this plugin
/// becomes the audio-session half of that native path rather than a standalone
/// hint to the webview. Either way a correctly configured `AVAudioSession` is a
/// prerequisite, which is why this lands before the verdict is in. A native
/// capture path may follow; it would extend this plugin, not replace it.
///
/// ## Why `.voiceChat` mode
///
/// `.voiceChat` is deliberate, not cosmetic. It selects the system
/// voice-processing I/O unit, which gives us hardware echo cancellation and
/// automatic gain control, and it routes AirPods and other Bluetooth headsets
/// over HFP so the mic input actually comes from the headset.
///
/// This is expected to interact with the echo-adaptive barge-in gate
/// (JARVIS-1296) in `clients/web/src/domains/chat/voice/live-voice/`: that gate
/// exists to compensate, in software, for the assistant hearing its own TTS
/// output. Hardware AEC reduces the echo the gate is tuned against, so the
/// gate's thresholds may end up conservative on iOS once this ships. **Any
/// barge-in retuning is a separate follow-up, explicitly not this PR** — this
/// plugin deliberately changes only the audio session configuration so the
/// barge-in behavior can be measured against a stable baseline.
///
/// ## Skew contract
///
/// The iOS app is a `server.url` shell: the web bundle updates continuously
/// while this shell only changes on an App Store release, so an arbitrarily new
/// bundle can be running against an arbitrarily old shell. There is deliberately
/// no separate capability probe — on an older shell `activate` rejects with
/// Capacitor's "not implemented" error, which `callNativeVoice` in
/// `clients/web/src/runtime/native-voice.ts` swallows into its `false` fallback,
/// and that `false` *is* the probe. No method here may ever crash or hang — a
/// failed bridge call must degrade to a voice session that behaves as it does
/// today.
///
/// References:
/// - https://developer.apple.com/documentation/avfaudio/avaudiosession
/// - https://developer.apple.com/documentation/avfaudio/avaudiosession/mode/voicechat
@objc(VoiceAudioSessionPlugin)
public class VoiceAudioSessionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VoiceAudioSessionPlugin"
    public let jsName = "VoiceAudioSession"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "activate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deactivate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "describe", returnType: CAPPluginReturnPromise),
    ]

    /// Event name forwarded to JS via `notifyListeners`. Must match the
    /// listener name in `clients/web/src/runtime/native-audio-session.ts`.
    private static let interruptionEvent = "voiceAudioInterruption"

    /// Stable rejection code for every `AVAudioSession` failure, so the web
    /// side can branch on it without matching against a localized message.
    private static let failureCode = "AUDIO_SESSION_FAILED"

    // MARK: - Lifecycle

    /// Subscribe to interruptions for the plugin's lifetime. Capacitor calls
    /// `load()` once, when the bridge instantiates the plugin, so this observer
    /// outlives any individual voice session, and `notifyListeners` is a no-op
    /// when JS has no listener attached.
    override public func load() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleInterruption(_:)),
            name: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance()
        )
    }

    // MARK: - activate

    /// Configure and activate the voice audio session.
    ///
    /// `.playAndRecord` is the only category that supports simultaneous capture
    /// and playback, and the only one the `audio` background mode applies to
    /// for a full-duplex session. `.defaultToSpeaker` keeps hands-free output on
    /// the loudspeaker rather than the earpiece when no headset is attached —
    /// without it, `.playAndRecord` routes playback to the receiver and the
    /// assistant sounds like a phone call held to your ear.
    ///
    /// Resolves `{ activated: true }`. On an `AVAudioSession` throw it rejects
    /// with the stable `AUDIO_SESSION_FAILED` code rather than crashing; the web
    /// caller treats that as "no native audio session" and proceeds.
    @objc public func activate(_ call: CAPPluginCall) {
        let session = AVAudioSession.sharedInstance()
        do {
            // `.allowBluetoothHFP` is the current spelling of the option long
            // known as `.allowBluetooth`, which is now deprecated.
            try session.setCategory(
                .playAndRecord,
                mode: .voiceChat,
                options: [.allowBluetoothHFP, .allowBluetoothA2DP, .defaultToSpeaker]
            )
            try session.setActive(true)
            call.resolve(["activated": true])
        } catch {
            call.reject(
                "Failed to activate the voice audio session: \(error.localizedDescription)",
                Self.failureCode,
                error
            )
        }
    }

    // MARK: - deactivate

    /// Release the voice audio session.
    ///
    /// `.notifyOthersOnDeactivation` is what lets music, podcasts, and other
    /// apps' audio that we interrupted resume where they left off. Without it
    /// the user is left with silence after a voice session ends.
    ///
    /// Resolves `{}` on success and rejects with `AUDIO_SESSION_FAILED` on
    /// throw. Deactivation failing is not fatal to anything — the caller
    /// fire-and-forgets it.
    @objc public func deactivate(_ call: CAPPluginCall) {
        do {
            try AVAudioSession.sharedInstance().setActive(
                false,
                options: .notifyOthersOnDeactivation
            )
            call.resolve()
        } catch {
            call.reject(
                "Failed to deactivate the voice audio session: \(error.localizedDescription)",
                Self.failureCode,
                error
            )
        }
    }

    // MARK: - describe

    /// Report how the shared `AVAudioSession` is currently configured.
    ///
    /// Read-only, and deliberately so. `WKWebView` configures the session for
    /// `getUserMedia` and whether it selected a voice-processing mode decides
    /// whether echo cancellation exists at all, but the web layer has no way to
    /// see that. Reading the category back answers the question without the
    /// reconfiguration that has broken capture on a handset twice.
    ///
    /// Resolves a dictionary of whatever the system reports. Every field is
    /// optional on the JS side, so a future OS that stops exposing one of these
    /// degrades to a smaller object rather than an error.
    @objc public func describe(_ call: CAPPluginCall) {
        let session = AVAudioSession.sharedInstance()
        let route = session.currentRoute
        call.resolve([
            "category": session.category.rawValue,
            "mode": session.mode.rawValue,
            "categoryOptions": Int(session.categoryOptions.rawValue),
            "outputs": route.outputs.map { $0.portType.rawValue },
            "inputs": route.inputs.map { $0.portType.rawValue },
            "sampleRate": session.sampleRate,
            "otherAudioPlaying": session.isOtherAudioPlaying,
        ])
    }

    // MARK: - System events

    /// Forward an audio-session interruption (an incoming phone call, Siri,
    /// another app taking the session) to JS as `voiceAudioInterruption`
    /// `{ type: "began" | "ended" }`.
    ///
    /// Apple's `.shouldResume` option is deliberately not forwarded: the web
    /// side ends the session on `began` and the user restarts explicitly, so
    /// there is never anything to resume.
    @objc private func handleInterruption(_ notification: Notification) {
        guard let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw)
        else { return }

        // `notifyListeners` walks the plugin's `eventListeners` dictionary,
        // which JS mutates on the main thread via `addListener`/
        // `removeListener`. `AVAudioSession` posts its notifications on an
        // arbitrary thread, so hop to main before touching it.
        let payload = ["type": type == .began ? "began" : "ended"]
        DispatchQueue.main.async { [weak self] in
            self?.notifyListeners(Self.interruptionEvent, data: payload)
        }
    }
}
