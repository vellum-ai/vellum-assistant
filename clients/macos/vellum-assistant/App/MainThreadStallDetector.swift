import Foundation
import os

/// Lightweight watchdog that detects main-thread stalls with two-stage capture.
///
/// A background `DispatchSource` timer fires every 500ms and dispatches
/// a probe to the main queue. When a probe remains unacknowledged:
///
/// - **Stage 1** (>2s): Writes `hang-context.json` with diagnostic events
///   and transcript snapshots. This fires _before_ the main thread recovers,
///   while the stall is still in progress.
/// - **Stage 2** (>5s): Best-effort runs `/usr/bin/sample` to capture a
///   process sample alongside the hang context. Only the sampling step is
///   gated on the `sendDiagnostics` preference; the JSON hang context is
///   always written because it is content-safe and low cost.
///
/// Start once from `applicationDidFinishLaunching`; the detector runs for
/// the lifetime of the process with negligible overhead (<0.1% CPU).
final class MainThreadStallDetector {
    static let shared = MainThreadStallDetector()

    // MARK: - Configuration (injectable for tests)

    /// Duration in seconds before stage-one capture fires.
    var stageOneThreshold: TimeInterval = 2.0

    /// Duration in seconds before stage-two sampling fires.
    var stageTwoThreshold: TimeInterval = 5.0

    /// Closure that returns the current time as nanoseconds (monotonic).
    /// Tests inject a controllable clock; production uses `DispatchTime.now()`.
    var nowNanos: () -> UInt64 = { DispatchTime.now().uptimeNanoseconds }

    /// Writer used to persist hang context. Tests inject a mock.
    var hangContextWriter: HangContextWriter = HangContextWriter(
        diagnosticsProvider: MainActorDiagnosticsProvider()
    )

    /// Closure that returns whether `/usr/bin/sample` capture is allowed.
    /// Defaults to reading the `sendDiagnostics` user preference.
    var isSamplingAllowed: () -> Bool = {
        UserDefaults.standard.object(forKey: "sendDiagnostics") as? Bool ?? true
    }

    /// Process runner for `/usr/bin/sample`. Tests inject a mock.
    var sampleRunner: SampleRunner = DefaultSampleRunner()

    /// Queue used to dispatch sampling off the detector queue. Production uses
    /// a global utility queue; tests inject a serial queue they can drain.
    var samplingQueue: DispatchQueue = .global(qos: .utility)

    /// Queue used to dispatch probes. Production uses `DispatchQueue.main`;
    /// tests inject a suspended or separate queue to simulate a blocked main thread.
    var probeTargetQueue: DispatchQueue = .main

    // MARK: - Protocol for sample runner

    /// Abstraction over `/usr/bin/sample` for testability.
    protocol SampleRunner: Sendable {
        func runSample(pid: Int32, outputURL: URL) -> Bool
    }

    // MARK: - Private State

    private let log = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant",
        category: "MainThreadStall"
    )

    let queue = DispatchQueue(label: "com.vellum.stall-detector", qos: .utility)
    private var timer: DispatchSourceTimer?

    /// Nanos timestamp when the current probe was dispatched to main.
    /// Access only from `queue`.
    private var probeScheduledNanos: UInt64 = 0

    /// Whether a probe is currently waiting on the main queue.
    /// Access only from `queue`.
    private var probeInFlight = false

    /// Whether stage-one capture has fired for the current stall.
    /// Access only from `queue`.
    private var stageOneFired = false

    /// Whether stage-two sampling has been attempted for the current stall.
    /// Access only from `queue`.
    private var stageTwoFired = false

    private init() {}

    /// Test-only initializer for dependency injection.
    init(testInit: Bool) {}

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

    func stop() {
        timer?.cancel()
        timer = nil
    }

    // MARK: - Probe Logic

    func ping() {
        if probeInFlight {
            // Probe is still waiting on the target queue. Check stall duration.
            let elapsedNanos = nowNanos() - probeScheduledNanos
            let elapsed = Double(elapsedNanos) / 1_000_000_000
            checkStallStages(elapsed: elapsed)
            return
        }

        // Dispatch a new probe to the target queue (main in production).
        probeInFlight = true
        stageOneFired = false
        stageTwoFired = false
        probeScheduledNanos = nowNanos()

        let scheduledNanos = probeScheduledNanos
        probeTargetQueue.async { [weak self] in
            guard let self else { return }
            self.queue.async {
                let delayNanos = self.nowNanos() - scheduledNanos
                let delay = Double(delayNanos) / 1_000_000_000
                if delay > 1.0 {
                    self.log.warning("Main thread stall recovered: \(String(format: "%.1f", delay))s delay")
                }
                self.probeInFlight = false
            }
        }
    }

    /// Called from the detector's background queue when a probe is outstanding.
    /// Fires stage-one and stage-two captures at their respective thresholds.
    ///
    /// All writes are synchronous on the calling queue so the hang-context file
    /// exists immediately after this method returns. An async enrichment pass
    /// attempts to add diagnostic events from the main actor; if the main thread
    /// is wedged, the enrichment simply never completes.
    private func checkStallStages(elapsed: TimeInterval) {
        // Stage 1: Write hang-context.json synchronously.
        if !stageOneFired && elapsed >= stageOneThreshold {
            stageOneFired = true
            let stallStart = Date(timeIntervalSinceNow: -elapsed)
            log.warning("Stage 1 stall capture: main thread blocked for \(String(format: "%.1f", elapsed))s")
            hangContextWriter.writeHangContextSync(
                stallStartTime: stallStart,
                stallDurationSeconds: elapsed
            )
            // Best-effort: try to enrich with diagnostics from main actor.
            hangContextWriter.enrichWithDiagnosticsAsync(
                stallStartTime: stallStart,
                stallDurationSeconds: elapsed
            )
        }

        // Stage 2: Best-effort process sampling.
        if !stageTwoFired && elapsed >= stageTwoThreshold {
            stageTwoFired = true
            log.warning("Stage 2 stall capture: main thread blocked for \(String(format: "%.1f", elapsed))s")

            // Update hang context with the longer duration (synchronous).
            let stallStart = Date(timeIntervalSinceNow: -elapsed)
            hangContextWriter.writeHangContextSync(
                stallStartTime: stallStart,
                stallDurationSeconds: elapsed
            )

            // Gate sampling on sendDiagnostics preference.
            guard isSamplingAllowed() else {
                log.info("Skipping process sampling: sendDiagnostics is disabled")
                return
            }

            let pid = ProcessInfo.processInfo.processIdentifier
            let sampleURL = hangContextWriter.outputDirectory
                .appendingPathComponent("hang-sample.txt")
            // Run sampling off the detector queue to avoid blocking stall detection
            // for the ~3s duration of /usr/bin/sample. stageTwoFired prevents re-entry.
            let runner = sampleRunner
            samplingQueue.async { [log] in
                let success = runner.runSample(pid: pid, outputURL: sampleURL)
                if success {
                    log.info("Process sample written to hang-sample.txt")
                } else {
                    log.warning("Process sampling failed (non-fatal)")
                }
            }
        }
    }
}

// MARK: - Default Sample Runner

/// Production implementation that runs `/usr/bin/sample <pid> 3 1`.
struct DefaultSampleRunner: MainThreadStallDetector.SampleRunner {
    func runSample(pid: Int32, outputURL: URL) -> Bool {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/sample")
        process.arguments = ["\(pid)", "3", "1", "-file", outputURL.path]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
            return process.terminationStatus == 0
        } catch {
            return false
        }
    }
}
