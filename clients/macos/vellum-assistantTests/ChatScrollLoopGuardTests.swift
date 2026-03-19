import XCTest
@testable import VellumAssistantLib

final class ChatScrollLoopGuardTests: XCTestCase {

    private var guard_: ChatScrollLoopGuard!
    private let conversationId = "test-conversation"

    override func setUp() {
        super.setUp()
        guard_ = ChatScrollLoopGuard()
    }

    override func tearDown() {
        guard_ = nil
        super.tearDown()
    }

    // MARK: - Normal Streaming Does Not Trip

    func testNormalStreamingDoesNotTrip() {
        // Simulate a normal streaming session: anchor updates arrive at a
        // reasonable rate (~10 per second) and scrollTo requests are sparse.
        var timestamp: TimeInterval = 1000.0
        let interval: TimeInterval = 0.1  // 10 events/sec

        for _ in 0..<20 {
            let result = guard_.record(
                .anchorPreferenceChange,
                conversationId: conversationId,
                timestamp: timestamp
            )
            XCTAssertNil(result, "Normal-rate anchor updates should not trip the guard")
            timestamp += interval
        }

        // A few scrollTo requests mixed in.
        for _ in 0..<5 {
            let result = guard_.record(
                .scrollToRequested,
                conversationId: conversationId,
                timestamp: timestamp
            )
            XCTAssertNil(result, "Sparse scrollTo requests should not trip the guard")
            timestamp += 0.3
        }
    }

    func testMixedEventsWithinThresholdsDoNotTrip() {
        var timestamp: TimeInterval = 1000.0

        // 30 anchor changes in 2 seconds (under 40 threshold)
        for _ in 0..<30 {
            let result = guard_.record(
                .anchorPreferenceChange,
                conversationId: conversationId,
                timestamp: timestamp
            )
            XCTAssertNil(result)
            timestamp += 2.0 / 30.0
        }

        // 10 scrollTo requests in 2 seconds (under 15 threshold)
        timestamp = 1000.0
        for _ in 0..<10 {
            let result = guard_.record(
                .scrollToRequested,
                conversationId: conversationId,
                timestamp: timestamp
            )
            XCTAssertNil(result)
            timestamp += 0.2
        }
    }

    // MARK: - Loop-Like Bursts Trip Once

    func testAnchorBurstTripsGuard() {
        var timestamp: TimeInterval = 1000.0
        var tripped = false

        // Fire 41 anchor updates in under 2 seconds (exceeds threshold of 40).
        for _ in 0..<45 {
            let result = guard_.record(
                .anchorPreferenceChange,
                conversationId: conversationId,
                timestamp: timestamp
            )
            if let snapshot = result {
                XCTAssertFalse(tripped, "Guard should trip exactly once per cooldown window")
                tripped = true
                XCTAssertEqual(snapshot.conversationId, conversationId)
                XCTAssertEqual(snapshot.trippedBy, .anchorPreferenceChange)
                XCTAssertEqual(snapshot.windowDuration, ChatScrollLoopGuard.windowDuration)
                XCTAssertGreaterThan(snapshot.counts[.anchorPreferenceChange] ?? 0, ChatScrollLoopGuard.anchorThreshold)
            }
            // ~22 events/sec = 45 events in ~2 seconds
            timestamp += 0.045
        }

        XCTAssertTrue(tripped, "Guard should have tripped for anchor burst")
    }

    func testScrollToBurstTripsGuard() {
        var timestamp: TimeInterval = 1000.0
        var tripped = false

        // Fire 16 scrollTo requests in under 2 seconds (exceeds threshold of 15).
        for _ in 0..<20 {
            let result = guard_.record(
                .scrollToRequested,
                conversationId: conversationId,
                timestamp: timestamp
            )
            if let snapshot = result {
                XCTAssertFalse(tripped, "Guard should trip exactly once per cooldown window")
                tripped = true
                XCTAssertEqual(snapshot.trippedBy, .scrollToRequested)
                XCTAssertGreaterThan(snapshot.counts[.scrollToRequested] ?? 0, ChatScrollLoopGuard.scrollToThreshold)
            }
            timestamp += 0.1
        }

        XCTAssertTrue(tripped, "Guard should have tripped for scrollTo burst")
    }

    func testOnlyOneWarningPerCooldownWindow() {
        var timestamp: TimeInterval = 1000.0
        var tripCount = 0

        // Rapidly fire anchor events well above threshold.
        for _ in 0..<100 {
            let result = guard_.record(
                .anchorPreferenceChange,
                conversationId: conversationId,
                timestamp: timestamp
            )
            if result != nil {
                tripCount += 1
            }
            // All within a 2-second window.
            timestamp += 0.02
        }

        XCTAssertEqual(tripCount, 1, "Should emit exactly one warning per cooldown window")
    }

    // MARK: - Cooldown and Re-arming

    func testGuardRearmsAfterQuietWindow() {
        var timestamp: TimeInterval = 1000.0
        var tripCount = 0

        // First burst: trip the guard.
        for _ in 0..<50 {
            if guard_.record(.anchorPreferenceChange, conversationId: conversationId, timestamp: timestamp) != nil {
                tripCount += 1
            }
            timestamp += 0.03
        }
        XCTAssertEqual(tripCount, 1, "First burst should trip once")

        // Wait for cooldown to expire (2 seconds of quiet).
        timestamp += ChatScrollLoopGuard.cooldownDuration + 0.1

        // Second burst: guard should re-arm and trip again.
        for _ in 0..<50 {
            if guard_.record(.anchorPreferenceChange, conversationId: conversationId, timestamp: timestamp) != nil {
                tripCount += 1
            }
            timestamp += 0.03
        }
        XCTAssertEqual(tripCount, 2, "Guard should re-arm and trip again after quiet window")
    }

    func testGuardDoesNotRearmDuringCooldown() {
        var timestamp: TimeInterval = 1000.0
        var tripCount = 0

        // Trip the guard.
        for _ in 0..<50 {
            if guard_.record(.anchorPreferenceChange, conversationId: conversationId, timestamp: timestamp) != nil {
                tripCount += 1
            }
            timestamp += 0.03
        }
        XCTAssertEqual(tripCount, 1)

        // Advance slightly but stay well within the cooldown window.
        // The trip fired at ~event 40 of the first burst, so elapsed time
        // from the trip is (remaining burst) + gap + (second burst).
        // Keep the total under cooldownDuration (2 s).
        timestamp += 0.1

        for _ in 0..<50 {
            if guard_.record(.anchorPreferenceChange, conversationId: conversationId, timestamp: timestamp) != nil {
                tripCount += 1
            }
            timestamp += 0.03
        }
        XCTAssertEqual(tripCount, 1, "Should not trip again during cooldown window")
    }

    // MARK: - Conversation Isolation

    func testSeparateConversationsAreIsolated() {
        var timestamp: TimeInterval = 1000.0
        let convA = "conversation-a"
        let convB = "conversation-b"

        // Trip guard for conversation A.
        for _ in 0..<50 {
            guard_.record(.anchorPreferenceChange, conversationId: convA, timestamp: timestamp)
            timestamp += 0.03
        }

        // Conversation B should not be affected — send a few events.
        let resultB = guard_.record(.anchorPreferenceChange, conversationId: convB, timestamp: timestamp)
        XCTAssertNil(resultB, "Conversation B should not trip from conversation A's events")
    }

    // MARK: - Reset

    func testResetClearsState() {
        var timestamp: TimeInterval = 1000.0

        // Trip the guard.
        for _ in 0..<50 {
            guard_.record(.anchorPreferenceChange, conversationId: conversationId, timestamp: timestamp)
            timestamp += 0.03
        }

        // Reset and immediately fire another burst — should trip again
        // because cooldown state was cleared.
        guard_.reset(conversationId: conversationId)

        var tripped = false
        for _ in 0..<50 {
            if guard_.record(.anchorPreferenceChange, conversationId: conversationId, timestamp: timestamp) != nil {
                tripped = true
            }
            timestamp += 0.03
        }
        XCTAssertTrue(tripped, "Guard should trip again after reset")
    }

    // MARK: - Repinning and Suppression Events

    func testRepinAndSuppressionEventsAreTracked() {
        var timestamp: TimeInterval = 1000.0

        // These event kinds don't have their own thresholds but should appear
        // in the aggregate snapshot when the guard trips.
        for _ in 0..<10 {
            guard_.record(.repinAttempt, conversationId: conversationId, timestamp: timestamp)
            timestamp += 0.02
        }
        for _ in 0..<5 {
            guard_.record(.suppressionFlip, conversationId: conversationId, timestamp: timestamp)
            timestamp += 0.02
        }

        // Now trip via anchor threshold.
        var snapshot: ChatScrollLoopGuard.AggregateSnapshot?
        for _ in 0..<50 {
            if let result = guard_.record(.anchorPreferenceChange, conversationId: conversationId, timestamp: timestamp) {
                snapshot = result
            }
            timestamp += 0.03
        }

        XCTAssertNotNil(snapshot, "Guard should trip")
        if let snapshot = snapshot {
            XCTAssertEqual(snapshot.counts[.repinAttempt], 10)
            XCTAssertEqual(snapshot.counts[.suppressionFlip], 5)
        }
    }

    // MARK: - Window Rolling Behavior

    func testEventsOutsideWindowAreExpired() {
        var timestamp: TimeInterval = 1000.0

        // Fire 30 anchor events.
        for _ in 0..<30 {
            guard_.record(.anchorPreferenceChange, conversationId: conversationId, timestamp: timestamp)
            timestamp += 0.05
        }

        // Advance past the window so those 30 events expire.
        timestamp += ChatScrollLoopGuard.windowDuration + 0.1

        // Fire 20 more — total in window is only 20 (under threshold).
        var tripped = false
        for _ in 0..<20 {
            if guard_.record(.anchorPreferenceChange, conversationId: conversationId, timestamp: timestamp) != nil {
                tripped = true
            }
            timestamp += 0.05
        }
        XCTAssertFalse(tripped, "Events outside the rolling window should not count")
    }

    // MARK: - Snapshot Fields

    func testSnapshotContainsCorrectFields() {
        var timestamp: TimeInterval = 42.0
        var snapshot: ChatScrollLoopGuard.AggregateSnapshot?

        for _ in 0..<50 {
            if let result = guard_.record(.anchorPreferenceChange, conversationId: "conv-123", timestamp: timestamp) {
                snapshot = result
            }
            timestamp += 0.03
        }

        XCTAssertNotNil(snapshot)
        if let s = snapshot {
            XCTAssertEqual(s.conversationId, "conv-123")
            XCTAssertEqual(s.windowDuration, ChatScrollLoopGuard.windowDuration)
            XCTAssertEqual(s.trippedBy, .anchorPreferenceChange)
            XCTAssertGreaterThanOrEqual(s.timestamp, 42.0)
        }
    }
}
