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

        // 100 anchor changes in 2 seconds (under 150 threshold)
        for _ in 0..<100 {
            let result = guard_.record(
                .anchorPreferenceChange,
                conversationId: conversationId,
                timestamp: timestamp
            )
            XCTAssertNil(result)
            timestamp += 2.0 / 100.0
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

        // Fire 160 anchor updates in under 2 seconds (exceeds threshold of 150).
        for _ in 0..<160 {
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
            // 160 events in ~2 seconds = 80 events/sec
            timestamp += 0.0125
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
        for _ in 0..<200 {
            let result = guard_.record(
                .anchorPreferenceChange,
                conversationId: conversationId,
                timestamp: timestamp
            )
            if result != nil {
                tripCount += 1
            }
            // All within a 2-second window.
            timestamp += 0.01
        }

        XCTAssertEqual(tripCount, 1, "Should emit exactly one warning per cooldown window")
    }

    // MARK: - Cooldown and Re-arming

    func testGuardRearmsAfterQuietWindow() {
        var timestamp: TimeInterval = 1000.0
        var tripCount = 0

        // First burst: trip the guard with 160 events in <2 seconds.
        for _ in 0..<160 {
            if guard_.record(.anchorPreferenceChange, conversationId: conversationId, timestamp: timestamp) != nil {
                tripCount += 1
            }
            timestamp += 0.0125
        }
        XCTAssertEqual(tripCount, 1, "First burst should trip once")

        // Wait for cooldown to expire (2 seconds of quiet).
        timestamp += ChatScrollLoopGuard.cooldownDuration + 0.1

        // Second burst: guard should re-arm and trip again.
        for _ in 0..<160 {
            if guard_.record(.anchorPreferenceChange, conversationId: conversationId, timestamp: timestamp) != nil {
                tripCount += 1
            }
            timestamp += 0.0125
        }
        XCTAssertEqual(tripCount, 2, "Guard should re-arm and trip again after quiet window")
    }

    func testGuardDoesNotRearmDuringCooldown() {
        var timestamp: TimeInterval = 1000.0
        var tripCount = 0

        // Trip the guard with 160 events in <2 seconds.
        for _ in 0..<160 {
            if guard_.record(.anchorPreferenceChange, conversationId: conversationId, timestamp: timestamp) != nil {
                tripCount += 1
            }
            timestamp += 0.0125
        }
        XCTAssertEqual(tripCount, 1)

        // Advance slightly but stay well within the cooldown window.
        timestamp += 0.1

        for _ in 0..<160 {
            if guard_.record(.anchorPreferenceChange, conversationId: conversationId, timestamp: timestamp) != nil {
                tripCount += 1
            }
            timestamp += 0.005
        }
        XCTAssertEqual(tripCount, 1, "Should not trip again during cooldown window")
    }

    // MARK: - Conversation Isolation

    func testSeparateConversationsAreIsolated() {
        var timestamp: TimeInterval = 1000.0
        let convA = "conversation-a"
        let convB = "conversation-b"

        // Trip guard for conversation A with 160 events in <2 seconds.
        for _ in 0..<160 {
            guard_.record(.anchorPreferenceChange, conversationId: convA, timestamp: timestamp)
            timestamp += 0.0125
        }

        // Conversation B should not be affected — send a few events.
        let resultB = guard_.record(.anchorPreferenceChange, conversationId: convB, timestamp: timestamp)
        XCTAssertNil(resultB, "Conversation B should not trip from conversation A's events")
    }

    // MARK: - Reset

    func testResetClearsState() {
        var timestamp: TimeInterval = 1000.0

        // Trip the guard with 160 events in <2 seconds.
        for _ in 0..<160 {
            guard_.record(.anchorPreferenceChange, conversationId: conversationId, timestamp: timestamp)
            timestamp += 0.0125
        }

        // Reset and immediately fire another burst — should trip again
        // because cooldown state was cleared.
        guard_.reset(conversationId: conversationId)

        var tripped = false
        for _ in 0..<160 {
            if guard_.record(.anchorPreferenceChange, conversationId: conversationId, timestamp: timestamp) != nil {
                tripped = true
            }
            timestamp += 0.0125
        }
        XCTAssertTrue(tripped, "Guard should trip again after reset")
    }

    // MARK: - Repinning and Suppression Events

    func testRepinAndSuppressionEventsAreTracked() {
        var timestamp: TimeInterval = 1000.0

        // Fire anchor events and interleave repin/suppression events so they
        // all stay within the 2-second rolling window when the guard trips.
        var snapshot: ChatScrollLoopGuard.AggregateSnapshot?
        for i in 0..<160 {
            // Interleave repin events during the first 10 iterations.
            if i < 10 {
                guard_.record(.repinAttempt, conversationId: conversationId, timestamp: timestamp)
            }
            // Interleave suppression events during iterations 10-14.
            if i >= 10 && i < 15 {
                guard_.record(.suppressionFlip, conversationId: conversationId, timestamp: timestamp)
            }
            if let result = guard_.record(.anchorPreferenceChange, conversationId: conversationId, timestamp: timestamp) {
                snapshot = result
            }
            timestamp += 0.0125
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

        for _ in 0..<160 {
            if let result = guard_.record(.anchorPreferenceChange, conversationId: "conv-123", timestamp: timestamp) {
                snapshot = result
            }
            timestamp += 0.0125
        }

        XCTAssertNotNil(snapshot)
        if let s = snapshot {
            XCTAssertEqual(s.conversationId, "conv-123")
            XCTAssertEqual(s.windowDuration, ChatScrollLoopGuard.windowDuration)
            XCTAssertEqual(s.trippedBy, .anchorPreferenceChange)
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
            guard_.record(.anchorPreferenceChange, conversationId: conversationId, timestamp: timestamp)
            timestamp += 0.01
        }

        let counts = guard_.currentCounts(conversationId: conversationId, timestamp: timestamp)
        XCTAssertEqual(counts[.bodyEvaluation], 10)
        XCTAssertEqual(counts[.anchorPreferenceChange], 5)
        XCTAssertNil(counts[.scrollToRequested], "Unrecorded kinds should not appear")
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

    // MARK: - isTripped

    func testIsTrippedReturnsFalseForUnknownConversation() {
        XCTAssertFalse(guard_.isTripped(conversationId: "nonexistent"))
    }

    func testIsTrippedReturnsTrueAfterThresholdExceeded() {
        var timestamp: TimeInterval = 1000.0

        // Fire enough events to trip the guard (160 in <2 seconds).
        for _ in 0..<160 {
            guard_.record(.anchorPreferenceChange, conversationId: conversationId, timestamp: timestamp)
            timestamp += 0.0125
        }

        XCTAssertTrue(guard_.isTripped(conversationId: conversationId),
                       "isTripped should return true immediately after threshold is exceeded")
    }

    func testIsTrippedReturnsFalseAfterCooldownAndQuietWindow() {
        var timestamp: TimeInterval = 1000.0

        // Trip the guard with 160 events in <2 seconds.
        for _ in 0..<160 {
            guard_.record(.anchorPreferenceChange, conversationId: conversationId, timestamp: timestamp)
            timestamp += 0.0125
        }
        XCTAssertTrue(guard_.isTripped(conversationId: conversationId))

        // Advance past the cooldown duration with no events.
        timestamp += ChatScrollLoopGuard.cooldownDuration + 0.1

        // Record a single event to trigger the cooldown re-arm check.
        guard_.record(.anchorPreferenceChange, conversationId: conversationId, timestamp: timestamp)

        XCTAssertFalse(guard_.isTripped(conversationId: conversationId),
                        "isTripped should return false after cooldown expires and quiet window elapses")
    }

    // MARK: - Circuit Breaker: Trip → Suppression → Recovery

    func testTripSuppressesRequestsThenAutoRecovers() {
        var timestamp: TimeInterval = 1000.0

        // Phase 1: Trip the guard by exceeding the scrollTo threshold.
        var tripped = false
        for _ in 0..<20 {
            if guard_.record(.scrollToRequested, conversationId: conversationId, timestamp: timestamp) != nil {
                tripped = true
            }
            timestamp += 0.1
        }
        XCTAssertTrue(tripped, "Guard should trip from scrollTo burst")

        // Phase 2: Verify isTripped returns true — callers must early-return.
        XCTAssertTrue(guard_.isTripped(conversationId: conversationId),
                       "isTripped must return true while in cooldown")

        // Phase 3: Wire up recovery callback and verify it fires after cooldown.
        var recoveryConversationId: String?
        guard_.onRecoveryNeeded = { convId in
            recoveryConversationId = convId
        }

        // Advance past the cooldown duration with no events.
        timestamp += ChatScrollLoopGuard.cooldownDuration + 0.1

        // Record a single event to trigger cooldown expiry and auto-recovery.
        guard_.record(.anchorPreferenceChange, conversationId: conversationId, timestamp: timestamp)

        // Phase 4: Verify recovery fired and guard is no longer tripped.
        XCTAssertEqual(recoveryConversationId, conversationId,
                        "onRecoveryNeeded should fire with the correct conversation ID after cooldown")
        XCTAssertFalse(guard_.isTripped(conversationId: conversationId),
                        "isTripped should return false after cooldown recovery")

        // Phase 5: Verify the guard can trip again (re-armed).
        var trippedAgain = false
        for _ in 0..<20 {
            if guard_.record(.scrollToRequested, conversationId: conversationId, timestamp: timestamp) != nil {
                trippedAgain = true
            }
            timestamp += 0.1
        }
        XCTAssertTrue(trippedAgain, "Guard should re-arm and trip again after recovery")
    }

    // MARK: - Anchor Threshold Boundary Tests

    func testNormalFastScrollDoesNotTrip() {
        var timestamp: TimeInterval = 1000.0

        // Simulate normal fast scroll: 120 anchor events in 2 seconds (60/sec).
        // This is at the high end of normal scroll rates and should NOT trip
        // the guard (threshold is 150).
        for _ in 0..<120 {
            let result = guard_.record(
                .anchorPreferenceChange,
                conversationId: conversationId,
                timestamp: timestamp
            )
            XCTAssertNil(result, "Normal fast scroll at 60 events/sec should not trip the guard")
            timestamp += 2.0 / 120.0
        }
    }

    func testRunawayLoopTrips() {
        var timestamp: TimeInterval = 1000.0
        var tripped = false

        // Simulate a runaway layout loop: 200 anchor events in 2 seconds (100/sec).
        // This exceeds the threshold of 150 and should trip the guard.
        for _ in 0..<200 {
            let result = guard_.record(
                .anchorPreferenceChange,
                conversationId: conversationId,
                timestamp: timestamp
            )
            if let snapshot = result {
                XCTAssertFalse(tripped, "Guard should trip exactly once")
                tripped = true
                XCTAssertEqual(snapshot.trippedBy, .anchorPreferenceChange)
                XCTAssertGreaterThan(
                    snapshot.counts[.anchorPreferenceChange] ?? 0,
                    ChatScrollLoopGuard.anchorThreshold
                )
            }
            timestamp += 2.0 / 200.0
        }

        XCTAssertTrue(tripped, "Runaway loop at 100 events/sec should trip the guard")
    }

    func testRecoveryOnlyFiresOnce() {
        var timestamp: TimeInterval = 1000.0

        // Trip the guard with 160 events in <2 seconds.
        for _ in 0..<160 {
            guard_.record(.anchorPreferenceChange, conversationId: conversationId, timestamp: timestamp)
            timestamp += 0.0125
        }
        XCTAssertTrue(guard_.isTripped(conversationId: conversationId))

        var recoveryCount = 0
        guard_.onRecoveryNeeded = { _ in
            recoveryCount += 1
        }

        // First recovery after cooldown.
        timestamp += ChatScrollLoopGuard.cooldownDuration + 0.1
        guard_.record(.anchorPreferenceChange, conversationId: conversationId, timestamp: timestamp)
        XCTAssertEqual(recoveryCount, 1, "Recovery should fire exactly once")

        // Subsequent events should not re-fire recovery (no new trip).
        timestamp += 0.1
        guard_.record(.anchorPreferenceChange, conversationId: conversationId, timestamp: timestamp)
        XCTAssertEqual(recoveryCount, 1, "Recovery should not fire again without a new trip")
    }
}
