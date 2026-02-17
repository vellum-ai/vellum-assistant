import Foundation
import VellumAssistantShared
import AppKit
import Combine
import UserNotifications
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
                    Task { @MainActor in
                        await self?.showInvitation()
                    }
                }
            }
        rideShotgunTrigger.start()
    }

    func pause() {
        rideShotgunTrigger.stop()
    }

    func resume() {
        rideShotgunTrigger.start()
    }

    func teardown() {
        rideShotgunTrigger.stop()
        currentSession?.cancel()
        currentSession = nil
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ["ride-shotgun-invitation"])
        progressWindow?.close()
        summaryWindow?.close()
        triggerCancellable?.cancel()
        sessionCancellable?.cancel()
    }

    // MARK: - Ride Shotgun Flow

    func showInvitation() async {
        // Check notification authorization; fall back to starting session directly
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        guard settings.authorizationStatus == .authorized else {
            log.warning("Notifications not authorized; falling back to direct ride shotgun session")
            startRideShotgun(durationSeconds: 60)
            return
        }

        let content = UNMutableNotificationContent()
        content.title = "Ride Shotgun"
        content.body = """
        I'll watch your screen briefly to learn how you work:
        • Pick up patterns in your workflow
        • Spot where I can save you time
        • Get context so my suggestions are relevant
        """
        content.categoryIdentifier = "RIDE_SHOTGUN"
        content.sound = .default

        let request = UNNotificationRequest(
            identifier: "ride-shotgun-invitation",
            content: content,
            trigger: nil
        )

        do {
            try await UNUserNotificationCenter.current().add(request)
            log.info("Posted ride shotgun invitation notification")
        } catch {
            log.error("Failed to post ride shotgun notification: \(error.localizedDescription)")
        }
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
        log.info("[SHOTGUN-DEBUG] handleSessionStateChange: \(String(describing: state))")
        switch state {
        case .complete:
            progressWindow?.close()
            progressWindow = nil
            let hasSession = currentSession != nil
            let summary = currentSession?.summary ?? ""
            log.info("[SHOTGUN-DEBUG] Session complete: hasSession=\(hasSession) summaryLength=\(summary.count)")
            showSummary(summary.isEmpty
                ? "I watched your screen but wasn't able to generate a report. This can happen if the analysis timed out or there was an API error."
                : summary)
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
