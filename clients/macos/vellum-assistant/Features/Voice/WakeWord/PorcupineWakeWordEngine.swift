import Foundation
import Porcupine
import os

/// Wake word detection engine backed by Picovoice Porcupine.
///
/// Uses the built-in "porcupine" keyword for initial development; a custom
/// "hey vellum" keyword can be swapped in later by changing the keyword enum.
final class PorcupineWakeWordEngine: WakeWordEngine {
    private let logger = Logger(subsystem: "com.vellum.vellum-assistant", category: "WakeWord")

    private var porcupine: Porcupine?
    private let sensitivity: Float32
    private(set) var isRunning = false

    var onWakeWordDetected: ((Float) -> Void)?

    /// - Parameter sensitivity: Detection sensitivity in [0, 1]. Higher values
    ///   reduce misses but increase false positives. Default 0.5.
    init(sensitivity: Float32 = 0.5) {
        self.sensitivity = sensitivity
    }

    func start() throws {
        guard !isRunning else { return }

        guard let accessKey = APIKeyManager.getKey(for: "picovoice") else {
            logger.error("No Picovoice access key found in keychain")
            throw WakeWordEngineError.missingAccessKey
        }

        do {
            porcupine = try Porcupine(
                accessKey: accessKey,
                keyword: Porcupine.BuiltInKeyword.porcupine,
                sensitivity: sensitivity
            )
            isRunning = true
            logger.info("Porcupine wake word engine started (sensitivity: \(self.sensitivity))")
        } catch {
            logger.error("Failed to initialize Porcupine: \(error.localizedDescription)")
            throw WakeWordEngineError.initializationFailed(error)
        }
    }

    func stop() {
        guard isRunning else { return }
        porcupine?.delete()
        porcupine = nil
        isRunning = false
        logger.info("Porcupine wake word engine stopped")
    }

    /// Process a single audio frame through Porcupine.
    ///
    /// Frames must contain exactly `Porcupine.frameLength` 16-bit PCM samples
    /// at `Porcupine.sampleRate` Hz (typically 512 samples at 16 kHz).
    ///
    /// - Parameter frame: Array of 16-bit PCM audio samples.
    func processAudioFrame(_ frame: [Int16]) {
        guard isRunning, let porcupine = porcupine else { return }

        do {
            let keywordIndex = try porcupine.process(pcm: frame)
            if keywordIndex >= 0 {
                // Porcupine doesn't expose a per-detection confidence score;
                // use the configured sensitivity as a proxy since detections
                // that pass the threshold are considered high-confidence.
                let confidence = sensitivity
                logger.info("Wake word detected (confidence proxy: \(confidence))")
                onWakeWordDetected?(confidence)
            }
        } catch {
            logger.error("Porcupine processing error: \(error.localizedDescription)")
        }
    }

    deinit {
        stop()
    }
}

enum WakeWordEngineError: Error, LocalizedError {
    case missingAccessKey
    case initializationFailed(Error)

    var errorDescription: String? {
        switch self {
        case .missingAccessKey:
            return "Picovoice access key not found. Set it via APIKeyManager."
        case .initializationFailed(let underlying):
            return "Failed to initialize wake word engine: \(underlying.localizedDescription)"
        }
    }
}
