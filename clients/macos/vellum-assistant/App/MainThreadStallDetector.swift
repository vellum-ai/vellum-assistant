import Foundation
import os

/// Lightweight watchdog that detects main-thread stalls.
///
/// A background `DispatchSource` timer fires every 500ms and dispatches
/// a block to the main queue.  If the block runs >1 second late the main
/// thread was blocked — the detector logs a warning with the stall duration
/// so the event shows up in Console / OSLog / diagnostic exports.
///
/// Start once from `applicationDidFinishLaunching`; the detector runs for
/// the lifetime of the process with negligible overhead (<0.1% CPU).
final class MainThreadStallDetector {
    static let shared = MainThreadStallDetector()

    private let log = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant",
        category: "MainThreadStall"
    )

    private let queue = DispatchQueue(label: "com.vellum.stall-detector", qos: .utility)
    private var timer: DispatchSourceTimer?

    private init() {}

    func start() {
        guard timer == nil else { return }
        let source = DispatchSource.makeTimerSource(queue: queue)
        source.schedule(deadline: .now(), repeating: .milliseconds(500), leeway: .milliseconds(50))
        source.setEventHandler { [weak self] in
            self?.ping()
        }
        source.resume()
        timer = source
    }

    private func ping() {
        let scheduled = CFAbsoluteTimeGetCurrent()
        DispatchQueue.main.async { [weak self] in
            let delay = CFAbsoluteTimeGetCurrent() - scheduled
            if delay > 1.0 {
                self?.log.warning("Main thread stall detected: \(String(format: "%.1f", delay))s delay")
            }
        }
    }
}
