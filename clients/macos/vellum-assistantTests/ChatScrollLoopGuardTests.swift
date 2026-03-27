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
        // Simulate a normal streaming session: scrollTo requests are sparse.
        var timestamp: TimeInterval = 1000.0

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

        // 10 scrollTo requests in 2 seconds (under 15 threshold)
        for _ in 0..<10 {
            let result = guard_.record(
                .scrollToRequested,
                conversationId: conversationId,
                timestamp: timestamp
            )
            XCTAssertNil(result)
            timestamp += 0.2
        }

        // 20 body evaluations in 2 seconds (under 40 threshold)
        timestamp = 1000.0
        for _ in 0..<20 {
            let result = guard_.record(
                .bodyEvaluation,
                conversationId: conversationId,
                timestamp: timestamp
            )
            XCTAssertNil(result)
            timestamp += 0.1
        }
    }

    // MARK: - Loop-Like Bursts Trip Once

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

        // Rapidly fire scrollTo events well above threshold.
        for _ in 0..<30 {
            let result = guard_.record(
                .scrollToRequested,
                conversationId: conversationId,
                timestamp: timestamp
            )
            if result != nil {
                tripCount += 1
            }
            // All within a 2-second window.
            timestamp += 0.05
        }

        XCTAssertEqual(tripCount, 1, "Should emit exactly one warning per cooldown window")
    }

    // MARK: - Cooldown and Re-arming

    func testGuardRearmsAfterQuietWindow() {
        var timestamp: TimeInterval = 1000.0
        var tripCount = 0

        // First burst: trip the guard with 20 scrollTo events in <2 seconds.
        for _ in 0..<20 {
            if guard_.record(.scrollToRequested, conversationId: conversationId, timestamp: timestamp) != nil {
                tripCount += 1
            }
            timestamp += 0.1
        }
        XCTAssertEqual(tripCount, 1, "First burst should trip once")

        // Wait for cooldown to expire (2 seconds of quiet).
        timestamp += ChatScrollLoopGuard.cooldownDuration + 0.1

        // Second burst: guard should re-arm and trip again.
        for _ in 0..<20 {
            if guard_.record(.scrollToRequested, conversationId: conversationId, timestamp: timestamp) != nil {
                tripCount += 1
            }
            timestamp += 0.1
        }
        XCTAssertEqual(tripCount, 2, "Guard should re-arm and trip again after quiet window")
    }

    func testGuardDoesNotRearmDuringCooldown() {
        var timestamp: TimeInterval = 1000.0
        var tripCount = 0

        // Trip the guard with 20 scrollTo events in <2 seconds.
        for _ in 0..<20 {
            if guard_.record(.scrollToRequested, conversationId: conversationId, timestamp: timestamp) != nil {
                tripCount += 1
            }
            timestamp += 0.1
        }
        XCTAssertEqual(tripCount, 1)

        // Advance slightly but stay well within the cooldown window.
        timestamp += 0.1

        for _ in 0..<20 {
            if guard_.record(.scrollToRequested, conversationId: conversationId, timestamp: timestamp) != nil {
                tripCount += 1
            }
            timestamp += 0.05
        }
        XCTAssertEqual(tripCount, 1, "Should not trip again during cooldown window")
    }

    // MARK: - Conversation Isolation

    func testSeparateConversationsAreIsolated() {
        var timestamp: TimeInterval = 1000.0
        let convA = "conversation-a"
        let convB = "conversation-b"

        // Trip guard for conversation A with 20 scrollTo events in <2 seconds.
        for _ in 0..<20 {
            guard_.record(.scrollToRequested, conversationId: convA, timestamp: timestamp)
            timestamp += 0.1
        }

        // Conversation B should not be affected — send a few events.
        let resultB = guard_.record(.scrollToRequested, conversationId: convB, timestamp: timestamp)
        XCTAssertNil(resultB, "Conversation B should not trip from conversation A's events")
    }

    // MARK: - Reset

    func testResetClearsState() {
        var timestamp: TimeInterval = 1000.0

        // Trip the guard with 20 scrollTo events in <2 seconds.
        for _ in 0..<20 {
            guard_.record(.scrollToRequested, conversationId: conversationId, timestamp: timestamp)
            timestamp += 0.1
        }

        // Reset and immediately fire another burst — should trip again
        // because cooldown state was cleared.
        guard_.reset(conversationId: conversationId)

        var tripped = false
        for _ in 0..<20 {
            if guard_.record(.scrollToRequested, conversationId: conversationId, timestamp: timestamp) != nil {
                tripped = true
            }
            timestamp += 0.1
        }
        XCTAssertTrue(tripped, "Guard should trip again after reset")
    }

    // MARK: - Repinning and Suppression Events

    func testRepinAndSuppressionEventsAreTracked() {
        var timestamp: TimeInterval = 1000.0

        // Fire scrollTo events and interleave repin/suppression events so they
        // all stay within the 2-second rolling window when the guard trips.
        var snapshot: ChatScrollLoopGuard.AggregateSnapshot?
        for i in 0..<20 {
            // Interleave repin events during the first 5 iterations.
            if i < 5 {
                guard_.record(.repinAttempt, conversationId: conversationId, timestamp: timestamp)
            }
            // Interleave suppression events during iterations 5-7.
            if i >= 5 && i < 8 {
                guard_.record(.suppressionFlip, conversationId: conversationId, timestamp: timestamp)
            }
            if let result = guard_.record(.scrollToRequested, conversationId: conversationId, timestamp: timestamp) {
                snapshot = result
            }
            timestamp += 0.1
        }

        XCTAssertNotNil(snapshot, "Guard should trip")
        if let snapshot = snapshot {
            XCTAssertEqual(snapshot.counts[.repinAttempt], 5)
            XCTAssertEqual(snapshot.counts[.suppressionFlip], 3)
        }
    }

    // MARK: - Window Rolling Behavior

    func testEventsOutsideWindowAreExpired() {
        var timestamp: TimeInterval = 1000.0

        // Fire 10 scrollTo events.
        for _ in 0..<10 {
            guard_.record(.scrollToRequested, conversationId: conversationId, timestamp: timestamp)
            timestamp += 0.05
        }

        // Advance past the window so those 10 events expire.
        timestamp += ChatScrollLoopGuard.windowDuration + 0.1

        // Fire 10 more — total in window is only 10 (under threshold of 15).
        var tripped = false
        for _ in 0..<10 {
            if guard_.record(.scrollToRequested, conversationId: conversationId, timestamp: timestamp) != nil {
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

        for _ in 0..<20 {
            if let result = guard_.record(.scrollToRequested, conversationId: "conv-123", timestamp: timestamp) {
                snapshot = result
            }
            timestamp += 0.1
        }

        XCTAssertNotNil(snapshot)
        if let s = snapshot {
            XCTAssertEqual(s.conversationId, "conv-123")
            XCTAssertEqual(s.windowDuration, ChatScrollLoopGuard.windowDuration)
            XCTAssertEqual(s.trippedBy, .scrollToRequested)
            XCTAssertGreaterThanOrEqual(s.timestamp, 42.0)
        }
    }

    // MARK: - Body Evaluation Event Kind

    func testBodyEvaluationBurstTripsGuard() {
        var timestamp: TimeInterval = 1000.0
        var tripped = false

        // Fire 41 bodyEvaluation events in under 2 seconds (exceeds threshold of 40).
        for _ in 0..<45 {
            let result = guard_.record(
                .bodyEvaluation,
                conversationId: conversationId,
                timestamp: timestamp
            )
            if let snapshot = result {
                XCTAssertFalse(tripped)
                tripped = true
                XCTAssertEqual(snapshot.trippedBy, .bodyEvaluation)
                XCTAssertGreaterThan(snapshot.counts[.bodyEvaluation] ?? 0, ChatScrollLoopGuard.bodyEvaluationThreshold)
            }
            timestamp += 0.045
        }

        XCTAssertTrue(tripped, "Guard should have tripped for body evaluation burst")
    }

    func testBodyEvaluationNormalRateDoesNotTrip() {
        var timestamp: TimeInterval = 1000.0

        // 20 events in 2 seconds — under threshold of 40.
        for _ in 0..<20 {
            let result = guard_.record(
                .bodyEvaluation,
                conversationId: conversationId,
                timestamp: timestamp
            )
            XCTAssertNil(result)
            timestamp += 0.1
        }
    }

    func testBodyEvaluationCooldownRearms() {
        var timestamp: TimeInterval = 1000.0
        var tripCount = 0

        // Trip via bodyEvaluation.
        for _ in 0..<50 {
            if guard_.record(.bodyEvaluation, conversationId: conversationId, timestamp: timestamp) != nil {
                tripCount += 1
            }
            timestamp += 0.035
        }
        XCTAssertEqual(tripCount, 1, "First burst should trip once")

        // Wait for cooldown to expire.
        timestamp += ChatScrollLoopGuard.cooldownDuration + 0.1

        // Second burst: should re-arm and trip again.
        for _ in 0..<50 {
            if guard_.record(.bodyEvaluation, conversationId: conversationId, timestamp: timestamp) != nil {
                tripCount += 1
            }
            timestamp += 0.035
        }
        XCTAssertEqual(tripCount, 2, "Guard should re-arm and trip again after quiet window")
    }

    // MARK: - currentCounts

    func testCurrentCountsReturnsRollingCounts() {
        var timestamp: TimeInterval = 1000.0

        // Record a mix of events.
        for _ in 0..<10 {
            guard_.record(.bodyEvaluation, conversationId: conversationId, timestamp: timestamp)
            timestamp += 0.01
        }
        for _ in 0..<5 {
            guard_.record(.scrollToRequested, conversationId: conversationId, timestamp: timestamp)
            timestamp += 0.01
        }

        let counts = guard_.currentCounts(conversationId: conversationId, timestamp: timestamp)
        XCTAssertEqual(counts[.bodyEvaluation], 10)
        XCTAssertEqual(counts[.scrollToRequested], 5)
        XCTAssertNil(counts[.repinAttempt], "Unrecorded kinds should not appear")
    }

    func testCurrentCountsPrunesStaleEntries() {
        var timestamp: TimeInterval = 1000.0

        // Record events that will become stale.
        for _ in 0..<10 {
            guard_.record(.bodyEvaluation, conversationId: conversationId, timestamp: timestamp)
            timestamp += 0.01
        }

        // Advance past the 2-second window so all prior events are stale.
        timestamp += ChatScrollLoopGuard.windowDuration + 0.1

        // Record a few fresh events.
        for _ in 0..<3 {
            guard_.record(.bodyEvaluation, conversationId: conversationId, timestamp: timestamp)
            timestamp += 0.01
        }

        let counts = guard_.currentCounts(conversationId: conversationId, timestamp: timestamp)
        XCTAssertEqual(counts[.bodyEvaluation], 3, "Stale entries outside the window should be excluded")
    }

    func testCurrentCountsReturnsEmptyForUnknownConversation() {
        let counts = guard_.currentCounts(conversationId: "nonexistent")
        XCTAssertTrue(counts.isEmpty)
    }

    // MARK: - isTripped (Circuit Breaker)

    func testIsTrippedReturnsFalseBeforeTripping() {
        XCTAssertFalse(guard_.isTripped(conversationId: conversationId))
    }

    func testIsTrippedReturnsTrueAfterTripping() {
        var timestamp: TimeInterval = 1000.0

        // Trip the guard with a scrollTo burst.
        for _ in 0..<20 {
            guard_.record(.scrollToRequested, conversationId: conversationId, timestamp: timestamp)
            timestamp += 0.1
        }

        XCTAssertTrue(
            guard_.isTripped(conversationId: conversationId, timestamp: timestamp),
            "isTripped should return true during cooldown"
        )
    }

    func testIsTrippedReturnsFalseAfterCooldown() {
        var timestamp: TimeInterval = 1000.0

        // Trip the guard.
        for _ in 0..<20 {
            guard_.record(.scrollToRequested, conversationId: conversationId, timestamp: timestamp)
            timestamp += 0.1
        }

        // Advance past the cooldown window.
        timestamp += ChatScrollLoopGuard.cooldownDuration + 0.1

        XCTAssertFalse(
            guard_.isTripped(conversationId: conversationId, timestamp: timestamp),
            "isTripped should return false after quiet cooldown window"
        )
    }

    func testIsTrippedIsolatedByConversation() {
        var timestamp: TimeInterval = 1000.0

        // Trip the guard for conversation A.
        for _ in 0..<20 {
            guard_.record(.scrollToRequested, conversationId: "conv-a", timestamp: timestamp)
            timestamp += 0.1
        }

        XCTAssertTrue(guard_.isTripped(conversationId: "conv-a", timestamp: timestamp))
        XCTAssertFalse(
            guard_.isTripped(conversationId: "conv-b", timestamp: timestamp),
            "Unrelated conversation should not be tripped"
        )
    }

    // MARK: - ScrollTo Threshold Boundary Tests

    func testNormalScrollToRateDoesNotTrip() {
        var timestamp: TimeInterval = 1000.0

        // Simulate normal scroll rate: 10 scrollTo events in 2 seconds.
        // This is under the threshold of 15 and should NOT trip.
        for _ in 0..<10 {
            let result = guard_.record(
                .scrollToRequested,
                conversationId: conversationId,
                timestamp: timestamp
            )
            XCTAssertNil(result, "Normal scroll rate should not trip the guard")
            timestamp += 0.2
        }
    }

    func testRunawayScrollToTrips() {
        var timestamp: TimeInterval = 1000.0
        var tripped = false

        // Simulate a runaway scroll loop: 20 scrollTo events in 2 seconds.
        // This exceeds the threshold of 15 and should trip the guard.
        for _ in 0..<20 {
            let result = guard_.record(
                .scrollToRequested,
                conversationId: conversationId,
                timestamp: timestamp
            )
            if let snapshot = result {
                XCTAssertFalse(tripped, "Guard should trip exactly once")
                tripped = true
                XCTAssertEqual(snapshot.trippedBy, .scrollToRequested)
                XCTAssertGreaterThan(
                    snapshot.counts[.scrollToRequested] ?? 0,
                    ChatScrollLoopGuard.scrollToThreshold
                )
            }
            timestamp += 0.1
        }

        XCTAssertTrue(tripped, "Runaway scrollTo burst should trip the guard")
    }

}
