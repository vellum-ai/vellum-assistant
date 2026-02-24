import Foundation
import os

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "PorcupineWakeWordEngine")

/// Placeholder wake word engine backed by Porcupine.
///
/// Currently a stub that conforms to `WakeWordEngine` so that
/// `AlwaysOnAudioMonitor` and `WakeWordCoordinator` can be wired
/// end-to-end. Swap in real Porcupine SDK calls when the dependency
/// is integrated.
final class PorcupineWakeWordEngine: WakeWordEngine {

    var onWakeWordDetected: ((Float) -> Void)?

    private(set) var isRunning = false

    /// Detection sensitivity (0.0 = least sensitive, 1.0 = most sensitive).
    let sensitivity: Float

    init(sensitivity: Float = 0.5) {
        self.sensitivity = sensitivity
    }

    func start() throws {
        guard !isRunning else { return }
        isRunning = true
        log.info("PorcupineWakeWordEngine started (sensitivity: \(self.sensitivity))")
    }

    func stop() {
        guard isRunning else { return }
        isRunning = false
        log.info("PorcupineWakeWordEngine stopped")
    }

    /// Feed a buffer of 16-bit PCM audio samples for wake word detection.
    func process(pcm: [Int16]) {
        // Stub — real implementation will call Porcupine's process() here
    }
}
