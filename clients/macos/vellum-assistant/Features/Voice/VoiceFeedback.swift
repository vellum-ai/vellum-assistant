import AppKit
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "VoiceFeedback")

/// Provides audio feedback for voice activation events (PTT).
/// Uses system sounds to keep the feedback subtle and respectful of user preferences.
enum VoiceFeedback {

    /// Play a short chime when voice mode activates.
    static func playActivationChime() {
        guard let sound = NSSound(named: "Tink") else {
            log.warning("System sound 'Tink' not available for activation chime")
            return
        }
        SoundManager.audioQueue.async { sound.play() }
        log.debug("Played activation chime")
    }

    /// Play a short chime when voice mode ends.
    static func playDeactivationChime() {
        guard let sound = NSSound(named: "Pop") else {
            log.warning("System sound 'Pop' not available for deactivation chime")
            return
        }
        SoundManager.audioQueue.async { sound.play() }
        log.debug("Played deactivation chime")
    }
}
