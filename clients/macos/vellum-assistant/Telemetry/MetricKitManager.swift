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
        completion: (@Sendable () -> Void)? = nil
    ) {
        sentrySerialQueue.async {
            let wasDisabled = !SentrySDK.isEnabled
            if wasDisabled {
                SentrySDK.start { options in
                    options.dsn = "https://c8d6b12505ab6b1785f0e82b5fb50662@o4504590528675840.ingest.us.sentry.io/4511015779696640"
                    options.sendDefaultPii = false
                    // Disable crash capture and session tracking so the temporary
                    // restart only sends the explicit event, not incidental crashes.
                    options.enableCrashHandler = false
                    options.enableAutoSessionTracking = false
                }
            }
            SentrySDK.capture(event: event)
            if wasDisabled {
                SentrySDK.flush(timeout: 5)
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
            guard !SentrySDK.isEnabled else { return }
            // Defense-in-depth: respect the primary usage-data opt-out even if
            // the caller forgot to check. Prevents re-enabling Sentry after a
            // rapid toggle sequence (collectUsageData off → sendPerformanceReports change).
            let collectUsageData = UserDefaults.standard.object(forKey: "collectUsageDataEnabled") as? Bool ?? true
            guard collectUsageData else { return }
            let perfOptIn = UserDefaults.standard.bool(forKey: "sendPerformanceReports")
            SentrySDK.start { options in
                options.dsn = "https://c8d6b12505ab6b1785f0e82b5fb50662@o4504590528675840.ingest.us.sentry.io/4511015779696640"
                options.debug = false
                options.tracesSampleRate = 0.1
                options.profilesSampleRate = perfOptIn ? 1.0 : 0
                options.sendDefaultPii = false
            }
        }
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

            // Only send to Sentry if both opt-in flags are set.
            // collectUsageDataEnabled defaults to true when unset (matches the
            // daemon flag's defaultEnabled: true) so events are sent until the
            // user explicitly opts out, closing the startup-window gap.
            let collectUsageData = UserDefaults.standard.object(forKey: "collectUsageDataEnabled") as? Bool ?? true
            guard collectUsageData,
                  UserDefaults.standard.bool(forKey: "sendPerformanceReports") else { continue }

            let event = Event(level: .warning)
            event.message = SentryMessage(formatted: "MetricKit hang diagnostic: \(hangs.count) hang(s)")
            event.tags = ["source": "metrickit_hang"]
            // Serialised through sentrySerialQueue to prevent concurrent races;
            // auto-capture is disabled when Sentry is temporarily restarted.
            MetricKitManager.captureSentryEvent(event)
        }
    }
}
