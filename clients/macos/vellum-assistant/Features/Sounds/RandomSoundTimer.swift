import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "RandomSoundTimer")

/// Fires a random ambient sound at unpredictable intervals (5-30 minutes).
/// SoundManager handles the global and per-event enabled checks internally,
/// so the timer simply calls `play(.random)` on each tick.
@MainActor
final class RandomSoundTimer {
    static let shared = RandomSoundTimer()

    private var timer: Task<Void, Never>?

    /// Launches an async loop that sleeps for a random interval (5-30 min)
    /// and then plays the `.random` sound event. The loop continues until
    /// the task is cancelled.
    func start() {
        // Cancel any existing timer before starting a new one.
        timer?.cancel()

        timer = Task {
            while !Task.isCancelled {
                let interval = TimeInterval.random(in: 300...1800)
                log.debug("Next random sound in \(Int(interval))s")

                do {
                    try await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
                } catch {
                    // Task was cancelled during sleep.
                    break
                }

                guard !Task.isCancelled else { break }

                SoundManager.shared.play(.random)
            }
        }
    }

    /// Cancels the recurring timer task.
    func stop() {
        timer?.cancel()
        timer = nil
    }
}
