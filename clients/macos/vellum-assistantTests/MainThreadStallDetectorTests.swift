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

    /// Stub last-known diagnostics provider for tests. Returns a fixed snapshot.
    final class StubLastKnownProvider: HangContextWriter.LastKnownDiagnosticsProvider, @unchecked Sendable {
        private let lock = NSLock()
        private var _snapshot: LastKnownDiagnosticsSnapshot?

        var snapshot: LastKnownDiagnosticsSnapshot? {
            get {
                lock.lock()
                defer { lock.unlock() }
                return _snapshot
            }
            set {
                lock.lock()
                _snapshot = newValue
                lock.unlock()
            }
        }

        func lastKnownDiagnostics() -> LastKnownDiagnosticsSnapshot? {
            snapshot
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
        samplingAllowed: Bool = true,
        lastKnownProvider: HangContextWriter.LastKnownDiagnosticsProvider? = nil
    ) -> (detector: MainThreadStallDetector, blockedQueue: DispatchQueue, samplingQueue: DispatchQueue) {
        let detector = MainThreadStallDetector(testInit: true)
        let outputDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("stall-test-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)
        detector.hangContextWriter = HangContextWriter(
            outputDirectory: outputDir,
            diagnosticsProvider: nil,
            lastKnownProvider: lastKnownProvider
        )
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

        // Inject a serial sampling queue so tests can drain it before asserting.
        let samplingQueue = DispatchQueue(label: "com.vellum.test.sampling")
        detector.samplingQueue = samplingQueue

        return (detector, blockedQueue, samplingQueue)
    }

    // MARK: - Stage One: Capture Before Recovery

    @Test
    func stageOneCaptureFiresWithoutRecovery() throws {
        let clock = MockClock()
        let sampleRunner = MockSampleRunner()
        let (detector, blockedQueue, _) = makeDetector(clock: clock, sampleRunner: sampleRunner)
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
        let (detector, blockedQueue, _) = makeDetector(clock: clock, sampleRunner: sampleRunner)
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
        let (detector, blockedQueue, _) = makeDetector(
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
        let (detector, blockedQueue, samplingQueue) = makeDetector(clock: clock, sampleRunner: sampleRunner)
        defer { blockedQueue.resume() }

        detector.queue.sync {
            detector.ping()
        }

        // Advance past stage-two threshold.
        clock.advance(by: 5.5)

        detector.queue.sync {
            detector.ping()
        }

        // Drain the async sampling dispatch before asserting.
        samplingQueue.sync {}

        #expect(sampleRunner.callCount == 1, "Stage two should attempt sampling exactly once")

        // Advance more — should NOT sample again.
        clock.advance(by: 2.0)

        detector.queue.sync {
            detector.ping()
        }

        samplingQueue.sync {}

        #expect(sampleRunner.callCount == 1, "Stage two should not attempt sampling twice for the same stall")
    }

    @Test
    func stageTwoSamplingGatedOnSendDiagnostics() throws {
        let clock = MockClock()
        let sampleRunner = MockSampleRunner()
        let (detector, blockedQueue, _) = makeDetector(
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
        let (detector, blockedQueue, samplingQueue) = makeDetector(clock: clock, sampleRunner: sampleRunner)
        defer { blockedQueue.resume() }

        detector.queue.sync {
            detector.ping()
        }

        clock.advance(by: 6.0)

        // This should not throw or deadlock.
        detector.queue.sync {
            detector.ping()
        }

        // Drain the async sampling dispatch before asserting.
        samplingQueue.sync {}

        #expect(sampleRunner.callCount == 1, "Sampling was attempted despite expected failure")

        // Detector should still be operational after the failure.
        clock.advance(by: 2.0)

        detector.queue.sync {
            detector.ping()
        }

        samplingQueue.sync {}

        #expect(sampleRunner.callCount == 1, "No additional sampling after failure")
    }

    // MARK: - Recovery and Re-detection

    @Test
    func stageOneOnlyFiresOncePerStall() throws {
        let clock = MockClock()
        let sampleRunner = MockSampleRunner()
        let (detector, blockedQueue, _) = makeDetector(clock: clock, sampleRunner: sampleRunner)
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
        let (detector, blockedQueue, samplingQueue) = makeDetector(clock: clock, sampleRunner: sampleRunner)
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

        // Drain the async sampling dispatch before asserting.
        samplingQueue.sync {}

        #expect(sampleRunner.callCount == 1, "Stage two should fire at 5.5s")
    }

    // MARK: - Content Safety

    /// Recursively collects all keys from a JSON structure (dictionaries and arrays).
    private func allKeys(in value: Any) -> Set<String> {
        var keys = Set<String>()
        switch value {
        case let dict as [String: Any]:
            for (key, val) in dict {
                keys.insert(key)
                keys.formUnion(allKeys(in: val))
            }
        case let array as [Any]:
            for element in array {
                keys.formUnion(allKeys(in: element))
            }
        default:
            break
        }
        return keys
    }

    @Test
    func hangContextJsonIsContentSafe() throws {
        let clock = MockClock()
        let sampleRunner = MockSampleRunner()
        let (detector, blockedQueue, _) = makeDetector(clock: clock, sampleRunner: sampleRunner)
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

        // Must NOT contain user-content keys — check recursively through all
        // nested objects (e.g. recentDiagnosticEvents, transcriptSnapshots).
        let forbiddenKeys: Set<String> = [
            "messageText", "text", "toolInput", "toolOutput",
            "html", "surfaceHtml", "attachmentContent", "body",
        ]
        let presentKeys = allKeys(in: json)
        let violations = presentKeys.intersection(forbiddenKeys)
        #expect(violations.isEmpty, "Hang context must not contain user-content keys: \(violations.sorted())")
    }

    // MARK: - Sampling Disabled Flag

    @Test
    func samplingDisabledWritesSamplingSkippedFlag() throws {
        let clock = MockClock()
        let sampleRunner = MockSampleRunner()
        let (detector, blockedQueue, _) = makeDetector(
            clock: clock,
            sampleRunner: sampleRunner,
            samplingAllowed: false
        )
        defer { blockedQueue.resume() }

        detector.queue.sync {
            detector.ping()
        }

        // Advance past stage-two threshold so the sampling-disabled path runs.
        clock.advance(by: 6.0)

        detector.queue.sync {
            detector.ping()
        }

        let fileURL = detector.hangContextWriter.outputDirectory
            .appendingPathComponent("hang-context.json")
        let data = try Data(contentsOf: fileURL)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        // The samplingSkipped flag should be present and true.
        let samplingSkipped = json["samplingSkipped"] as? Bool
        #expect(samplingSkipped == true, "hang-context.json should contain samplingSkipped: true when sampling is disabled")

        // Sampling should not have been attempted.
        #expect(sampleRunner.callCount == 0, "Sampling should not be attempted when disabled")
    }

    @Test
    func samplingEnabledDoesNotWriteSamplingSkippedFlag() throws {
        let clock = MockClock()
        let sampleRunner = MockSampleRunner()
        let (detector, blockedQueue, samplingQueue) = makeDetector(
            clock: clock,
            sampleRunner: sampleRunner,
            samplingAllowed: true
        )
        defer { blockedQueue.resume() }

        detector.queue.sync {
            detector.ping()
        }

        clock.advance(by: 6.0)

        detector.queue.sync {
            detector.ping()
        }

        samplingQueue.sync {}

        let fileURL = detector.hangContextWriter.outputDirectory
            .appendingPathComponent("hang-context.json")
        let data = try Data(contentsOf: fileURL)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        // samplingSkipped should not be present (or should be null).
        let samplingSkipped = json["samplingSkipped"]
        let isAbsentOrNull = samplingSkipped == nil || samplingSkipped is NSNull
        #expect(isAbsentOrNull, "hang-context.json should not contain samplingSkipped when sampling is enabled")
    }

    // MARK: - Last-Known Diagnostics in Stage One

    @Test
    func stageOneIncludesLastKnownDiagnostics() throws {
        let clock = MockClock()
        let sampleRunner = MockSampleRunner()
        let lastKnownProvider = StubLastKnownProvider()

        // Seed the provider with a diagnostic event and transcript snapshot.
        let seedEvent = ChatDiagnosticEvent(
            id: "test-event-1",
            timestamp: Date(timeIntervalSince1970: 1000),
            kind: .scrollPositionChanged,
            conversationId: "conv-1",
            reason: "test breadcrumb"
        )
        let seedSnapshot = ChatTranscriptSnapshot(
            conversationId: "conv-1",
            capturedAt: Date(timeIntervalSince1970: 1000),
            messageCount: 5,
            toolCallCount: 2,
            isPinnedToBottom: true,
            isUserScrolling: false
        )
        lastKnownProvider.snapshot = LastKnownDiagnosticsSnapshot(
            capturedAt: Date(timeIntervalSince1970: 1000),
            recentEvents: [seedEvent],
            transcriptSnapshots: [seedSnapshot]
        )

        let (detector, blockedQueue, _) = makeDetector(
            clock: clock,
            sampleRunner: sampleRunner,
            lastKnownProvider: lastKnownProvider
        )
        defer { blockedQueue.resume() }

        // Dispatch probe.
        detector.queue.sync {
            detector.ping()
        }

        // Advance past stage-one threshold.
        clock.advance(by: 2.5)

        detector.queue.sync {
            detector.ping()
        }

        // Read and parse the hang-context.json.
        let fileURL = detector.hangContextWriter.outputDirectory
            .appendingPathComponent("hang-context.json")
        let data = try Data(contentsOf: fileURL)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        // The last-known diagnostics should be included in the stage-one write.
        let events = json["recentDiagnosticEvents"] as? [[String: Any]] ?? []
        #expect(!events.isEmpty, "Stage-one hang context should contain last-known diagnostic events")
        #expect(events[0]["id"] as? String == "test-event-1", "Event ID should match the seeded event")

        let snapshots = json["transcriptSnapshots"] as? [[String: Any]] ?? []
        #expect(!snapshots.isEmpty, "Stage-one hang context should contain last-known transcript snapshots")
        #expect(snapshots[0]["conversationId"] as? String == "conv-1", "Snapshot conversation ID should match")

        // lastKnownDiagnosticsCapturedAt should be present since we used the fallback.
        let capturedAt = json["lastKnownDiagnosticsCapturedAt"]
        #expect(capturedAt != nil && !(capturedAt is NSNull), "lastKnownDiagnosticsCapturedAt should be present when using fallback")
    }

    @Test
    func stageOneWithoutLastKnownProviderHasEmptyDiagnostics() throws {
        let clock = MockClock()
        let sampleRunner = MockSampleRunner()

        // No lastKnownProvider — simulates the case where the main actor
        // never gets a chance to populate diagnostics.
        let (detector, blockedQueue, _) = makeDetector(
            clock: clock,
            sampleRunner: sampleRunner
        )
        defer { blockedQueue.resume() }

        detector.queue.sync {
            detector.ping()
        }

        clock.advance(by: 2.5)

        detector.queue.sync {
            detector.ping()
        }

        let fileURL = detector.hangContextWriter.outputDirectory
            .appendingPathComponent("hang-context.json")
        let data = try Data(contentsOf: fileURL)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        // Without a last-known provider, events and snapshots should be empty arrays.
        let events = json["recentDiagnosticEvents"] as? [Any] ?? []
        #expect(events.isEmpty, "Stage-one should have empty events when no last-known provider exists")

        let snapshots = json["transcriptSnapshots"] as? [Any] ?? []
        #expect(snapshots.isEmpty, "Stage-one should have empty snapshots when no last-known provider exists")

        // lastKnownDiagnosticsCapturedAt should be absent or null.
        let capturedAt = json["lastKnownDiagnosticsCapturedAt"]
        let isAbsentOrNull = capturedAt == nil || capturedAt is NSNull
        #expect(isAbsentOrNull, "lastKnownDiagnosticsCapturedAt should be absent without a last-known provider")
    }
}
