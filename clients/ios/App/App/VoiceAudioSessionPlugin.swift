import AVFoundation
import Capacitor

/// Capacitor plugin that puts the app's `AVAudioSession` into a voice-chat
/// configuration for the duration of a live-voice session, then restores it.
///
/// ## Why this exists
///
/// The web layer already asks for `echoCancellation: true` on `getUserMedia`
/// (`clients/web/src/utils/voice-input-device.ts`). In a WKWebView that ask is
/// necessary but not sufficient: the quality of the echo canceller WebKit gets
/// is decided by the *app's* audio-session category and mode, which only the
/// native side can set. With no configuration at all — the state this shell was
/// in before this plugin — iOS leaves the session in the default `.soloAmbient`
/// / `.default` pairing, which has no voice-processing path and routes playback
/// to the receiver rather than the speaker. The result is that the assistant
/// hears its own TTS through the speaker and barges in on itself (JARVIS-1364).
///
/// `.playAndRecord` + mode `.voiceChat` is the documented way to request the
/// voice-processing I/O path, which is what actually runs acoustic echo
/// cancellation against the far-end signal. `.defaultToSpeaker` keeps playback
/// on the loudspeaker (`.playAndRecord` otherwise prefers the receiver, which
/// makes a hands-free session unusable), and `.allowBluetooth` lets an HFP
/// headset carry both directions.
///
/// ## Lifecycle
///
/// `activate()` and `deactivate()` bracket the live-voice mic — the web side
/// calls them from `LiveVoiceAudioCapture` (`pcm-capture.ts`), which holds the
/// capture graph open for exactly the session's duration. Both are idempotent:
/// `activate()` on an already-active session re-asserts the configuration
/// (WebKit reconfigures the shared session when capture starts, so the web
/// layer deliberately calls it again once `getUserMedia` resolves), and
/// `deactivate()` without a prior `activate()` is a no-op.
///
/// The category/mode/options in place before the first `activate()` are saved
/// and restored on `deactivate()`, so ordinary media playback is never left
/// stuck in a duplex category once the call ends.
///
/// Capacitor dispatches each plugin's calls on its own serial queue, so
/// `savedConfiguration` needs no additional synchronization.
///
/// References:
/// - https://developer.apple.com/documentation/avfaudio/avaudiosession/category/playandrecord
/// - https://developer.apple.com/documentation/avfaudio/avaudiosession/mode/voicechat
/// - https://developer.apple.com/documentation/avfaudio/avaudiosession/categoryoptions/defaulttospeaker
@objc(VoiceAudioSessionPlugin)
public class VoiceAudioSessionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VoiceAudioSessionPlugin"
    public let jsName = "VoiceAudioSession"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "activate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deactivate", returnType: CAPPluginReturnPromise),
    ]

    /// Category, mode, and options as they were before the first `activate()`.
    /// `nil` means the session is not currently held by a live-voice session.
    private var savedConfiguration: (
        category: AVAudioSession.Category,
        mode: AVAudioSession.Mode,
        options: AVAudioSession.CategoryOptions
    )?

    /// `.allowBluetoothHFP` is the current spelling of what used to be
    /// `.allowBluetooth` — a pure rename (the old name is deprecated, not the
    /// behavior), so this still resolves at the iOS 15 deployment target.
    private static let categoryOptions: AVAudioSession.CategoryOptions = [
        .defaultToSpeaker,
        .allowBluetoothHFP,
    ]

    // MARK: - activate

    /// Configure and activate the voice-chat audio session. Safe to call while
    /// already active — it re-asserts the configuration.
    @objc public func activate(_ call: CAPPluginCall) {
        let session = AVAudioSession.sharedInstance()
        if savedConfiguration == nil {
            savedConfiguration = (session.category, session.mode, session.categoryOptions)
        }

        do {
            try session.setCategory(
                .playAndRecord,
                mode: .voiceChat,
                options: Self.categoryOptions
            )
            try session.setActive(true)
            call.resolve()
        } catch {
            // Leave `savedConfiguration` set: a partial application (category
            // took, activation failed) still needs restoring on deactivate.
            NSLog("[voice-audio-session] activate failed: \(error.localizedDescription)")
            call.reject("Failed to activate voice audio session: \(error.localizedDescription)")
        }
    }

    // MARK: - deactivate

    /// Restore the pre-session configuration and release the audio session.
    /// A no-op (resolving) when no `activate()` is outstanding.
    @objc public func deactivate(_ call: CAPPluginCall) {
        guard let saved = savedConfiguration else {
            call.resolve()
            return
        }
        savedConfiguration = nil

        let session = AVAudioSession.sharedInstance()
        // `.notifyOthersOnDeactivation` lets whatever we interrupted (music,
        // a podcast) resume instead of staying ducked after the call.
        do {
            try session.setActive(false, options: .notifyOthersOnDeactivation)
        } catch {
            // Non-fatal: another audio client may still be running. Restoring
            // the category below is the part that matters for later playback.
            NSLog("[voice-audio-session] deactivate failed: \(error.localizedDescription)")
        }
        do {
            try session.setCategory(saved.category, mode: saved.mode, options: saved.options)
        } catch {
            NSLog("[voice-audio-session] category restore failed: \(error.localizedDescription)")
        }
        call.resolve()
    }
}
