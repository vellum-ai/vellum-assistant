import AppKit
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "VoiceFeedback")

/// Provides audio feedback for voice activation events (PTT).
/// Uses system sounds to keep the feedback subtle and respectful of user preferences.
enum VoiceFeedback {

    /// Serial background queue for voice feedback playback. `NSSound.play()` can
    /// block the calling thread for 2000ms+ during audio subsystem initialization;
    /// routing playback here keeps the main actor responsive.
    private static let audioQueue = DispatchQueue(
        label: "com.vellum.assistant.voice-feedback", qos: .userInitiated
    )

    /// Play a short chime when voice mode activates.
    static func playActivationChime() {
        guard let sound = NSSound(named: "Tink") else {
            log.warning("System sound 'Tink' not available for activation chime")
            return
        }
        audioQueue.async { sound.play() }
        log.debug("Played activation chime")
    }

    /// Play a short chime when voice mode ends.
    static func playDeactivationChime() {
        guard let sound = NSSound(named: "Pop") else {
            log.warning("System sound 'Pop' not available for deactivation chime")
            return
        }
        audioQueue.async { sound.play() }
        log.debug("Played deactivation chime")
    }
}
