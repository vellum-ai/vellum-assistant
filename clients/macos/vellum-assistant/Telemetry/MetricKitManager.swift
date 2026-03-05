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

            // Use a full Sentry event so performance data is visible in the Sentry
            // Issues dashboard — breadcrumbs are only attached to subsequent error
            // events and would not surface MetricKit metrics on their own.
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
            SentrySDK.capture(event: event)
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
            SentrySDK.capture(event: event)
        }
    }
}
