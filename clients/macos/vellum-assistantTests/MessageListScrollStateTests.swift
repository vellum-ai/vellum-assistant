import SwiftUI
import XCTest
@testable import VellumAssistantLib

@MainActor
final class MessageListScrollStateTests: XCTestCase {
    private var state: MessageListScrollState!

    override func setUp() {
        super.setUp()
        state = MessageListScrollState()
    }

    override func tearDown() {
        state = nil
        super.tearDown()
    }

    // MARK: - Initial State

    func testInitialState() {
        XCTAssertTrue(state.isNearBottom)
        XCTAssertFalse(state.showScrollToLatest)
        XCTAssertFalse(state.scrollIndicatorsHidden)
        XCTAssertFalse(state.hasBeenInteracted)
        XCTAssertFalse(state.bottomAnchorAppeared)
        XCTAssertFalse(state.didAnchorCurrentSendCycle)
        XCTAssertEqual(state.viewportHeight, 0)
        XCTAssertEqual(state.contentHeight, 0)
        XCTAssertEqual(state.contentOffsetY, 0)
        XCTAssertNil(state.currentConversationId)
        XCTAssertNil(state.pendingAnchorMessageId)
        XCTAssertNil(state.lastMessageId)
        XCTAssertNil(state.lastAutoFocusedRequestId)
        XCTAssertFalse(state.wasPaginationTriggerInRange)
    }

    // MARK: - Near-Bottom Hysteresis

    func testNearBottomHysteresisLeavesAt50pt() {
        // Start near bottom
        XCTAssertTrue(state.isNearBottom)

        // Set geometry so distance > 50pt
        state.contentHeight = 1000
        state.viewportHeight = 400
        state.contentOffsetY = 500 // distance = 1000 - 500 - 400 = 100pt
        state.updateNearBottom()

        XCTAssertFalse(state.isNearBottom)
        XCTAssertTrue(state.showScrollToLatest)
    }

    func testNearBottomHysteresisEntersAt10pt() {
        // Leave near-bottom first
        state.contentHeight = 1000
        state.viewportHeight = 400
        state.contentOffsetY = 500
        state.updateNearBottom()
        XCTAssertFalse(state.isNearBottom)

        // Move close to bottom (distance <= 10pt)
        state.contentOffsetY = 595 // distance = 1000 - 595 - 400 = 5pt
        state.updateNearBottom()

        XCTAssertTrue(state.isNearBottom)
        XCTAssertFalse(state.showScrollToLatest)
    }

    func testNearBottomDoesNotReenterBetween10And50() {
        // Leave near-bottom
        state.contentHeight = 1000
        state.viewportHeight = 400
        state.contentOffsetY = 500 // distance = 100pt
        state.updateNearBottom()
        XCTAssertFalse(state.isNearBottom)

        // Move to 30pt from bottom (in hysteresis band)
        state.contentOffsetY = 570 // distance = 1000 - 570 - 400 = 30pt
        state.updateNearBottom()
        XCTAssertFalse(state.isNearBottom, "Should not re-enter near-bottom in hysteresis band")
    }

    // MARK: - Send Cycle Anchoring

    func testBeginSendCycleResetsAnchorFlag() {
        state.markSendAnchored()
        XCTAssertTrue(state.didAnchorCurrentSendCycle)

        state.beginSendCycle()
        XCTAssertFalse(state.didAnchorCurrentSendCycle)
    }

    func testShouldAutoFollow() {
        XCTAssertTrue(state.shouldAutoFollow, "Near bottom + not anchored = should follow")

        state.markSendAnchored()
        XCTAssertFalse(state.shouldAutoFollow, "Already anchored = should not follow")

        state.beginSendCycle()
        XCTAssertTrue(state.shouldAutoFollow, "Reset anchor = should follow again")
    }

    // MARK: - Auto-Follow Throttle

    func testCanAutoFollowThrottles() {
        XCTAssertTrue(state.canAutoFollow())
        XCTAssertFalse(state.canAutoFollow(), "Should throttle within 80ms")
    }

    func testCanAutoFollowReturnsFalseWhenNotNearBottom() {
        state.isNearBottom = false
        XCTAssertFalse(state.canAutoFollow())
    }

    // MARK: - handleReachedBottom

    func testHandleReachedBottomSetsInteracted() {
        XCTAssertFalse(state.hasBeenInteracted)
        state.handleReachedBottom()
        XCTAssertTrue(state.hasBeenInteracted)
        XCTAssertTrue(state.isNearBottom)
        XCTAssertFalse(state.showScrollToLatest)
    }

    // MARK: - handleScrollToLatestTapped

    func testHandleScrollToLatestTapped() {
        // First leave near-bottom so showScrollToLatest becomes true
        state.contentHeight = 1000
        state.viewportHeight = 400
        state.contentOffsetY = 500
        state.updateNearBottom()
        XCTAssertTrue(state.showScrollToLatest)

        state.handleScrollToLatestTapped()
        XCTAssertTrue(state.isNearBottom)
        XCTAssertFalse(state.showScrollToLatest)
    }

    // MARK: - Reset

    func testResetRestoresDefaults() {
        let newId = UUID()

        state.isNearBottom = false
        state.viewportHeight = 500
        state.contentHeight = 1000
        state.contentOffsetY = 200
        state.didAnchorCurrentSendCycle = true
        state.pendingAnchorMessageId = UUID()
        state.lastMessageId = UUID()
        state.wasPaginationTriggerInRange = true
        state.bottomAnchorAppeared = true
        state.hasBeenInteracted = true
        state.lastAutoFocusedRequestId = "req-1"

        state.reset(for: newId)

        XCTAssertEqual(state.currentConversationId, newId)
        XCTAssertTrue(state.isNearBottom)
        XCTAssertEqual(state.viewportHeight, 0)
        XCTAssertEqual(state.contentHeight, 0)
        XCTAssertEqual(state.contentOffsetY, 0)
        XCTAssertFalse(state.didAnchorCurrentSendCycle)
        XCTAssertNil(state.pendingAnchorMessageId)
        XCTAssertNil(state.lastMessageId)
        XCTAssertFalse(state.wasPaginationTriggerInRange)
        XCTAssertEqual(state.lastPaginationCompletedAt, .distantPast)
        XCTAssertFalse(state.showScrollToLatest)
        XCTAssertFalse(state.scrollIndicatorsHidden)
        XCTAssertNil(state.lastAutoFocusedRequestId)
        XCTAssertFalse(state.bottomAnchorAppeared)
        XCTAssertFalse(state.hasBeenInteracted)
    }

    func testResetClearsDerivedStateCache() {
        let cache = state.derivedStateCache
        cache.messageListVersion = 5
        cache.lastKnownRawMessageCount = 10
        cache.lastKnownVisibleMessageCount = 8
        cache.lastKnownLastMessageStreaming = true
        cache.lastKnownIncompleteToolCallCount = 3
        cache.lastKnownVisibleIdFingerprint = 42

        state.reset(for: UUID())

        XCTAssertEqual(cache.messageListVersion, 0)
        XCTAssertEqual(cache.lastKnownRawMessageCount, 0)
        XCTAssertEqual(cache.lastKnownVisibleMessageCount, 0)
        XCTAssertFalse(cache.lastKnownLastMessageStreaming)
        XCTAssertEqual(cache.lastKnownIncompleteToolCallCount, 0)
        XCTAssertEqual(cache.lastKnownVisibleIdFingerprint, 0)
        XCTAssertNil(cache.cachedLayoutKey)
        XCTAssertNil(cache.cachedLayoutMetadata)
        XCTAssertNil(cache.cachedDerivedState)
    }

    // MARK: - Pagination Sentinel

    func testPaginationSentinelRisingEdge() {
        // Out of range initially
        XCTAssertFalse(state.handlePaginationSentinel(sentinelMinY: -200))

        // Enter range — should fire
        XCTAssertTrue(state.handlePaginationSentinel(sentinelMinY: 100))

        // Already in range — should not fire again
        XCTAssertFalse(state.handlePaginationSentinel(sentinelMinY: 50))
    }

    func testPaginationCooldown() {
        // First trigger
        XCTAssertTrue(state.handlePaginationSentinel(sentinelMinY: 100))

        // Leave range
        XCTAssertFalse(state.handlePaginationSentinel(sentinelMinY: -200))

        // Re-enter within cooldown — should not fire
        // (lastPaginationCompletedAt was just set)
        XCTAssertFalse(state.handlePaginationSentinel(sentinelMinY: 100))
    }

    func testPaginationCooldownResetOnConversationSwitch() {
        state.lastPaginationCompletedAt = Date()
        state.reset(for: UUID())
        XCTAssertEqual(state.lastPaginationCompletedAt, .distantPast)
    }

    // MARK: - Circuit Breaker

    func testCircuitBreakerTripsAfterRapidEvaluations() {
        for _ in 0...100 {
            state.recordBodyEvaluation()
        }
        XCTAssertTrue(state.derivedStateCache.isThrottled, "Circuit breaker should be active")
    }

    func testCircuitBreakerRecovery() async throws {
        for _ in 0...100 {
            state.recordBodyEvaluation()
        }
        XCTAssertTrue(state.derivedStateCache.isThrottled)
        try await Task.sleep(nanoseconds: 600_000_000)
        XCTAssertFalse(state.derivedStateCache.isThrottled, "Circuit breaker should auto-recover")
    }

    // MARK: - Distance From Bottom

    func testDistanceFromBottom() {
        state.contentHeight = 1000
        state.viewportHeight = 400
        state.contentOffsetY = 500
        XCTAssertEqual(state.distanceFromBottom, 100)
    }
}
