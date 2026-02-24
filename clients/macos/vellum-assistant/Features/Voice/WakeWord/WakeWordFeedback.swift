import AppKit
import os

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "WakeWordFeedback")

/// Provides audio feedback for wake word detection events.
/// Uses system sounds to keep the feedback subtle and respectful of user preferences.
enum WakeWordFeedback {

    /// Play a short chime when the wake word is detected and voice mode activates.
    static func playActivationChime() {
        guard let sound = NSSound(named: "Tink") else {
            log.warning("System sound 'Tink' not available for activation chime")
            return
        }
        sound.play()
        log.debug("Played activation chime")
    }

    /// Play a short chime when voice mode ends and the app returns to passive listening.
    static func playDeactivationChime() {
        guard let sound = NSSound(named: "Pop") else {
            log.warning("System sound 'Pop' not available for deactivation chime")
            return
        }
        sound.play()
        log.debug("Played deactivation chime")
    }
}
