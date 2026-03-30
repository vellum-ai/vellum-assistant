import SwiftUI
import XCTest
@testable import VellumAssistantLib

@MainActor
final class MessageListScrollStateTests: XCTestCase {
    private var state: MessageListScrollState!
    private var scrollToCalls: [(id: AnyHashable, anchor: UnitPoint?)] = []

    override func setUp() {
        super.setUp()
        state = MessageListScrollState()
        scrollToCalls = []

        state.scrollTo = { [weak self] id, anchor in
            self?.scrollToCalls.append((id: id as! AnyHashable, anchor: anchor))
        }
    }

    override func tearDown() {
        state.cancelAll()
        state = nil
        super.tearDown()
    }

    // MARK: - Follow/Detach State

    func testInitialStateIsFollowingBottom() {
        XCTAssertTrue(state.isFollowingBottom)
    }

    func testDetachSetsFollowingFalse() {
        state.detach()
        XCTAssertFalse(state.isFollowingBottom)
    }

    func testReattachSetsFollowingTrue() {
        state.detach()
        XCTAssertFalse(state.isFollowingBottom)

        state.reattach()
        XCTAssertTrue(state.isFollowingBottom)
    }

    func testDetachWhenAlreadyDetachedIsNoop() {
        state.detach()
        XCTAssertFalse(state.isFollowingBottom)

        // Second detach should be a no-op (no crash, no state change).
        state.detach()
        XCTAssertFalse(state.isFollowingBottom)
    }

    func testReattachWhenAlreadyAttachedIsNoop() {
        // Initial state is already following bottom.
        XCTAssertTrue(state.isFollowingBottom)

        // Reattach when already attached should be a no-op.
        state.reattach()
        XCTAssertTrue(state.isFollowingBottom)
    }

    func testRapidDetachCallsDoNotAccumulate() {
        for _ in 0..<100 {
            state.detach()
        }
        XCTAssertFalse(state.isFollowingBottom)
        XCTAssertTrue(state.showScrollToLatest)
    }

    // MARK: - Pin Gating

    func testPinSuppressedWhileDetached() {
        state.detach()
        let result = state.pinToBottom()

        XCTAssertFalse(result, "pinToBottom should return false when detached")
        XCTAssertTrue(scrollToCalls.isEmpty,
                      "Pin requests should be suppressed while detached")
    }

    func testPinSuppressedWhileSuppressed() {
        state.reattach()
        state.beginSuppression(.expansion)
        let result = state.pinToBottom()

        XCTAssertFalse(result, "pinToBottom should return false when suppressed")
        XCTAssertTrue(scrollToCalls.isEmpty,
                      "Pin requests should be suppressed when isSuppressed is true")
    }

    func testPinAllowedWhenFollowingAndNotSuppressed() {
        state.reattach()
        let result = state.pinToBottom()

        XCTAssertTrue(result, "pinToBottom should return true when following and not suppressed")
        XCTAssertFalse(scrollToCalls.isEmpty,
                       "scrollTo should have been called")
        XCTAssertEqual(scrollToCalls.first?.id, "scroll-bottom-anchor" as AnyHashable)
    }

    func testPinAllowedAfterReattach() {
        state.detach()
        let suppressed = state.pinToBottom()
        XCTAssertFalse(suppressed)
        XCTAssertTrue(scrollToCalls.isEmpty)

        state.reattach()
        let allowed = state.pinToBottom()
        XCTAssertTrue(allowed)
        XCTAssertFalse(scrollToCalls.isEmpty,
                       "Pin requests should proceed after reattach")
    }

    func testUserInitiatedBypassesGuards() {
        // Detach AND add suppression -- both guards active.
        state.detach()
        state.beginSuppression(.expansion)

        let result = state.pinToBottom(userInitiated: true)

        XCTAssertTrue(result,
                      "User-initiated requests should always return true")
        XCTAssertFalse(scrollToCalls.isEmpty,
                       "User-initiated requests should bypass both follow-state and suppression checks")
    }

    // MARK: - Suppression: Overlapping Reasons

    func testSuppressionReasonsOverlap() {
        state.beginSuppression(.expansion)
        state.beginSuppression(.resize)
        XCTAssertTrue(state.isSuppressed)

        // Clearing one reason leaves the other active.
        state.endSuppression(.resize)
        XCTAssertTrue(state.isSuppressed, "Expansion is still active")

        state.endSuppression(.expansion)
        XCTAssertFalse(state.isSuppressed, "All reasons cleared")
    }

    func testExpansionAndPaginationOverlap() {
        state.beginSuppression(.expansion)
        state.beginSuppression(.pagination)
        XCTAssertTrue(state.isSuppressed)

        state.endSuppression(.pagination)
        XCTAssertTrue(state.isSuppressed, "Expansion is still active")

        state.endSuppression(.expansion)
        XCTAssertFalse(state.isSuppressed, "All reasons cleared")
    }

    // MARK: - Suppression: Expansion 200ms Auto-Clear

    func testExpansionAutoClears() async throws {
        state.beginSuppression(.expansion)
        XCTAssertTrue(state.isSuppressed)

        // Wait 250ms (200ms timeout + 50ms tolerance).
        try await Task.sleep(nanoseconds: 250_000_000)

        XCTAssertFalse(state.isSuppressed,
                       "Expansion suppression should auto-clear after 200ms")
    }

    func testExpansionTimerReset() async throws {
        state.beginSuppression(.expansion)
        XCTAssertTrue(state.isSuppressed)

        // Wait 100ms (halfway through original timeout).
        try await Task.sleep(nanoseconds: 100_000_000)

        // Re-trigger -- this should reset the 200ms timer.
        state.beginSuppression(.expansion)
        XCTAssertTrue(state.isSuppressed)

        // Wait 150ms -- past the original 200ms but before the reset 200ms.
        try await Task.sleep(nanoseconds: 150_000_000)

        XCTAssertTrue(state.isSuppressed,
                      "Timer was reset -- should still be suppressed")

        // Wait remaining 100ms + tolerance.
        try await Task.sleep(nanoseconds: 100_000_000)

        XCTAssertFalse(state.isSuppressed,
                       "Expansion suppression should auto-clear after the reset timeout")
    }

    // MARK: - Suppression: clearSuppression

    func testClearSuppression() {
        state.beginSuppression(.resize)
        state.beginSuppression(.pagination)
        state.beginSuppression(.expansion)
        XCTAssertTrue(state.isSuppressed)

        state.clearSuppression()

        XCTAssertFalse(state.isSuppressed, "All suppression should be cleared")
    }

    // MARK: - Reset

    func testResetRestoresDefaults() {
        let oldId = UUID()
        let newId = UUID()

        // Mutate state away from defaults.
        state.detach()
        state.beginSuppression(.resize)
        state.isPaginationInFlight = true
        state.wasPaginationTriggerInRange = true
        state.hasReceivedScrollEvent = true
        state.isAtBottom = false
        state.currentConversationId = oldId

        state.reset(for: newId)

        XCTAssertTrue(state.isFollowingBottom, "Should restore following state")
        XCTAssertFalse(state.isSuppressed, "Should clear suppression")
        XCTAssertFalse(state.isPaginationInFlight, "Should clear pagination flag")
        XCTAssertFalse(state.wasPaginationTriggerInRange, "Should clear trigger range flag")
        XCTAssertTrue(state.isAtBottom, "Should reset isAtBottom to true")
        XCTAssertFalse(state.hasReceivedScrollEvent, "Should reset scroll event flag")
        XCTAssertEqual(state.currentConversationId, newId, "Should update conversation ID")
        XCTAssertNil(state.pushToTopMessageId, "Should clear pushToTopMessageId")
        XCTAssertTrue(state.hideScrollIndicators,
                      "Should hide scroll indicators during conversation switch")
    }

    func testResetClearsLayoutCache() {
        state.messageListVersion = 5
        state.lastKnownRawMessageCount = 10
        state.lastKnownVisibleMessageCount = 8
        state.lastKnownLastMessageStreaming = true
        state.lastKnownIncompleteToolCallCount = 3
        state.lastKnownVisibleIdFingerprint = 42

        state.reset(for: UUID())

        XCTAssertEqual(state.messageListVersion, 0)
        XCTAssertEqual(state.lastKnownRawMessageCount, 0)
        XCTAssertEqual(state.lastKnownVisibleMessageCount, 0)
        XCTAssertFalse(state.lastKnownLastMessageStreaming)
        XCTAssertEqual(state.lastKnownIncompleteToolCallCount, 0)
        XCTAssertEqual(state.lastKnownVisibleIdFingerprint, 0)
        XCTAssertNil(state.cachedLayoutKey)
        XCTAssertNil(state.cachedLayoutMetadata)
    }

    // MARK: - cancelAll

    func testCancelAllClearsSuppression() {
        state.beginSuppression(.resize)
        state.beginSuppression(.pagination)
        state.beginSuppression(.expansion)
        XCTAssertTrue(state.isSuppressed)

        state.cancelAll()

        XCTAssertFalse(state.isSuppressed, "cancelAll should clear all suppression")
        XCTAssertFalse(state.hideScrollIndicators,
                       "cancelAll should restore scroll indicators")
        XCTAssertFalse(state.isPaginationInFlight,
                       "cancelAll should clear pagination flag")
    }

    // MARK: - Computed Properties

    func testShowScrollToLatest() {
        XCTAssertFalse(state.showScrollToLatest,
                       "Should be false when following bottom")

        state.detach()
        XCTAssertTrue(state.showScrollToLatest,
                      "Should be true when not following bottom")

        state.reattach()
        XCTAssertFalse(state.showScrollToLatest,
                       "Should be false again after reattach")
    }

    func testTailSpacerHeight() {
        // No pushToTop active -- height should be 0.
        XCTAssertEqual(state.tailSpacerHeight, 0,
                       "Should be 0 when pushToTopMessageId is nil")

        // Activate pushToTop with a known viewport height.
        state.viewportHeight = 600
        state.pushToTopMessageId = UUID()

        // tailSpacerHeight = max(0, viewportHeight - VSpacing.md)
        // VSpacing.md is a design token; the exact value isn't important
        // for the test -- we verify the formula produces a positive value.
        XCTAssertGreaterThan(state.tailSpacerHeight, 0,
                             "Should be positive when pushToTopMessageId is set and viewport is finite")
        XCTAssertLessThanOrEqual(state.tailSpacerHeight, 600,
                                 "Should not exceed viewport height")
    }

    func testTailSpacerHeightZeroWhenViewportInfinite() {
        state.pushToTopMessageId = UUID()
        state.viewportHeight = .infinity

        XCTAssertEqual(state.tailSpacerHeight, 0,
                       "Should be 0 when viewport height is not finite")
    }
}
