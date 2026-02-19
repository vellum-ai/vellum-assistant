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
            log.warning("Notifications not authorized; falling back to direct ride shotgun session (default 3 min)")
            startRideShotgun(durationSeconds: 180)
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

    func startRideShotgun(durationSeconds: Int, mode: String? = nil, targetDomain: String? = nil) {
        guard let daemonClient else {
            log.warning("Cannot start ride shotgun: no daemon client")
            return
        }
        guard currentSession == nil else {
            log.warning("Ride shotgun session already active")
            return
        }

        rideShotgunTrigger.recordSessionStarted()

        let session = RideShotgunSession(durationSeconds: durationSeconds, mode: mode, targetDomain: targetDomain)
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

    func startLearnSession(targetDomain: String, durationSeconds: Int = 300) {
        Task { @MainActor in
            // Ensure Chrome is running with CDP so we can record network traffic
            await ensureChromeWithCDP()
            startRideShotgun(durationSeconds: durationSeconds, mode: "learn", targetDomain: targetDomain)
        }
    }

    /// Restart Chrome with CDP if it's not already available, or launch it if not running.
    private func ensureChromeWithCDP() async {
        // Check if CDP is already available
        if let url = URL(string: "http://localhost:9222/json/version"),
           let (_, response) = try? await URLSession.shared.data(from: url),
           let httpResponse = response as? HTTPURLResponse,
           httpResponse.statusCode == 200 {
            log.info("CDP already available, skipping Chrome restart")
            return
        }

        // Find running Chrome and restart it with CDP, or launch fresh
        if let chrome = ChromeAccessibilityHelper.findRunningChrome() {
            log.info("Restarting Chrome with CDP for learn session")
            let success = await ChromeAccessibilityHelper.restartChromeForCDP(app: chrome)
            if !success {
                log.warning("Chrome CDP restart failed, proceeding without network recording")
            }
        } else {
            // No Chrome running — launch it with CDP
            log.info("Launching Chrome with CDP for learn session")
            let config = NSWorkspace.OpenConfiguration()
            let chromeDataDir = NSHomeDirectory() + "/Library/Application Support/Google/Chrome-CDP"
                config.arguments = ["--remote-debugging-port=9222", "--force-renderer-accessibility", "--user-data-dir=\(chromeDataDir)"]
            config.activates = true
            if let chromeURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.google.Chrome") {
                _ = try? await NSWorkspace.shared.openApplication(at: chromeURL, configuration: config)
                // Wait for CDP to come up
                for _ in 0..<30 {
                    try? await Task.sleep(nanoseconds: 500_000_000)
                    if let url = URL(string: "http://localhost:9222/json/version"),
                       let (_, response) = try? await URLSession.shared.data(from: url),
                       let httpResponse = response as? HTTPURLResponse,
                       httpResponse.statusCode == 200 {
                        log.info("Chrome launched with CDP ready")
                        return
                    }
                }
                log.warning("Chrome launched but CDP not responding")
            } else {
                log.warning("Google Chrome not found")
            }
        }
    }

    func cancelRideShotgun() {
        currentSession?.cancel()
        progressWindow?.close()
        progressWindow = nil
        currentSession = nil
        sessionCancellable?.cancel()
        sessionCancellable = nil
    }

    /// Stop the session early but still finalize the recording and generate summary.
    func stopRideShotgunEarly() {
        currentSession?.stopEarly()
    }

    private func handleSessionStateChange(_ state: RideShotgunSession.State) {
        log.debug("handleSessionStateChange: \(String(describing: state))")
        switch state {
        case .complete:
            progressWindow?.close()
            progressWindow = nil
            let hasSession = currentSession != nil
            let summary = currentSession?.summary ?? ""
            let recordingId = currentSession?.recordingId
            log.debug("Session complete: hasSession=\(hasSession) summaryLength=\(summary.count) recordingId=\(recordingId ?? "nil")")
            if summary.isEmpty {
                showSummary("I watched your screen but wasn't able to generate a report. No response was received from the daemon.", recordingId: recordingId)
            } else if summary.hasPrefix("[error]") {
                let errorDetail = String(summary.dropFirst("[error] ".count))
                showSummary("Something went wrong during analysis:\n\n\(errorDetail)", recordingId: recordingId)
            } else {
                showSummary(summary, recordingId: recordingId)
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

    private func showSummary(_ summary: String, recordingId: String? = nil) {
        let window = RideShotgunSummaryWindow(
            summary: summary,
            recordingId: recordingId,
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
