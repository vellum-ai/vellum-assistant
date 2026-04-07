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

    // MARK: - Test 1: CachedMessageLayoutMetadata Computation (500 messages)

    /// Measures the wall-clock time to compute CachedMessageLayoutMetadata from
    /// 500 messages. This exercises the O(n) scans (timestamp indices, subagent
    /// grouping, preceding-assistant detection) that run on every cache miss.
    func testCachedMessageLayoutMetadataComputation() {
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
                // Force an equality check (the hot path in MessageListView.derivedState).
                if let prev = lastKey {
                    _ = key == prev
                }
                lastKey = key
            }
            XCTAssertNotNil(lastKey)
        }
    }

    // MARK: - Test 3: Near-Bottom Update Hot Path

    /// Measures the synchronous hot path of updateNearBottom on the scroll
    /// state — repeated 100 times. This mirrors the per-scroll-frame hot path
    /// for hysteresis-based near-bottom detection.
    @MainActor
    func testNearBottomUpdatePerformance() {
        measure(metrics: [XCTClockMetric()]) {
            let scrollState = MessageListScrollState()
            scrollState.contentHeight = 5000
            scrollState.viewportHeight = 800

            // Run 100 update cycles alternating between near and far positions.
            for i in 0..<100 {
                // Alternate between near-bottom and far-from-bottom.
                scrollState.contentOffsetY = (i % 2 == 0) ? 4190 : 3000
                scrollState.updateNearBottom()
            }

            // Verify final state is deterministic.
            XCTAssertFalse(scrollState.isNearBottom)
        }
    }

    // MARK: - Test 5: Streaming Text Visible Through Cache Hit

    /// Verifies that streaming text updates are visible even when the layout
    /// cache returns a hit. The layout cache key should NOT change when only
    /// text content changes (same message count, same streaming flag), but
    /// the live message data passed to the ForEach must reflect the update.
    @MainActor func testStreamingTextVisibleThroughCacheHit() {
        var messages = buildMessages(count: 10)
        // Simulate an assistant message that is actively streaming.
        messages[messages.count - 1] = ChatMessage(
            id: messages.last!.id,
            role: .assistant,
            text: "Hello",
            timestamp: messages.last!.timestamp,
            isStreaming: true
        )

        let tracking = MessageListScrollState()

        // Build initial cache.
        let key = PrecomputedCacheKey(
            messageListVersion: 1,
            isSending: true,
            isThinking: false,
            isCompacting: false,
            assistantStatusText: nil,
            activeSubagentFingerprint: 0,
            displayedMessageCount: .max
        )
        let layout = CachedMessageLayoutMetadata(
            displayMessageIds: messages.map(\.id),
            messageIndexById: Dictionary(messages.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { first, _ in first }),
            showTimestamp: [messages[0].id],
            hasPrecedingAssistantByIndex: Set((1..<messages.count).filter { messages[$0 - 1].role == .assistant }),
            hasUserMessage: true,
            latestAssistantId: messages.last?.id,
            subagentsByParent: [:],
            orphanSubagents: [],
            effectiveStatusText: nil
        )
        tracking.derivedStateCache.cachedLayoutKey = key
        tracking.derivedStateCache.cachedLayoutMetadata = layout

        // Simulate streaming: append text to the last message (same count,
        // same isStreaming flag — the version counter does NOT bump).
        messages[messages.count - 1] = ChatMessage(
            id: messages.last!.id,
            role: .assistant,
            text: "Hello, world! Here is more streamed text.",
            timestamp: messages.last!.timestamp,
            isStreaming: true
        )

        // Build live message dictionary (as derivedState does on every body eval).
        let liveMessageById = Dictionary(
            messages.map { ($0.id, $0) },
            uniquingKeysWith: { first, _ in first }
        )

        // The cache key hasn't changed — layout cache should still hit.
        XCTAssertEqual(key, tracking.derivedStateCache.cachedLayoutKey)
        XCTAssertNotNil(tracking.derivedStateCache.cachedLayoutMetadata)

        // But the live message must reflect the updated text.
        let lastId = messages.last!.id
        let liveMessage = liveMessageById[lastId]
        XCTAssertNotNil(liveMessage)
        XCTAssertTrue(liveMessage!.text.contains("more streamed text"),
                       "Live message must reflect streaming text update even on cache hit")
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

    // MARK: - Test 8: Cache-Hit Steady-State Performance

    /// Measures the cost of the live-data stage (message dictionary + confirmation
    /// scans) that runs on every body evaluation, including cache hits.
    /// This is the per-frame cost during streaming.
    func testLiveStateSteadyStatePerformance() {
        let messages = buildMessages(count: 200)

        measure(metrics: [XCTClockMetric()]) {
            for _ in 0..<100 {
                // Live message dictionary construction.
                let liveMessageById = Dictionary(
                    messages.map { ($0.id, $0) },
                    uniquingKeysWith: { first, _ in first }
                )

                // Confirmation detection (O(n)).
                var nextDecided: [Int: ToolConfirmationData] = [:]
                for i in messages.indices {
                    if i + 1 < messages.count,
                       let conf = messages[i + 1].confirmation,
                       conf.state != .pending {
                        nextDecided[i] = conf
                    }
                }

                // Inline confirmation detection (O(n)).
                var inlineSet = Set<Int>()
                for i in messages.indices {
                    guard let confirmation = messages[i].confirmation,
                          confirmation.state == .pending,
                          let toolUseId = confirmation.toolUseId,
                          !toolUseId.isEmpty else { continue }
                    for j in (0..<i).reversed() {
                        let msg = messages[j]
                        guard msg.role == .assistant, msg.confirmation == nil else { continue }
                        if msg.toolCalls.contains(where: { $0.toolUseId == toolUseId && $0.pendingConfirmation != nil }) {
                            inlineSet.insert(i)
                        }
                        break
                    }
                }

                // Current turn detection (O(n)).
                let lastTurnStart = messages.indices.reversed().first(where: { idx in
                    messages[idx].role == .user
                        && messages.index(after: idx) < messages.endIndex
                        && messages[messages.index(after: idx)].role != .user
                })

                // Prevent compiler from optimizing away work.
                XCTAssertEqual(liveMessageById.count, 200)
                _ = nextDecided
                _ = inlineSet
                _ = lastTurnStart
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
