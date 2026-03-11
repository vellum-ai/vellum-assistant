#if canImport(UIKit)
import Foundation
import Combine
import os
import VellumAssistantShared

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "AmbientAgentManager")

/// Manages the Ride Shotgun / Ambient Agent lifecycle on iOS.
///
/// Mirrors the macOS `AmbientAgent` logic but uses SwiftUI sheets instead of
/// floating NSPanels, and triggers on app-idle time rather than system-idle time
/// (iOS doesn't expose a global idle timer).
@MainActor
final class AmbientAgentManager: ObservableObject {
    // MARK: - Published state consumed by ContentView

    /// Whether to show the invitation banner/sheet.
    @Published var showInvitation: Bool = false

    /// Non-nil while a session is in progress (drives the progress sheet).
    @Published var activeSession: RideShotgunSession?

    /// Non-nil after a session completes (drives the summary sheet).
    @Published var completedSummary: CompletedSummary?

    struct CompletedSummary: Identifiable {
        let id = UUID()
        let text: String
        let recordingId: String?
    }

    // MARK: - Internals

    private let trigger = RideShotgunTrigger()
    private var triggerCancellable: AnyCancellable?
    private var sessionCancellable: AnyCancellable?
    /// Tracks the delayed task that sets completedSummary so it can be cancelled
    /// if the manager transitions to a state where showing the old summary would
    /// be incorrect (e.g. teardown, cancel, or a new session starting).
    private var summaryTask: Task<Void, Never>?

    // MARK: - Setup / Teardown

    func setup() {
        // Watch the trigger for invitation signals.
        triggerCancellable = trigger.$shouldShowInvitation
            .removeDuplicates()
            .sink { [weak self] shouldShow in
                guard shouldShow else { return }
                Task { @MainActor in
                    self?.showInvitation = true
                }
            }
        trigger.start()
        log.info("AmbientAgentManager started")
    }

    func teardown() {
        trigger.stop()
        triggerCancellable?.cancel()
        triggerCancellable = nil
        sessionCancellable?.cancel()
        sessionCancellable = nil
        activeSession?.cancel()
        activeSession = nil
        summaryTask?.cancel()
        summaryTask = nil
        completedSummary = nil
        showInvitation = false
        log.info("AmbientAgentManager torn down")
    }

    // MARK: - Invitation responses

    /// User accepted the invitation — start a default 3-minute session.
    func acceptInvitation(daemonClient: any DaemonClientProtocol) {
        showInvitation = false
        trigger.recordSessionStarted()
        startSession(durationSeconds: 180, daemonClient: daemonClient)
    }

    /// User dismissed the invitation without engaging.
    func declineInvitation() {
        showInvitation = false
        trigger.recordDeclined()
        log.info("Ride shotgun invitation declined")
    }

    // MARK: - Session lifecycle

    func startSession(durationSeconds: Int, daemonClient: any DaemonClientProtocol) {
        guard activeSession == nil else {
            log.warning("Ride shotgun session already active")
            return
        }
        // Cancel any pending summary from a previous session before starting a
        // new one, so a stale summary sheet cannot appear on top of the new
        // session's progress sheet.
        summaryTask?.cancel()
        summaryTask = nil

        // iOS sends the ride_shotgun_start message to the Mac daemon,
        // which owns screen capture. The daemon will send back progress and
        // result messages over the same SSE connection.
        let session = RideShotgunSession(durationSeconds: durationSeconds)
        activeSession = session

        sessionCancellable = session.$state
            .removeDuplicates()
            .sink { [weak self] state in
                self?.handleSessionStateChange(state)
            }

        session.start(daemonClient: daemonClient)
        log.info("Ride shotgun session started: duration=\(durationSeconds)s")
    }

    func cancelSession() {
        activeSession?.cancel()
        activeSession = nil
        sessionCancellable?.cancel()
        sessionCancellable = nil
        summaryTask?.cancel()
        summaryTask = nil
        log.info("Ride shotgun session cancelled by user")
    }

    func stopSessionEarly() {
        activeSession?.stopEarly()
    }

    // MARK: - State transitions

    private func handleSessionStateChange(_ state: RideShotgunSession.State) {
        log.debug("Session state changed: \(String(describing: state))")
        switch state {
        case .complete:
            let summary = activeSession?.summary ?? ""
            let recordingId = activeSession?.recordingId

            activeSession = nil
            sessionCancellable?.cancel()
            sessionCancellable = nil

            let displayText: String
            if summary.isEmpty {
                displayText = "I watched but wasn't able to generate a report. No response was received from the daemon."
            } else if summary.hasPrefix("[error]") {
                let detail = String(summary.dropFirst("[error] ".count))
                displayText = "Something went wrong during analysis:\n\n\(detail)"
            } else {
                displayText = summary
            }
            trigger.recordCompleted()

            // SwiftUI cannot present a new sheet while another is being dismissed.
            // Setting completedSummary immediately after nil-ing activeSession would
            // race with the progress-sheet dismissal animation and the summary sheet
            // would be silently dropped on many iOS versions.  A short delay lets
            // the dismissal animation finish before we request the next presentation.
            let pendingSummary = CompletedSummary(text: displayText, recordingId: recordingId)
            summaryTask = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 600_000_000) // 0.6 s
                guard let self, !Task.isCancelled else { return }
                self.completedSummary = pendingSummary
            }

        case .failed(let reason):
            log.error("Ride shotgun session failed: \(reason)")
            activeSession = nil
            sessionCancellable?.cancel()
            sessionCancellable = nil

        case .cancelled:
            activeSession = nil
            sessionCancellable?.cancel()
            sessionCancellable = nil

        default:
            break
        }
    }
}
#endif
