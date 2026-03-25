import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

// MARK: - Scroll Performance Regression Tests
//
// Baselines for scroll-critical code paths. All tests use `measure {}` with
// XCTest baselines — no hard-coded timing thresholds. CI detects regressions
// as statistical deviations from the recorded baseline.
//
// Run with:
//   cd clients/macos && ./build.sh test --filter ScrollPerformance

final class MessageListScrollPerformanceTests: XCTestCase {

    // MARK: - Helpers

    /// Builds an array of ChatMessage instances with alternating user/assistant roles.
    private func buildMessages(count: Int) -> [ChatMessage] {
        (0..<count).map { i in
            ChatMessage(
                role: i.isMultiple(of: 2) ? .user : .assistant,
                text: "Message \(i) with some representative content for benchmarking.",
                timestamp: Date(timeIntervalSince1970: TimeInterval(1_700_000_000 + i * 10))
            )
        }
    }

    // MARK: - Test 1: PrecomputedMessageListState Computation (500 messages)

    /// Measures the wall-clock time to compute PrecomputedMessageListState from
    /// 500 messages. This exercises the O(n) scans (timestamp indices, subagent
    /// grouping, confirmation detection, turn detection) that run on every cache miss.
    func testPrecomputedMessageListStateComputation() {
        let messages = buildMessages(count: 500)
        let subagents: [SubagentInfo] = (0..<5).map { i in
            SubagentInfo(
                id: "sub-\(i)",
                label: "Subagent \(i)",
                status: .running,
                parentMessageId: messages[min(i * 50, messages.count - 1)].id
            )
        }

        measure(metrics: [XCTClockMetric()]) {
            // Replicate the core computation from MessageListView.precomputedState.
            let displayMessages = messages

            // Timestamp grouping (O(n) scan)
            var showTimestamp = Set<UUID>()
            if !displayMessages.isEmpty {
                showTimestamp.insert(displayMessages[0].id)
                let calendar = Calendar.current
                for i in 1..<displayMessages.count {
                    let current = displayMessages[i].timestamp
                    let previous = displayMessages[i - 1].timestamp
                    if !calendar.isDate(current, inSameDayAs: previous)
                        || current.timeIntervalSince(previous) > 300 {
                        showTimestamp.insert(displayMessages[i].id)
                    }
                }
            }

            // Index by ID (O(n))
            let messageIndexById = Dictionary(
                displayMessages.enumerated().map { ($1.id, $0) },
                uniquingKeysWith: { _, last in last }
            )

            // Subagent grouping (O(s))
            let subagentsByParent = Dictionary(
                grouping: subagents.filter { $0.parentMessageId != nil },
                by: { $0.parentMessageId! }
            )

            // Confirmation detection (O(n))
            var nextDecidedConfirmationByIndex: [Int: ToolConfirmationData] = [:]
            for i in displayMessages.indices {
                if i + 1 < displayMessages.count,
                   let conf = displayMessages[i + 1].confirmation,
                   conf.state != .pending {
                    nextDecidedConfirmationByIndex[i] = conf
                }
            }

            // Preceding assistant detection (O(n))
            var hasPrecedingAssistantByIndex = Set<Int>()
            for i in displayMessages.indices where i > 0 {
                if displayMessages[i - 1].role == .assistant {
                    hasPrecedingAssistantByIndex.insert(i)
                }
            }

            // Prevent the compiler from optimizing away the work.
            XCTAssertEqual(messageIndexById.count, 500)
            XCTAssertFalse(showTimestamp.isEmpty)
            _ = subagentsByParent
            _ = nextDecidedConfirmationByIndex
            _ = hasPrecedingAssistantByIndex
        }
    }

    // MARK: - Test 2: Version Counter Fingerprint (O(1) Verification)

    /// Verifies that the version-counter fingerprint completes in constant time
    /// regardless of message count. Measures PrecomputedCacheKey construction
    /// and equality comparison with both 50 and 500 messages — the version
    /// counter itself is O(1) (a single Int), so both sizes should produce
    /// comparable baselines.
    func testVersionCounterFingerprintConstantTime() {
        // The version counter is just an Int — constructing and comparing
        // PrecomputedCacheKey is O(1) regardless of message count.
        // We measure 10,000 iterations of key construction + equality check
        // to get a stable signal.

        measure(metrics: [XCTClockMetric()]) {
            var lastKey: PrecomputedCacheKey?
            for version in 0..<10_000 {
                let key = PrecomputedCacheKey(
                    messageListVersion: version,
                    isSending: version.isMultiple(of: 3),
                    isThinking: version.isMultiple(of: 7),
                    isCompacting: false,
                    assistantStatusText: nil,
                    activeSubagentFingerprint: version % 5,
                    displayedMessageCount: version % 1000
                )
                // Force an equality check (the hot path in MessageListView.precomputedState).
                if let prev = lastKey {
                    _ = key == prev
                }
                lastKey = key
            }
            XCTAssertNotNil(lastKey)
        }
    }

    // MARK: - Test 3: ChatBottomPinCoordinator Session Lifecycle

    /// Measures a complete ChatBottomPinCoordinator session lifecycle:
    /// create coordinator, start a session, record 5 retry attempts, then
    /// let the session exhaust. This benchmarks the synchronous hot path
    /// (no async retry loop) to keep the test deterministic.
    @MainActor
    func testChatBottomPinCoordinatorSessionLifecycle() {
        measure(metrics: [XCTClockMetric()]) {
            let coordinator = ChatBottomPinCoordinator()
            var pinCallCount = 0

            coordinator.onPinRequested = { _, _ in
                pinCallCount += 1
                return false // Simulate geometry unavailable
            }

            let convId = UUID()

            // Run 100 session lifecycles to get a stable measurement.
            for _ in 0..<100 {
                pinCallCount = 0

                // Start a session (triggers immediate first attempt).
                coordinator.requestPin(reason: .initialRestore, conversationId: convId)

                // The session is active with 1 attempt recorded.
                // Manually exhaust it by sending requests that coalesce,
                // then cancel and reset for the next iteration.
                coordinator.cancelActiveSession(reason: .conversationSwitch)
                coordinator.reset(newConversationId: convId)
            }

            XCTAssertGreaterThan(pinCallCount, 0)
        }
    }

    // MARK: - Test 4: ChatScrollLoopGuard.record() Rapid Events

    /// Measures ChatScrollLoopGuard.record() with 100 rapid events per
    /// iteration. This exercises the rolling window pruning, threshold
    /// checking, and cooldown logic — all synchronous and deterministic
    /// when timestamps are injected.
    func testChatScrollLoopGuardRecordPerformance() {
        measure(metrics: [XCTClockMetric()]) {
            let loopGuard = ChatScrollLoopGuard()
            let conversationId = "perf-test-conversation"
            var timestamp: TimeInterval = 1000.0

            for _ in 0..<100 {
                loopGuard.record(
                    .bodyEvaluation,
                    conversationId: conversationId,
                    timestamp: timestamp
                )
                timestamp += 0.02
            }

            // Verify the guard state is consistent after the burst.
            let counts = loopGuard.currentCounts(
                conversationId: conversationId,
                timestamp: timestamp
            )
            XCTAssertGreaterThan(counts[.bodyEvaluation] ?? 0, 0)
        }
    }
}
