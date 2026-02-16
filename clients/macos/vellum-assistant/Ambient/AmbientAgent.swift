import Foundation
import VellumAssistantShared
import AppKit
import Combine
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AmbientAgent")

@MainActor
public final class AmbientAgent: ObservableObject {
    let knowledgeStore = KnowledgeStore()
    var daemonClient: DaemonClient?
    weak var appDelegate: AppDelegate?

    /// When a WatchSession is active (from chat-initiated watch), capture is skipped.
    var activeWatchSession: WatchSession?

    // Ride Shotgun
    let rideShotgunTrigger = RideShotgunTrigger()
    @Published var currentSession: RideShotgunSession?

    private var invitationWindow: RideShotgunInvitationWindow?
    private var progressWindow: RideShotgunProgressWindow?
    private var summaryWindow: RideShotgunSummaryWindow?
    private var triggerCancellable: AnyCancellable?
    private var sessionCancellable: AnyCancellable?

    var knowledge: KnowledgeStore { knowledgeStore }

    init() {}

    func setupRideShotgun() {
        // Subscribe to trigger's shouldShowInvitation
        triggerCancellable = rideShotgunTrigger.$shouldShowInvitation
            .removeDuplicates()
            .sink { [weak self] shouldShow in
                if shouldShow {
                    self?.showInvitation()
                }
            }
        rideShotgunTrigger.start()
    }

    func teardown() {
        rideShotgunTrigger.stop()
        currentSession?.cancel()
        currentSession = nil
        invitationWindow?.close()
        progressWindow?.close()
        summaryWindow?.close()
        triggerCancellable?.cancel()
        sessionCancellable?.cancel()
    }

    // MARK: - Ride Shotgun Flow

    func showInvitation() {
        guard invitationWindow == nil else { return }

        let window = RideShotgunInvitationWindow(
            onAccept: { [weak self] durationSeconds in
                self?.invitationWindow = nil
                self?.startRideShotgun(durationSeconds: durationSeconds)
            },
            onDecline: { [weak self] in
                self?.invitationWindow = nil
                self?.rideShotgunTrigger.recordDeclined()
            }
        )
        invitationWindow = window
        window.show()
    }

    func startRideShotgun(durationSeconds: Int) {
        guard let daemonClient else {
            log.warning("Cannot start ride shotgun: no daemon client")
            return
        }
        guard currentSession == nil else {
            log.warning("Ride shotgun session already active")
            return
        }

        rideShotgunTrigger.recordSessionStarted()

        let session = RideShotgunSession(durationSeconds: durationSeconds)
        currentSession = session

        // Observe session state changes
        sessionCancellable = session.$state
            .removeDuplicates()
            .sink { [weak self] state in
                self?.handleSessionStateChange(state)
            }

        session.start(daemonClient: daemonClient)
        showProgress()
    }

    func cancelRideShotgun() {
        currentSession?.cancel()
        progressWindow?.close()
        progressWindow = nil
        currentSession = nil
        sessionCancellable?.cancel()
        sessionCancellable = nil
    }

    private func handleSessionStateChange(_ state: RideShotgunSession.State) {
        switch state {
        case .complete:
            progressWindow?.close()
            progressWindow = nil
            if let summary = currentSession?.summary, !summary.isEmpty {
                showSummary(summary)
            }
            rideShotgunTrigger.recordCompleted()
            sessionCancellable?.cancel()
            sessionCancellable = nil

        case .failed(let reason):
            log.error("Ride shotgun session failed: \(reason)")
            progressWindow?.close()
            progressWindow = nil
            currentSession = nil
            sessionCancellable?.cancel()
            sessionCancellable = nil

        case .cancelled:
            progressWindow?.close()
            progressWindow = nil
            currentSession = nil
            sessionCancellable?.cancel()
            sessionCancellable = nil

        default:
            break
        }
    }

    // MARK: - Windows

    private func showProgress() {
        guard let session = currentSession else { return }
        let window = RideShotgunProgressWindow(
            session: session,
            onStop: { [weak self] in
                self?.cancelRideShotgun()
            }
        )
        progressWindow = window
        window.show()
    }

    private func showSummary(_ summary: String) {
        let window = RideShotgunSummaryWindow(
            summary: summary,
            onDismiss: { [weak self] in
                self?.summaryWindow = nil
                self?.currentSession = nil
            },
            onHelp: { [weak self] summary in
                self?.summaryWindow = nil
                self?.currentSession = nil
                self?.appDelegate?.startSession(task: summary)
            }
        )
        summaryWindow = window
        window.show()
    }

}
