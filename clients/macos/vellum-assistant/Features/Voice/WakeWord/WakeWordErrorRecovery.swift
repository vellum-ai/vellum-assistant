import Foundation
import Combine
import os

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "WakeWordErrorRecovery")

/// Handles automatic recovery from wake word engine errors: auto-restart on
/// engine failures, pause/resume on mic unavailability, and retry limits.
@MainActor
final class WakeWordErrorRecovery: ObservableObject {
    /// Delay before attempting to restart the engine after an error.
    static let restartDelay: TimeInterval = 5.0
    /// Maximum consecutive retries before giving up.
    static let maxRetries = 5

    @Published private(set) var hasGivenUp = false
    @Published private(set) var consecutiveErrors = 0

    /// Called when the engine has exceeded max retries and will not attempt further restarts.
    var onGaveUp: (() -> Void)?

    /// Error history for debugging, stores timestamps and descriptions.
    private(set) var errorHistory: [(date: Date, description: String)] = []

    private let engine: WakeWordEngine
    private var restartTask: Task<Void, Never>?

    init(engine: WakeWordEngine) {
        self.engine = engine
    }

    // MARK: - Error Handling

    /// Call when the wake word engine encounters an error.
    func handleEngineError(_ error: Error) {
        let description = error.localizedDescription
        errorHistory.append((date: Date(), description: description))
        consecutiveErrors += 1

        log.error("Wake word engine error (\(self.consecutiveErrors)/\(Self.maxRetries)): \(description)")

        if consecutiveErrors >= Self.maxRetries {
            giveUp()
        } else {
            scheduleRestart()
        }
    }

    /// Call when the microphone becomes unavailable (e.g., disconnected or claimed by another app).
    func handleMicUnavailable() {
        log.warning("Microphone unavailable, stopping engine")
        engine.stop()
        errorHistory.append((date: Date(), description: "Microphone unavailable"))
    }

    /// Call when the microphone becomes available again.
    func handleMicAvailable() {
        guard !hasGivenUp else {
            log.info("Mic available but engine has given up, not restarting")
            return
        }

        log.info("Microphone available, restarting engine")
        // Reset consecutive errors on mic restore since this is an external recovery
        consecutiveErrors = 0
        attemptRestart()
    }

    /// Call when the engine starts successfully to reset the error counter.
    func handleEngineStarted() {
        consecutiveErrors = 0
    }

    /// Reset the error state so the engine can be retried (e.g., after user intervention).
    func reset() {
        restartTask?.cancel()
        restartTask = nil
        consecutiveErrors = 0
        hasGivenUp = false
        log.info("Error recovery state reset")
    }

    // MARK: - Internal

    private func scheduleRestart() {
        restartTask?.cancel()
        log.info("Scheduling engine restart in \(Self.restartDelay)s")

        restartTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Self.restartDelay * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.attemptRestart()
        }
    }

    private func attemptRestart() {
        do {
            try engine.start()
            log.info("Engine restarted successfully")
            consecutiveErrors = 0
        } catch {
            log.error("Engine restart failed: \(error.localizedDescription)")
            handleEngineError(error)
        }
    }

    private func giveUp() {
        restartTask?.cancel()
        restartTask = nil
        hasGivenUp = true
        engine.stop()
        log.error("Gave up restarting engine after \(Self.maxRetries) consecutive failures")
        onGaveUp?()
    }
}
