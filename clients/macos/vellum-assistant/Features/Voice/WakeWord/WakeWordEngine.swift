import Foundation

/// Protocol for wake word detection engines that manage their own audio
/// input and fire a callback when a keyword is detected.
protocol WakeWordEngine: AnyObject {
    /// Called when a wake word is detected.
    /// The parameter is the confidence score (0.0-1.0).
    var onWakeWordDetected: ((Float) -> Void)? { get set }

    /// Whether the engine is currently listening for the wake word.
    var isRunning: Bool { get }

    /// Start the detection engine (including audio capture).
    func start() throws

    /// Stop the detection engine and release resources.
    func stop()

    /// Update the keyword phrase and restart detection if running.
    func updateKeyword(_ keyword: String)
}
