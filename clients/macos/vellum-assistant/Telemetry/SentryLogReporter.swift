import Foundation
import OSLog
@preconcurrency import Sentry
import VellumAssistantShared

/// Periodically reads error- and fault-level entries from the unified log
/// for the current process and forwards them to Sentry as captured events.
///
/// This approach is completely non-invasive: existing `os.Logger` call sites
/// do not need any changes. The forwarder uses `OSLogStore` with
/// `.currentProcessIdentifier` scope, which requires no special entitlements.
///
/// Additionally installs the `ReportableLogger.errorReporter` callback so
/// that any code using `ReportableLogger` also flows into Sentry immediately.
///
/// Call `SentryLogReporter.start()` once at app startup (after `SentrySDK.start`).
final class SentryLogReporter: @unchecked Sendable {

    static let shared = SentryLogReporter()

    private let queue = DispatchQueue(label: "com.vellum.sentry-log-reporter", qos: .utility)
    private var timer: DispatchSourceTimer?
    private var lastCheckDate = Date()

    /// How often to poll OSLogStore for new error entries (seconds).
    private let pollInterval: TimeInterval = 10

    /// Seen message fingerprints within the current poll window to avoid
    /// sending the same error twice (e.g. rapid repeated failures).
    private var recentFingerprints = Set<String>()
    private let maxFingerprintCacheSize = 500

    /// Categories that already have explicit Sentry integration and should
    /// be skipped by the OSLogStore poller to avoid duplicate events.
    private let excludedCategories: Set<String> = [
        "MetricKit",       // MetricKitManager sends hang diagnostics directly
    ]

    private init() {}

    // MARK: - Public API

    /// Start the log forwarder. Safe to call multiple times (subsequent
    /// calls are no-ops).
    static func start() {
        shared.installReportableLoggerHook()
        shared.startPolling()
    }

    /// Stop the log forwarder. Called when the user disables diagnostics.
    static func stop() {
        ReportableLogger.errorReporter = nil
        shared.stopPolling()
    }

    // MARK: - ReportableLogger hook

    /// Wire up `ReportableLogger.errorReporter` so that new code using
    /// `ReportableLogger` captures to Sentry immediately (no polling delay).
    private func installReportableLoggerHook() {
        ReportableLogger.errorReporter = { message, category in
            // Record the fingerprint so pollForErrors() skips this entry
            // when it later reads the same message from OSLogStore.
            let fingerprint = "\(category):\(message)"
            SentryLogReporter.shared.queue.async {
                SentryLogReporter.shared.recentFingerprints.insert(fingerprint)
            }
            SentryLogReporter.captureToSentry(message: message, category: category)
        }
    }

    // MARK: - OSLogStore polling

    private func startPolling() {
        queue.async { [weak self] in
            guard let self, self.timer == nil else { return }
            self.lastCheckDate = Date()

            let timer = DispatchSource.makeTimerSource(queue: self.queue)
            timer.schedule(
                deadline: .now() + self.pollInterval,
                repeating: self.pollInterval
            )
            timer.setEventHandler { [weak self] in
                self?.pollForErrors()
            }
            timer.resume()
            self.timer = timer
        }
    }

    private func stopPolling() {
        queue.async { [weak self] in
            self?.timer?.cancel()
            self?.timer = nil
        }
    }

    private func pollForErrors() {
        guard SentrySDK.isEnabled else { return }

        do {
            let store = try OSLogStore(scope: .currentProcessIdentifier)
            let position = store.position(date: lastCheckDate)
            let cutoff = lastCheckDate
            lastCheckDate = Date()

            let predicate = NSPredicate(format: "messageType == %d OR messageType == %d",
                                        OSLogEntryLog.Level.error.rawValue,
                                        OSLogEntryLog.Level.fault.rawValue)

            let entries = try store.getEntries(at: position, matching: predicate)

            for case let entry as OSLogEntryLog in entries {
                // Skip entries from before our window (position is inclusive).
                guard entry.date > cutoff else { continue }

                // Skip categories that already send explicit Sentry events.
                guard !excludedCategories.contains(entry.category) else { continue }

                let message = entry.composedMessage
                guard !message.isEmpty else { continue }

                // Deduplicate within the poll window.
                let fingerprint = "\(entry.category):\(message)"
                guard !recentFingerprints.contains(fingerprint) else { continue }
                recentFingerprints.insert(fingerprint)

                Self.captureToSentry(
                    message: message,
                    category: entry.category,
                    level: entry.level == .fault ? .fatal : .error
                )
            }

            // Prevent unbounded fingerprint cache growth.
            if recentFingerprints.count > maxFingerprintCacheSize {
                recentFingerprints.removeAll()
            }
        } catch {
            // OSLogStore can throw on first access or when the log daemon is
            // busy. Silently retry on the next poll cycle.
        }
    }

    // MARK: - Sentry capture

    private static func captureToSentry(
        message: String,
        category: String,
        level: SentryLevel = .error
    ) {
        let event = Event(level: level)
        event.message = SentryMessage(formatted: "[\(category)] \(message)")
        event.tags = [
            "source": "error_log",
            "log_category": category,
        ]
        // Group by category + message prefix so repeated errors don't flood
        // Sentry with unique issues. Sentry uses the fingerprint array for
        // issue grouping.
        event.fingerprint = ["error_log", category, Self.messagePrefix(message)]
        MetricKitManager.captureSentryEvent(event)
    }

    /// Extract a stable prefix from the message for fingerprinting.
    /// Strips trailing dynamic content (UUIDs, numbers, paths) so that
    /// "Failed to load /path/a" and "Failed to load /path/b" group together.
    private static func messagePrefix(_ message: String) -> String {
        let maxLen = 80
        let truncated = message.count <= maxLen ? message : String(message.prefix(maxLen))
        // Replace common dynamic suffixes with a placeholder.
        return truncated
            .replacingOccurrences(
                of: #"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"#,
                with: "<uuid>",
                options: .regularExpression
            )
            .replacingOccurrences(
                of: #"\d{4,}"#,
                with: "<n>",
                options: .regularExpression
            )
    }
}
