import Foundation
import MetricKit
import os
import Sentry

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

    /// Serial queue that serialises all wasDisabled start/capture/flush/close cycles.
    ///
    /// Concurrent MetricKit callbacks (and `sendReport` on a detached task) may
    /// otherwise race on the global SentrySDK singleton: one thread reads
    /// `isEnabled=false` and calls `start()` while another calls `close()`, leaving
    /// the first thread's `capture()` hitting a closed SDK and silently dropping
    /// the event. Serialising through a dedicated queue prevents interleaving.
    /// Serial queue that serialises all wasDisabled start/capture/flush/close cycles.
    /// `nonisolated` so it can be accessed from nonisolated MXMetricManagerSubscriber
    /// delegate methods without crossing the @MainActor boundary.
    nonisolated static let sentrySerialQueue = DispatchQueue(
        label: "com.vellum.sentry-capture",
        qos: .utility
    )

    /// Captures a Sentry event while respecting the user's crash-reporting opt-out.
    ///
    /// If Sentry is currently closed, it is restarted with crash-handler and
    /// session-tracking disabled so only the explicit `capture(event:)` sends data.
    /// After flushing, the SDK is closed again to restore the opted-out state.
    /// All operations are serialised through `sentrySerialQueue` to prevent races
    /// when concurrent MetricKit callbacks or sendReport tasks interleave.
    ///
    /// Marked `nonisolated` so nonisolated delegate methods can call it directly.
    nonisolated static func captureSentryEvent(_ event: Event) {
        sentrySerialQueue.async {
            let wasDisabled = !SentrySDK.isEnabled
            if wasDisabled {
                SentrySDK.start { options in
                    options.dsn = "https://db2d38a082e4ee35eeaea08c44b376ec@o4504590528675840.ingest.us.sentry.io/4510874712276992"
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
        }
    }
}

extension MetricKitManager: MXMetricManagerSubscriber {
    nonisolated func didReceive(_ payloads: [MXMetricPayload]) {
        for payload in payloads {
            // Always log — regardless of opt-out preference.
            // Only use APIs available since macOS 12 (peakMemoryUsage,
            // cumulativeCPUTime) to ensure the code compiles on all supported
            // SDK versions. Hang and hitch metrics are captured via the diagnostics
            // delegate below, which uses hangDiagnostics (available on macOS 12+).
            let peakMemory = payload.memoryMetrics?.peakMemoryUsage.converted(to: .megabytes).value ?? 0
            let cpuTime = payload.cpuMetrics?.cumulativeCPUTime.converted(to: .seconds).value ?? 0

            Task { @MainActor in
                self.logger.info("MetricKit payload: peakMem=\(peakMemory, privacy: .public)MB cpu=\(cpuTime, privacy: .public)s")
            }

            // Forward to Sentry only if opted in and values are noteworthy.
            guard UserDefaults.standard.bool(forKey: "sendPerformanceReports") else { continue }
            guard peakMemory > 500 || cpuTime > 30 else { continue }

            let event = Event(level: .warning)
            event.message = SentryMessage(
                formatted: "MetricKit: peakMem=\(String(format: "%.0f", peakMemory))MB cpu=\(String(format: "%.1f", cpuTime))s"
            )
            event.tags = ["source": "metrickit_payload"]
            event.extra = [
                "peak_memory_mb": peakMemory,
                "cpu_time_s": cpuTime,
            ]
            MetricKitManager.captureSentryEvent(event)
        }
    }

    nonisolated func didReceive(_ diagnostics: [MXDiagnosticPayload]) {
        for payload in diagnostics {
            // Always log hang diagnostics (crash-adjacent)
            guard let hangs = payload.hangDiagnostics, !hangs.isEmpty else { continue }
            Task { @MainActor in
                self.logger.error("MetricKit hang diagnostic: \(hangs.count, privacy: .public) hang(s) reported")
            }

            // Only send to Sentry if crash reporting opted in
            guard UserDefaults.standard.bool(forKey: "sendPerformanceReports") else { continue }

            let event = Event(level: .warning)
            event.message = SentryMessage(formatted: "MetricKit hang diagnostic: \(hangs.count) hang(s)")
            event.tags = ["source": "metrickit_hang"]
            // Serialised through sentrySerialQueue to prevent concurrent races;
            // auto-capture is disabled when Sentry is temporarily restarted.
            MetricKitManager.captureSentryEvent(event)
        }
    }
}
