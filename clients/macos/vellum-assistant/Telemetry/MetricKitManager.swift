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
    static let sentrySerialQueue = DispatchQueue(
        label: "com.vellum.sentry-capture",
        qos: .utility
    )

    /// Captures a Sentry event while respecting the user's crash-reporting opt-out.
    ///
    /// If Sentry is currently closed, it is restarted with **all automatic capture
    /// disabled** — crash hooks, session tracking, OOM and watchdog termination —
    /// so only the explicit `capture(event:)` call sends data, not any incidental
    /// crash or session that occurs during the flush window. After flushing the
    /// event the SDK is closed again to restore the opted-out state.
    ///
    /// All operations are serialised through `sentrySerialQueue` to prevent races.
    static func captureSentryEvent(_ event: Event) {
        sentrySerialQueue.async {
            let wasDisabled = !SentrySDK.isEnabled
            if wasDisabled {
                SentrySDK.start { options in
                    options.dsn = "https://db2d38a082e4ee35eeaea08c44b376ec@o4504590528675840.ingest.us.sentry.io/4510874712276992"
                    options.sendDefaultPii = false
                    // Disable automatic capture — the user's crash-reporting opt-out
                    // must be respected even during the temporary restart window.
                    options.enableCrashHandler = false
                    options.enableAutoSessionTracking = false
                    options.enableOutOfMemoryTracking = false
                    options.enableWatchdogTerminationTracking = false
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
            // MXAppResponsivenessMetric.hangRate requires macOS 14+; guard with
            // @available so the property is not accessed on older OS versions.
            // hangRate is MXAverage<UnitDuration> — a hang duration per reporting
            // period, NOT a dimensionless ratio. Use .seconds (valid UnitDuration);
            // converting to .percent would crash because UnitDuration has no percent.
            // MXAppResponsivenessMetric.hangRate requires macOS 14+.
            let hangDurationSecs: Double
            if #available(macOS 14.0, *) {
                hangDurationSecs = payload.applicationResponsivenessMetrics?.hangRate?.averageMeasurement.converted(to: .seconds).value ?? 0
            } else {
                hangDurationSecs = 0
            }
            // scrollHitchTimeRatio is also MXAverage<UnitDuration>; .milliseconds is valid.
            let scrollHitchMs = payload.animationMetrics?.scrollHitchTimeRatio?.averageMeasurement.converted(to: .milliseconds).value ?? 0
            let peakMemory = payload.memoryMetrics?.peakMemoryUsage.converted(to: .megabytes).value ?? 0
            let cpuTime = payload.cpuMetrics?.cumulativeCPUTime.converted(to: .seconds).value ?? 0

            Task { @MainActor in
                self.logger.info("MetricKit payload: hangDuration=\(hangDurationSecs, privacy: .public)s scrollHitch=\(scrollHitchMs, privacy: .public)ms peakMem=\(peakMemory, privacy: .public)MB cpu=\(cpuTime, privacy: .public)s")
            }

            // Forward to Sentry only if opted in
            guard UserDefaults.standard.bool(forKey: "sendPerformanceReports") else { continue }

            // Only send noteworthy events: >500ms hang duration or >50ms hitch per scroll
            guard hangDurationSecs > 0.5 || scrollHitchMs > 50 else { continue }

            // Build event on the current (MetricKit callback) thread before handing
            // off to sentrySerialQueue. DispatchQueue.async has no Sendable constraint
            // so capturing the Event reference is safe.
            let event = Event(level: .warning)
            event.message = SentryMessage(
                formatted: "MetricKit: hangDuration=\(String(format: "%.2f", hangDurationSecs))s scrollHitch=\(String(format: "%.1f", scrollHitchMs))ms"
            )
            event.tags = ["source": "metrickit_payload"]
            event.extra = [
                "hang_duration_s": hangDurationSecs,
                "scroll_hitch_ms": scrollHitchMs,
                "peak_memory_mb": peakMemory,
                "cpu_time_s": cpuTime,
            ]
            // Serialised through sentrySerialQueue to prevent concurrent callbacks
            // from racing on SDK state; auto-capture is disabled when restarting.
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
