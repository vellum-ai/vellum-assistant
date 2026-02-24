import Foundation
import Combine
import os

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "WakeWordDismissHandler")

/// Handles dismissal of wake word activations: Escape key cancellation,
/// auto-cancel on silence, and cooldown to prevent rapid re-triggers.
@MainActor
final class WakeWordDismissHandler: ObservableObject {
    /// Duration to wait for speech after wake word detection before auto-cancelling.
    static let silenceTimeout: TimeInterval = 3.0
    /// Cooldown after a dismissal before accepting another wake word detection.
    static let cooldownDuration: TimeInterval = 2.0

    @Published private(set) var isInCooldown = false

    /// Total number of dismissals since app launch, useful for debugging.
    private(set) var dismissCount = 0

    /// Called when the handler dismisses an activation (Escape, silence, or programmatic).
    var onDismiss: (() -> Void)?

    private var silenceTimer: Task<Void, Never>?
    private var cooldownTimer: Task<Void, Never>?
    /// Whether an activation is currently in progress and can be dismissed.
    private var isActivationInProgress = false

    // MARK: - Activation Lifecycle

    /// Call when a wake word is detected and the system enters "activated" state.
    /// Starts the silence timeout to auto-cancel if no speech is detected.
    func activationStarted() {
        guard !isInCooldown else {
            log.debug("Ignoring activation during cooldown period")
            return
        }
        isActivationInProgress = true
        startSilenceTimer()
        log.debug("Activation started, silence timer running")
    }

    /// Call when speech is detected after activation. Cancels the silence timeout
    /// since the user is actively speaking.
    func speechDetected() {
        cancelSilenceTimer()
        log.debug("Speech detected, silence timer cancelled")
    }

    /// Call when the activation completes normally (speech was processed).
    /// No cooldown is applied for normal completions.
    func activationCompleted() {
        cancelSilenceTimer()
        isActivationInProgress = false
        log.debug("Activation completed normally")
    }

    /// Dismiss the current activation via Escape key or programmatic request.
    func dismiss() {
        guard isActivationInProgress else { return }
        performDismiss(reason: "user dismiss (Escape)")
    }

    // MARK: - Silence Handling

    private func startSilenceTimer() {
        cancelSilenceTimer()
        silenceTimer = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Self.silenceTimeout * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.handleSilenceTimeout()
        }
    }

    private func cancelSilenceTimer() {
        silenceTimer?.cancel()
        silenceTimer = nil
    }

    private func handleSilenceTimeout() {
        guard isActivationInProgress else { return }
        performDismiss(reason: "silence timeout (\(Self.silenceTimeout)s)")
    }

    // MARK: - Dismiss + Cooldown

    private func performDismiss(reason: String) {
        cancelSilenceTimer()
        isActivationInProgress = false
        dismissCount += 1
        log.info("Dismissed activation: \(reason) (total dismissals: \(self.dismissCount))")

        onDismiss?()
        startCooldown()
    }

    private func startCooldown() {
        cooldownTimer?.cancel()
        isInCooldown = true
        log.debug("Cooldown started (\(Self.cooldownDuration)s)")

        cooldownTimer = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Self.cooldownDuration * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.isInCooldown = false
            log.debug("Cooldown ended")
        }
    }
}
