import Foundation
import Combine
import AppKit
import os

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "WakeWordPrivacyGuard")

/// Monitors system state and automatically pauses/resumes wake word listening
/// for privacy. Pauses on screen lock, system sleep, and app termination;
/// resumes on unlock and wake.
@MainActor
final class WakeWordPrivacyGuard {
    private let audioMonitor: AlwaysOnAudioMonitor
    private var cancellables = Set<AnyCancellable>()
    /// Whether listening was active before a privacy pause, so we only resume if it was.
    private var wasListeningBeforePause = false

    init(audioMonitor: AlwaysOnAudioMonitor) {
        self.audioMonitor = audioMonitor
        observeSystemEvents()
    }

    deinit {
        // NotificationCenter observers are cleaned up via cancellables
    }

    // MARK: - System Event Observation

    private func observeSystemEvents() {
        let workspace = NSWorkspace.shared.notificationCenter

        // Screen sleep (display off / screensaver)
        workspace.publisher(for: NSWorkspace.screensDidSleepNotification)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                self?.handlePrivacyPause(reason: "screen sleep")
            }
            .store(in: &cancellables)

        // System sleep
        workspace.publisher(for: NSWorkspace.willSleepNotification)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                self?.handlePrivacyPause(reason: "system sleep")
            }
            .store(in: &cancellables)

        // Screen wake
        workspace.publisher(for: NSWorkspace.screensDidWakeNotification)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                self?.handlePrivacyResume(reason: "screen wake")
            }
            .store(in: &cancellables)

        // System wake
        workspace.publisher(for: NSWorkspace.didWakeNotification)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                self?.handlePrivacyResume(reason: "system wake")
            }
            .store(in: &cancellables)

        // Screen lock via DistributedNotificationCenter
        DistributedNotificationCenter.default().publisher(
            for: Notification.Name("com.apple.screenIsLocked")
        )
        .receive(on: DispatchQueue.main)
        .sink { [weak self] _ in
            self?.handlePrivacyPause(reason: "screen lock")
        }
        .store(in: &cancellables)

        // Screen unlock via DistributedNotificationCenter
        DistributedNotificationCenter.default().publisher(
            for: Notification.Name("com.apple.screenIsUnlocked")
        )
        .receive(on: DispatchQueue.main)
        .sink { [weak self] _ in
            self?.handlePrivacyResume(reason: "screen unlock")
        }
        .store(in: &cancellables)

        // App termination
        NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                self?.handleTermination()
            }
            .store(in: &cancellables)
    }

    // MARK: - Privacy Actions

    private func handlePrivacyPause(reason: String) {
        guard audioMonitor.isListening else { return }
        wasListeningBeforePause = true
        audioMonitor.stopMonitoring()
        log.info("Paused wake word listening: \(reason)")
    }

    private func handlePrivacyResume(reason: String) {
        guard wasListeningBeforePause else { return }
        wasListeningBeforePause = false
        audioMonitor.startMonitoring()
        log.info("Resumed wake word listening: \(reason)")
    }

    private func handleTermination() {
        audioMonitor.stopMonitoring()
        log.info("Stopped wake word listening: app terminating")
    }
}
