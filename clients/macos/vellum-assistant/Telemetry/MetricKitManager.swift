import Foundation
import MetricKit
import os
@preconcurrency import Sentry

@MainActor final class MetricKitManager: NSObject {
    private let logger = Logger(
        subsystem: Bundle.appBundleIdentifier,
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
    /// `SentrySDK.close()` (called from privacy settings and AppDelegate)
    /// and `captureSentryEvent` both touch the global SentrySDK singleton.
    /// Routing every operation through this queue prevents interleaving
    /// (e.g. a MetricKit callback racing with a user opt-out).
    ///
    /// `nonisolated` so it can be accessed from nonisolated delegate methods
    /// without crossing the @MainActor boundary.
    nonisolated static let sentrySerialQueue = DispatchQueue(
        label: "com.vellum.sentry-capture",
        qos: .utility
    )

    /// Captures a Sentry event only when the user has opted in.
    /// If Sentry is currently closed (user opted out), the event is silently
    /// dropped.
    /// `nonisolated` so nonisolated delegate methods can call it directly.
    nonisolated static func captureSentryEvent(_ event: Event) {
        sentrySerialQueue.async {
            guard SentrySDK.isEnabled else { return }
            SentrySDK.capture(event: event)
        }
    }

    /// Maximum Sentry attachment size (100 MB). The SDK default is 20 MB,
    /// but large log archives can exceed that. Sentry's server-side limit is
    /// 200 MB uncompressed / 40 MB compressed, so 100 MB provides sufficient
    /// headroom.
    nonisolated static let sentryMaxAttachmentSize: UInt = 100 * 1024 * 1024

    /// DSN for the macOS app Sentry project. Read from SENTRY_DSN_MACOS env var;
    /// empty string disables Sentry.
    nonisolated static let macosDSN: String =
        ProcessInfo.processInfo.environment["SENTRY_DSN_MACOS"] ?? ""

    /// Closes the Sentry SDK through `sentrySerialQueue` to prevent races with
    /// concurrent `captureSentryEvent` calls.
    /// Use this instead of calling `SentrySDK.close()` directly.
    /// `nonisolated` so AppDelegate and Settings code can call it without
    /// crossing the @MainActor boundary.
    nonisolated static func closeSentry() {
        SentryLogReporter.stop()
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
        SentryLogReporter.start()
    }

    /// Synchronous Sentry restart — must be called from `sentrySerialQueue`.
    private nonisolated static func restartSentryInline() {
        guard !SentrySDK.isEnabled else { return }
        let sendDiagnostics = UserDefaults.standard.object(forKey: "sendDiagnostics") as? Bool
            ?? true
        guard sendDiagnostics else { return }
        guard !macosDSN.isEmpty else { return }
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
