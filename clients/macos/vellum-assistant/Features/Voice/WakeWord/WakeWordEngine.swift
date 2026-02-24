import Foundation

/// Protocol for wake word detection engines that process audio frames
/// and fire a callback when a keyword is detected.
protocol WakeWordEngine: AnyObject {
    /// Called on the audio thread when a wake word is detected.
    /// The parameter is the confidence score (0.0-1.0).
    var onWakeWordDetected: ((Float) -> Void)? { get set }

    /// Whether the engine is currently processing audio frames.
    var isRunning: Bool { get }

    /// Start the detection engine. Call before feeding audio frames.
    func start() throws

    /// Stop the detection engine and release resources.
    func stop()

    /// Process a single frame of Int16 PCM audio samples.
    func processAudioFrame(_ frame: [Int16])
}
