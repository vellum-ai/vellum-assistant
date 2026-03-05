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
            // Always log — regardless of opt-out preference
            let hangRate = payload.applicationResponsivenessMetrics?.hangRate?.averageMeasurement.converted(to: .percent).value ?? 0
            let scrollHitch = payload.animationMetrics?.scrollHitchTimeRatio?.averageMeasurement.converted(to: .milliseconds).value ?? 0
            let peakMemory = payload.memoryMetrics?.peakMemoryUsage.converted(to: .megabytes).value ?? 0
            let cpuTime = payload.cpuMetrics?.cumulativeCPUTime.converted(to: .seconds).value ?? 0

            Task { @MainActor in
                self.logger.info("MetricKit payload: hangRate=\(hangRate, privacy: .public)% scrollHitch=\(scrollHitch, privacy: .public)ms/s peakMem=\(peakMemory, privacy: .public)MB cpu=\(cpuTime, privacy: .public)s")
            }

            // Forward to Sentry only if opted in
            guard UserDefaults.standard.bool(forKey: "sendPerformanceReports") else { continue }

            // Only send noteworthy events to avoid flooding
            guard hangRate > 5 || scrollHitch > 50 else { continue }

            let crumb = Breadcrumb()
            crumb.category = "performance"
            crumb.level = .warning
            crumb.message = "MetricKit: hangRate=\(String(format: "%.1f", hangRate))% scrollHitch=\(String(format: "%.1f", scrollHitch))ms/s"
            crumb.data = [
                "hang_rate_percent": hangRate,
                "scroll_hitch_ms_per_s": scrollHitch,
                "peak_memory_mb": peakMemory,
                "cpu_time_s": cpuTime,
            ]
            SentrySDK.addBreadcrumb(crumb)
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
