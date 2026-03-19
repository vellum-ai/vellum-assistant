import Foundation
import Testing
@testable import VellumAssistantLib

@Suite("MainThreadStallDetector")
struct MainThreadStallDetectorTests {

    // MARK: - Test Infrastructure

    /// Controllable clock for deterministic stall duration simulation.
    final class MockClock: @unchecked Sendable {
        private let lock = NSLock()
        private var _nanos: UInt64 = 1_000_000_000 // Start at 1s to avoid zero edge cases.

        var nanos: UInt64 {
            lock.lock()
            defer { lock.unlock() }
            return _nanos
        }

        func advance(by seconds: TimeInterval) {
            lock.lock()
            _nanos += UInt64(seconds * 1_000_000_000)
            lock.unlock()
        }
    }

    /// Records whether sampling was attempted and allows controlling success/failure.
    final class MockSampleRunner: MainThreadStallDetector.SampleRunner, @unchecked Sendable {
        private let lock = NSLock()
        private var _callCount = 0
        var shouldSucceed = true

        var callCount: Int {
            lock.lock()
            defer { lock.unlock() }
            return _callCount
        }

        func runSample(pid: Int32, outputURL: URL) -> Bool {
            lock.lock()
            _callCount += 1
            lock.unlock()
            return shouldSucceed
        }
    }

    /// Creates a detector with injected test dependencies.
    /// The `probeTargetQueue` is a suspended queue to simulate a wedged main thread
    /// (the probe callback never runs, so `probeInFlight` stays true).
    private func makeDetector(
        clock: MockClock,
        sampleRunner: MockSampleRunner,
        stageOneThreshold: TimeInterval = 2.0,
        stageTwoThreshold: TimeInterval = 5.0,
        samplingAllowed: Bool = true
    ) -> (detector: MainThreadStallDetector, blockedQueue: DispatchQueue) {
        let detector = MainThreadStallDetector(testInit: true)
        let outputDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("stall-test-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)
        detector.hangContextWriter = HangContextWriter(outputDirectory: outputDir, diagnosticsProvider: nil)
        detector.stageOneThreshold = stageOneThreshold
        detector.stageTwoThreshold = stageTwoThreshold
        detector.nowNanos = { clock.nanos }
        detector.sampleRunner = sampleRunner
        detector.isSamplingAllowed = { samplingAllowed }

        // Use a suspended queue to simulate a wedged main thread.
        // Probes dispatched here will never execute, keeping probeInFlight = true.
        let blockedQueue = DispatchQueue(label: "com.vellum.test.blocked-main")
        blockedQueue.suspend()
        detector.probeTargetQueue = blockedQueue

        return (detector, blockedQueue)
    }

    // MARK: - Stage One: Capture Before Recovery

    @Test
    func stageOneCaptureFiresWithoutRecovery() throws {
        let clock = MockClock()
        let sampleRunner = MockSampleRunner()
        let (detector, blockedQueue) = makeDetector(clock: clock, sampleRunner: sampleRunner)
        defer { blockedQueue.resume() }

        // First ping dispatches probe to the blocked queue.
        detector.queue.sync {
            detector.ping()
        }

        // Simulate 2.5 seconds passing without the probe running.
        clock.advance(by: 2.5)

        // Second ping sees the outstanding probe and triggers stage one.
        var hangContextWritten = false
        detector.queue.sync {
            detector.ping()
            let fileURL = detector.hangContextWriter.outputDirectory
                .appendingPathComponent("hang-context.json")
            hangContextWritten = FileManager.default.fileExists(atPath: fileURL.path)
        }

        #expect(hangContextWritten, "Stage one should write hang-context.json before main thread recovers")
        #expect(sampleRunner.callCount == 0, "Stage two sampling should not fire at 2.5s")
    }

    @Test
    func stageOneDoesNotFireBelowThreshold() throws {
        let clock = MockClock()
        let sampleRunner = MockSampleRunner()
        let (detector, blockedQueue) = makeDetector(clock: clock, sampleRunner: sampleRunner)
        defer { blockedQueue.resume() }

        detector.queue.sync {
            detector.ping()
        }

        // Only 1 second — below the 2s threshold.
        clock.advance(by: 1.0)

        detector.queue.sync {
            detector.ping()
        }

        let fileURL = detector.hangContextWriter.outputDirectory
            .appendingPathComponent("hang-context.json")
        let exists = FileManager.default.fileExists(atPath: fileURL.path)
        #expect(!exists, "Stage one should not fire below threshold")
    }

    @Test
    func stageOneCustomThreshold() throws {
        let clock = MockClock()
        let sampleRunner = MockSampleRunner()
        let (detector, blockedQueue) = makeDetector(
            clock: clock,
            sampleRunner: sampleRunner,
            stageOneThreshold: 0.5
        )
        defer { blockedQueue.resume() }

        detector.queue.sync {
            detector.ping()
        }

        clock.advance(by: 0.6)

        detector.queue.sync {
            detector.ping()
        }

        let fileURL = detector.hangContextWriter.outputDirectory
            .appendingPathComponent("hang-context.json")
        let exists = FileManager.default.fileExists(atPath: fileURL.path)
        #expect(exists, "Stage one should fire with custom 0.5s threshold")
    }

    // MARK: - Stage Two: Sampling

    @Test
    func stageTwoAttemptsSamplingOnce() throws {
        let clock = MockClock()
        let sampleRunner = MockSampleRunner()
        let (detector, blockedQueue) = makeDetector(clock: clock, sampleRunner: sampleRunner)
        defer { blockedQueue.resume() }

        detector.queue.sync {
            detector.ping()
        }

        // Advance past stage-two threshold.
        clock.advance(by: 5.5)

        detector.queue.sync {
            detector.ping()
        }

        #expect(sampleRunner.callCount == 1, "Stage two should attempt sampling exactly once")

        // Advance more — should NOT sample again.
        clock.advance(by: 2.0)

        detector.queue.sync {
            detector.ping()
        }

        #expect(sampleRunner.callCount == 1, "Stage two should not attempt sampling twice for the same stall")
    }

    @Test
    func stageTwoSamplingGatedOnSendDiagnostics() throws {
        let clock = MockClock()
        let sampleRunner = MockSampleRunner()
        let (detector, blockedQueue) = makeDetector(
            clock: clock,
            sampleRunner: sampleRunner,
            samplingAllowed: false
        )
        defer { blockedQueue.resume() }

        detector.queue.sync {
            detector.ping()
        }

        clock.advance(by: 6.0)

        detector.queue.sync {
            detector.ping()
        }

        #expect(sampleRunner.callCount == 0, "Sampling should be skipped when sendDiagnostics is disabled")

        // Hang context JSON should still be written even with diagnostics disabled.
        let fileURL = detector.hangContextWriter.outputDirectory
            .appendingPathComponent("hang-context.json")
        let exists = FileManager.default.fileExists(atPath: fileURL.path)
        #expect(exists, "Hang context JSON should always be written regardless of sendDiagnostics")
    }

    @Test
    func stageTwoSamplingFailureDoesNotCrash() throws {
        let clock = MockClock()
        let sampleRunner = MockSampleRunner()
        sampleRunner.shouldSucceed = false
        let (detector, blockedQueue) = makeDetector(clock: clock, sampleRunner: sampleRunner)
        defer { blockedQueue.resume() }

        detector.queue.sync {
            detector.ping()
        }

        clock.advance(by: 6.0)

        // This should not throw or deadlock.
        detector.queue.sync {
            detector.ping()
        }

        #expect(sampleRunner.callCount == 1, "Sampling was attempted despite expected failure")

        // Detector should still be operational after the failure.
        clock.advance(by: 2.0)

        detector.queue.sync {
            detector.ping()
        }

        #expect(sampleRunner.callCount == 1, "No additional sampling after failure")
    }

    // MARK: - Recovery and Re-detection

    @Test
    func stageOneOnlyFiresOncePerStall() throws {
        let clock = MockClock()
        let sampleRunner = MockSampleRunner()
        let (detector, blockedQueue) = makeDetector(clock: clock, sampleRunner: sampleRunner)
        defer { blockedQueue.resume() }

        // Dispatch probe.
        detector.queue.sync {
            detector.ping()
        }

        clock.advance(by: 3.0)

        detector.queue.sync {
            detector.ping()
        }

        let fileURL = detector.hangContextWriter.outputDirectory
            .appendingPathComponent("hang-context.json")
        #expect(FileManager.default.fileExists(atPath: fileURL.path))

        // Remove the file to verify stage one does not write it again.
        try? FileManager.default.removeItem(at: fileURL)

        // Continue stalling — stage one should not fire again.
        clock.advance(by: 1.0)
        detector.queue.sync {
            detector.ping()
        }

        let existsAfterRemoval = FileManager.default.fileExists(atPath: fileURL.path)
        #expect(!existsAfterRemoval, "Stage one should only fire once per stall")
    }

    // MARK: - Both Stages Fire on Prolonged Stall

    @Test
    func prolongedStallFiresBothStages() throws {
        let clock = MockClock()
        let sampleRunner = MockSampleRunner()
        let (detector, blockedQueue) = makeDetector(clock: clock, sampleRunner: sampleRunner)
        defer { blockedQueue.resume() }

        // Dispatch probe.
        detector.queue.sync {
            detector.ping()
        }

        // Advance past stage one.
        clock.advance(by: 2.5)
        detector.queue.sync {
            detector.ping()
        }

        let fileURL = detector.hangContextWriter.outputDirectory
            .appendingPathComponent("hang-context.json")
        #expect(FileManager.default.fileExists(atPath: fileURL.path), "Stage one should fire at 2.5s")
        #expect(sampleRunner.callCount == 0, "Stage two should not fire at 2.5s")

        // Advance past stage two.
        clock.advance(by: 3.0) // Total elapsed: 5.5s
        detector.queue.sync {
            detector.ping()
        }

        #expect(sampleRunner.callCount == 1, "Stage two should fire at 5.5s")
    }

    // MARK: - Content Safety

    @Test
    func hangContextJsonIsContentSafe() throws {
        let clock = MockClock()
        let sampleRunner = MockSampleRunner()
        let (detector, blockedQueue) = makeDetector(clock: clock, sampleRunner: sampleRunner)
        defer { blockedQueue.resume() }

        detector.queue.sync {
            detector.ping()
        }

        clock.advance(by: 3.0)

        detector.queue.sync {
            detector.ping()
        }

        let fileURL = detector.hangContextWriter.outputDirectory
            .appendingPathComponent("hang-context.json")
        let data = try Data(contentsOf: fileURL)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        // Must contain structural fields.
        #expect(json["stallStartTime"] != nil)
        #expect(json["stallDurationSeconds"] != nil)
        #expect(json["pid"] != nil)
        #expect(json["appVersion"] != nil)

        // Must NOT contain user-content keys.
        let forbiddenKeys = ["messageText", "text", "toolInput", "toolOutput",
                             "html", "surfaceHtml", "attachmentContent", "body"]
        for key in forbiddenKeys {
            #expect(json[key] == nil, "Hang context must not contain user-content key '\(key)'")
        }
    }
}
