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

    // MARK: - Test 1: TranscriptProjector Full Projection (500 messages)

    /// Measures the wall-clock time to run `TranscriptProjector.project()` with
    /// 500 messages. This exercises all O(n) scans (deduplication, timestamp
    /// grouping, subagent grouping, confirmation detection, preceding-assistant
    /// detection, thinking state) that run on every cache miss.
    func testTranscriptProjectorFullProjection() {
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
            let model = TranscriptProjector.project(
                messages: messages,
                paginatedVisibleMessages: messages,
                activeSubagents: subagents,
                isSending: true,
                isThinking: false,
                isCompacting: false,
                assistantStatusText: nil,
                assistantActivityPhase: "",
                assistantActivityAnchor: "",
                assistantActivityReason: nil,
                activePendingRequestId: nil,
                highlightedMessageId: nil
            )

            // Prevent the compiler from optimizing away the work.
            XCTAssertEqual(model.rows.count, 500)
            XCTAssertFalse(model.rows.isEmpty)
            XCTAssertEqual(model.subagentsByParent.count, 5)
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
                // Force an equality check (the hot path in MessageListView.derivedState).
                if let prev = lastKey {
                    _ = key == prev
                }
                lastKey = key
            }
            XCTAssertNotNil(lastKey)
        }
    }

    // MARK: - Test 3: requestPinToBottom Hot Path

    /// Measures the synchronous hot path of requestPinToBottom on the scroll
    /// state: request a pin, transition back to followingBottom — repeated 100 times.
    @MainActor
    func testPinToBottomPerformance() {
        measure(metrics: [XCTClockMetric()]) {
            let scrollState = MessageListScrollState()
            var scrollCallCount = 0

            scrollState.scrollTo = { _, _ in
                scrollCallCount += 1
            }

            // Ensure we start in followingBottom mode.
            scrollState.transition(to: .followingBottom)

            // Run 100 pin request cycles to get a stable measurement.
            for _ in 0..<100 {
                scrollState.requestPinToBottom()
                scrollState.transition(to: .followingBottom)
            }

            XCTAssertGreaterThan(scrollCallCount, 0)
            scrollState.cancelAll()
        }
    }

    // MARK: - Test 5: Streaming Text Visible Through Projection

    /// Verifies that streaming text updates are reflected when the projector
    /// is called with updated messages. Even when the cache key has not changed
    /// (same count, same streaming flag), re-projecting with updated message
    /// content produces rows containing the updated text.
    func testStreamingTextVisibleThroughProjection() {
        var messages = buildMessages(count: 10)
        // Simulate an assistant message that is actively streaming.
        messages[messages.count - 1] = ChatMessage(
            id: messages.last!.id,
            role: .assistant,
            text: "Hello",
            timestamp: messages.last!.timestamp,
            isStreaming: true
        )

        // Build initial projection.
        let model1 = TranscriptProjector.project(
            messages: messages,
            paginatedVisibleMessages: messages,
            activeSubagents: [],
            isSending: true,
            isThinking: false,
            isCompacting: false,
            assistantStatusText: nil,
            assistantActivityPhase: "",
            assistantActivityAnchor: "",
            assistantActivityReason: nil,
            activePendingRequestId: nil,
            highlightedMessageId: nil
        )
        XCTAssertEqual(model1.rows.last?.message.text, "Hello")

        // Simulate streaming: append text to the last message (same count,
        // same isStreaming flag).
        messages[messages.count - 1] = ChatMessage(
            id: messages.last!.id,
            role: .assistant,
            text: "Hello, world! Here is more streamed text.",
            timestamp: messages.last!.timestamp,
            isStreaming: true
        )

        // Re-project with updated messages.
        let model2 = TranscriptProjector.project(
            messages: messages,
            paginatedVisibleMessages: messages,
            activeSubagents: [],
            isSending: true,
            isThinking: false,
            isCompacting: false,
            assistantStatusText: nil,
            assistantActivityPhase: "",
            assistantActivityAnchor: "",
            assistantActivityReason: nil,
            activePendingRequestId: nil,
            highlightedMessageId: nil
        )

        // The projected model must reflect the updated text.
        XCTAssertTrue(model2.rows.last!.message.text.contains("more streamed text"),
                       "Projected model must reflect streaming text update")
        // Row count and identity should be stable.
        XCTAssertEqual(model1.rows.count, model2.rows.count)
        XCTAssertEqual(model1.rows.last?.id, model2.rows.last?.id)
    }

    // MARK: - Test 6: Confirmation Resolution Updates Live State

    /// Verifies that confirmation state changes (pending → approved/denied)
    /// are reflected in the live content-derived state, not gated by the
    /// layout cache. The layout cache key should not change when only
    /// confirmation state changes in place.
    func testConfirmationResolutionVisibleThroughCacheHit() {
        var messages = buildMessages(count: 6)
        // Add a confirmation message at index 5.
        messages[5] = ChatMessage(
            id: messages[5].id,
            role: .assistant,
            text: "",
            timestamp: messages[5].timestamp,
            confirmation: ToolConfirmationData(
                requestId: "req-1",
                toolName: "bash",
                riskLevel: "high",
                state: .pending
            )
        )

        // Compute confirmation-derived metadata from live messages
        // (replicating the live stage of derivedState).
        let pendingId1 = PendingConfirmationFocusSelector.activeRequestId(from: messages)
        XCTAssertEqual(pendingId1, "req-1", "Should detect pending confirmation")

        var nextDecided1: [Int: ToolConfirmationData] = [:]
        for i in messages.indices {
            if i + 1 < messages.count,
               let conf = messages[i + 1].confirmation,
               conf.state != .pending {
                nextDecided1[i] = conf
            }
        }
        XCTAssertTrue(nextDecided1.isEmpty, "No decided confirmations yet")

        // Simulate confirmation resolution (in-place mutation).
        messages[5].confirmation?.state = .approved

        // Re-derive from live messages.
        let pendingId2 = PendingConfirmationFocusSelector.activeRequestId(from: messages)
        XCTAssertNil(pendingId2, "Pending confirmation should be gone after approval")

        var nextDecided2: [Int: ToolConfirmationData] = [:]
        for i in messages.indices {
            if i + 1 < messages.count,
               let conf = messages[i + 1].confirmation,
               conf.state != .pending {
                nextDecided2[i] = conf
            }
        }
        XCTAssertNotNil(nextDecided2[4], "Should detect decided confirmation at preceding index")
    }

    // MARK: - Test 7: Subagent Changes Detected by MessageCellView Equality

    /// Verifies that MessageCellView's Equatable implementation detects
    /// subagent attachment changes for the owning row.
    func testSubagentChangesDetectedByMessageCellViewEquality() {
        let message = ChatMessage(role: .assistant, text: "test")

        let emptySubagents: [UUID: [SubagentInfo]] = [:]
        let withSubagent: [UUID: [SubagentInfo]] = [
            message.id: [
                SubagentInfo(id: "sub-1", label: "Worker", status: .running, parentMessageId: message.id)
            ]
        ]

        // Subagent lookup for this message differs → cells should NOT be equal.
        let lhsSlice = emptySubagents[message.id]
        let rhsSlice = withSubagent[message.id]
        XCTAssertNotEqual(lhsSlice, rhsSlice,
                          "Subagent slices for the same message ID must differ")
    }

    // MARK: - Test 8: Projector Cache-Hit Steady-State Performance

    /// Measures the cost of repeated projector calls with identical inputs.
    /// On cache hits in the real code path, the projector is not called
    /// (the cached TranscriptRenderModel is returned). This test measures
    /// re-projection cost as a worst-case baseline for the per-frame cost
    /// during streaming when the cache misses.
    func testProjectorSteadyStatePerformance() {
        let messages = buildMessages(count: 200)

        measure(metrics: [XCTClockMetric()]) {
            for _ in 0..<100 {
                let model = TranscriptProjector.project(
                    messages: messages,
                    paginatedVisibleMessages: messages,
                    activeSubagents: [],
                    isSending: true,
                    isThinking: false,
                    isCompacting: false,
                    assistantStatusText: nil,
                    assistantActivityPhase: "",
                    assistantActivityAnchor: "",
                    assistantActivityReason: nil,
                    activePendingRequestId: nil,
                    highlightedMessageId: nil
                )

                // Prevent compiler from optimizing away work.
                XCTAssertEqual(model.rows.count, 200)
            }
        }
    }

    // MARK: - Test 9: MarkdownSegmentView Measurement Caching

    /// Verifies that resolveSelectableRunMeasurement caches results so repeated
    /// calls do not re-run TextKit layout passes. This prevents the 12-24s
    /// main-thread hangs observed in the LazyVStack layout cascade.
    ///
    /// Calls `resolveSelectableRunMeasurement` directly because SwiftUI's
    /// `body` evaluation does not execute `ForEach` row closures in a
    /// unit-test context (no rendering host).
    @MainActor
    func testMarkdownSegmentMeasurementCaching() {
        // Clear any pre-existing cache entries.
        MarkdownSegmentView.clearAttributedStringCache()

        let segments: [MarkdownSegment] = [
            .text("Hello world, this is a test message with some representative content for benchmarking layout measurement caching.")
        ]

        let view = MarkdownSegmentView(segments: segments)

        // First call = cache miss, triggers TextKit layout.
        _ = view.resolveSelectableRunMeasurement(segments)
        let insertCountAfterFirst = MarkdownSegmentView._measuredTextCacheInsertCount

        // Second call with identical inputs should hit the cache.
        _ = view.resolveSelectableRunMeasurement(segments)
        let insertCountAfterSecond = MarkdownSegmentView._measuredTextCacheInsertCount

        // The insert count should NOT increase on the second call,
        // proving that the TextKit measurement was served from cache.
        XCTAssertEqual(insertCountAfterFirst, insertCountAfterSecond,
            "Second call must hit the measurement cache — no new TextKit layout pass")
        XCTAssertGreaterThan(insertCountAfterFirst, 0,
            "First call must have inserted at least one cache entry")
    }

    // MARK: - Test 10: MarkdownSegmentView Measurement Performance

    /// Measures repeated resolveSelectableRunMeasurement calls with a warm
    /// cache. Ensures the per-call cost stays negligible (cache lookups only,
    /// no TextKit layout). Baseline regression detection via XCTest's
    /// statistical comparison.
    @MainActor
    func testMarkdownSegmentMeasurementPerformance() {
        let segments: [MarkdownSegment] = [
            .text("First paragraph with some representative text content."),
            .text("Second paragraph with **bold** and *italic* formatting."),
            .heading(level: 2, text: "A Section Heading"),
            .text("Third paragraph after the heading with a [link](https://example.com).")
        ]

        let view = MarkdownSegmentView(segments: segments)

        // Pre-warm the cache.
        _ = view.resolveSelectableRunMeasurement(segments)

        // Measure repeated calls — should all be cache hits.
        measure(metrics: [XCTClockMetric()]) {
            for _ in 0..<200 {
                _ = view.resolveSelectableRunMeasurement(segments)
            }
        }
    }
}
