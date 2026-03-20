import Foundation
import MetricKit
import os
@preconcurrency import Sentry

@MainActor final class MetricKitManager: NSObject, ObservableObject {
    private let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant",
        category: "MetricKit"
    )

    override init() {
        super.init()
        MXMetricManager.shared.add(self)
    }

    deinit {
        MXMetricManager.shared.remove(self)
    }

    // MARK: - Sentry helpers

    /// Serial queue that serialises all Sentry SDK operations.
    ///
    /// `SentrySDK.close()` (called from privacy settings and AppDelegate),
    /// `captureSentryEvent`, and `sendManualReport` all touch the global
    /// SentrySDK singleton. Routing every operation through this queue prevents
    /// interleaving (e.g. a MetricKit callback racing with a user opt-out).
    ///
    /// `nonisolated` so it can be accessed from nonisolated delegate methods
    /// without crossing the @MainActor boundary.
    nonisolated static let sentrySerialQueue = DispatchQueue(
        label: "com.vellum.sentry-capture",
        qos: .utility
    )

    /// Captures a Sentry event only when the user has opted in.
    /// If Sentry is currently closed (user opted out), the event is silently
    /// dropped. Callers that need unconditional delivery (manual problem reports)
    /// should use `sendManualReport(_:)` instead.
    /// `nonisolated` so nonisolated delegate methods can call it directly.
    nonisolated static func captureSentryEvent(_ event: Event) {
        sentrySerialQueue.async {
            guard SentrySDK.isEnabled else { return }
            SentrySDK.capture(event: event)
        }
    }

    /// Data for Sentry's Feedback API, attached to the captured event.
    /// Sent via `SentrySDK.capture(feedback:)` so it appears in Sentry's
    /// "User Feedback" section linked to the event.
    struct UserFeedbackData: Sendable {
        let comments: String?
        let email: String?
        let name: String?
    }

    /// Maximum Sentry attachment size (100 MB). The SDK default is 20 MB,
    /// but workspace files included in log archives can exceed that. Sentry's
    /// server-side limit is 200 MB uncompressed / 40 MB compressed, so 100 MB
    /// provides sufficient headroom.
    nonisolated static let sentryMaxAttachmentSize: UInt = 100 * 1024 * 1024

    /// Default DSN for the macOS app Sentry project.
    nonisolated static let macosDSN = "https://c8d6b12505ab6b1785f0e82b5fb50662@o4504590528675840.ingest.us.sentry.io/4511015779696640"
    /// DSN for the assistant/brain Sentry project.
    nonisolated static let brainDSN = "https://db2d38a082e4ee35eeaea08c44b376ec@o4504590528675840.ingest.us.sentry.io/4510874712276992"

    /// Sends a manual problem report unconditionally, even when the user has
    /// opted out of automatic crash reporting.  The SDK is temporarily started
    /// with crash-handler and session-tracking disabled so only the explicit
    /// event is sent during the window — no automatic captures occur.
    /// All operations run on `sentrySerialQueue` to prevent races.
    /// `completion` is called on `sentrySerialQueue` after the flush finishes
    /// (or immediately if Sentry was already enabled and no flush is needed).
    /// `nonisolated` so the Settings sheet can call it from a detached Task.
    nonisolated static func sendManualReport(
        _ event: Event,
        attachments: [Attachment] = [],
        userFeedback: UserFeedbackData? = nil,
        dsn: String? = nil,
        completion: (@Sendable () -> Void)? = nil
    ) {
        sentrySerialQueue.async {
            let targetDSN = dsn ?? macosDSN
            let needsDSNSwitch = dsn != nil
            let wasEnabled = SentrySDK.isEnabled

            // When targeting a different DSN (e.g. brain project), close the
            // current SDK first so we can restart with the alternate DSN.
            if needsDSNSwitch && wasEnabled {
                SentrySDK.flush(timeout: 5)
                SentrySDK.close()
            }

            let needsStart = !SentrySDK.isEnabled
            if needsStart {
                let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown"
                let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "0"
                let commitSHA = Bundle.main.infoDictionary?["VellumCommitSHA"] as? String
                SentrySDK.start { options in
                    options.dsn = targetDSN
                    options.releaseName = "vellum-macos@\(version)"
                    options.dist = commitSHA ?? build
                    options.environment = SentryDeviceInfo.sentryEnvironment
                    options.sendDefaultPii = false
                    options.enableCrashHandler = false
                    options.enableAutoSessionTracking = false
                    options.maxAttachmentSize = sentryMaxAttachmentSize
                }
                SentryDeviceInfo.configureSentryScope()
            }

            // Attach files to the scope before capturing the event.
            if !attachments.isEmpty {
                SentrySDK.configureScope { scope in
                    for attachment in attachments {
                        scope.addAttachment(attachment)
                    }
                }
            }

            // Set reporter identity on the event so log reports are searchable
            // by email (user.email:foo@example.com) in Sentry. Only set for
            // manual reports where the user explicitly provided their email.
            if let feedbackData = userFeedback {
                let user = User()
                user.email = feedbackData.email
                user.name = feedbackData.name
                SentrySDK.setUser(user)
            }

            let eventId = SentrySDK.capture(event: event)

            // Send user feedback linked to the event so it appears in Sentry's
            // User Feedback section. This lets us associate user-provided context
            // (message, email, category) with the event without embedding PII in
            // event tags or extras.
            if let feedbackData = userFeedback {
                let feedback = SentryFeedback(
                    message: feedbackData.comments ?? "",
                    name: feedbackData.name,
                    email: feedbackData.email,
                    source: .custom,
                    associatedEventId: eventId
                )
                SentrySDK.capture(feedback: feedback)
            }

            // Clean up attachments so they don't leak into subsequent events.
            if !attachments.isEmpty {
                SentrySDK.configureScope { scope in
                    scope.clearAttachments()
                }
            }

            // Always flush when attachments are present so large files are
            // delivered before the user quits the app. Use a longer timeout
            // when attachments are present since companion archives (e.g.
            // spindump .tar.gz) can be several MB on slow connections.
            let flushTimeout: TimeInterval = attachments.isEmpty ? 5 : 15
            SentrySDK.flush(timeout: flushTimeout)

            // Clear reporter identity so it doesn't leak into subsequent events.
            if userFeedback != nil {
                SentrySDK.setUser(nil)
            }

            // Restore SDK state: if we switched DSN, close and restart
            // synchronously with the original DSN so no queued events are
            // dropped. If the SDK was originally disabled, just close it.
            if needsDSNSwitch {
                SentrySDK.close()
                if wasEnabled {
                    restartSentryInline()
                }
            } else if needsStart {
                // SDK was disabled before we started it — close the temp session.
                SentrySDK.close()
            }
            completion?()
        }
    }

    /// Closes the Sentry SDK through `sentrySerialQueue` to prevent races with
    /// concurrent `captureSentryEvent` or `sendManualReport` calls.
    /// Use this instead of calling `SentrySDK.close()` directly.
    /// `nonisolated` so AppDelegate and Settings code can call it without
    /// crossing the @MainActor boundary.
    nonisolated static func closeSentry() {
        sentrySerialQueue.async {
            SentrySDK.close()
        }
    }

    /// Restarts the Sentry SDK through `sentrySerialQueue`, mirroring the
    /// AppDelegate initialization options. Called when the user re-enables
    /// usage-data collection so Sentry resumes within the same app session
    /// without requiring a restart. No-op if the SDK is already enabled.
    /// `nonisolated` so Settings code can call it without crossing @MainActor.
    nonisolated static func startSentry() {
        sentrySerialQueue.async {
            restartSentryInline()
        }
    }

    /// Reports a daemon startup failure to Sentry for automatic triage.
    ///
    /// This covers cases where the daemon crashed before its own Sentry
    /// initialization, so the macOS client reports it on the daemon's behalf.
    /// Events are grouped by error category (MIGRATION_FAILED, PORT_IN_USE, etc.)
    /// using a custom fingerprint. Respects the `sendDiagnostics` privacy preference.
    nonisolated static func reportDaemonStartupFailure(_ error: DaemonStartupError) {
        let sendDiagnostics = UserDefaults.standard.object(forKey: "sendDiagnostics") as? Bool
            ?? true
        guard sendDiagnostics else { return }

        let event = Event(level: .error)
        event.message = SentryMessage(formatted: "Daemon startup failed: \(error.category)")
        event.tags = [
            "daemon_error_category": error.category,
        ]
        var extra: [String: Any] = [
            "error_message": error.message,
        ]
        if let detail = error.detail {
            extra["error_detail"] = detail
        }
        event.extra = extra
        event.fingerprint = ["daemon_startup_failure", error.category]
        captureSentryEvent(event)
    }

    /// Synchronous Sentry restart — must be called from `sentrySerialQueue`.
    /// Shared by `startSentry()` and inline DSN restoration in `sendManualReport`
    /// so no queued events are dropped between close and restart.
    private nonisolated static func restartSentryInline() {
        guard !SentrySDK.isEnabled else { return }
        let sendDiagnostics = UserDefaults.standard.object(forKey: "sendDiagnostics") as? Bool
            ?? true
        guard sendDiagnostics else { return }
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "0"
        let commitSHA = Bundle.main.infoDictionary?["VellumCommitSHA"] as? String
        SentrySDK.start { options in
            options.dsn = macosDSN
            options.releaseName = "vellum-macos@\(version)"
            options.dist = commitSHA ?? build
            options.environment = SentryDeviceInfo.sentryEnvironment
            options.debug = false
            options.tracesSampleRate = 0.1
            options.configureProfiling = { profilingOptions in
                profilingOptions.sessionSampleRate = 1.0
            }
            options.sendDefaultPii = false
            options.maxAttachmentSize = sentryMaxAttachmentSize
        }
        SentryDeviceInfo.configureSentryScope()
    }
}

extension MetricKitManager: MXMetricManagerSubscriber {
    // MXMetricPayload is iOS-only; macOS MetricKit only delivers diagnostic payloads.

    nonisolated func didReceive(_ diagnostics: [MXDiagnosticPayload]) {
        for payload in diagnostics {
            // Always log hang diagnostics (crash-adjacent)
            guard let hangs = payload.hangDiagnostics, !hangs.isEmpty else { continue }
            Task { @MainActor in
                self.logger.error("MetricKit hang diagnostic: \(hangs.count, privacy: .public) hang(s) reported")
            }

            // Only send to Sentry if sendDiagnostics is enabled.
            let sendDiagnostics = UserDefaults.standard.object(forKey: "sendDiagnostics") as? Bool
                ?? true
            guard sendDiagnostics else { continue }

            let event = Event(level: .warning)
            event.message = SentryMessage(formatted: "MetricKit hang diagnostic: \(hangs.count) hang(s)")
            event.tags = ["source": "metrickit_hang"]
            // Serialised through sentrySerialQueue to prevent concurrent races;
            // auto-capture is disabled when Sentry is temporarily restarted.
            MetricKitManager.captureSentryEvent(event)
        }
    }
}
