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

    // MARK: - Initial State

    func testInitialStateIsFollowingBottom() {
        XCTAssertTrue(state.isFollowingBottom)
        XCTAssertFalse(state.hasBeenInteracted)
    }

    func testInitialModeIsInitialLoad() {
        if case .initialLoad = state.mode {
            // correct
        } else {
            XCTFail("Initial mode should be .initialLoad")
        }
    }

    // MARK: - Mode Transitions

    func testTransitionToFreeBrowsingSetsFollowingFalse() {
        state.transition(to: .freeBrowsing)
        XCTAssertFalse(state.isFollowingBottom)
        XCTAssertTrue(state.hasBeenInteracted)
    }

    func testTransitionToFollowingBottomSetsFollowingTrue() {
        state.transition(to: .freeBrowsing)
        XCTAssertFalse(state.isFollowingBottom)

        state.transition(to: .followingBottom)
        XCTAssertTrue(state.isFollowingBottom)
    }

    func testTransitionToSameModeIsNoop() {
        state.transition(to: .followingBottom)
        state.transition(to: .followingBottom)
        XCTAssertTrue(state.isFollowingBottom)
    }

    func testHandleUserScrollUpTransitionsToFreeBrowsing() {
        state.transition(to: .followingBottom)
        state.handleUserScrollUp()
        XCTAssertFalse(state.isFollowingBottom)
        if case .freeBrowsing = state.mode {
            // correct
        } else {
            XCTFail("Expected .freeBrowsing after handleUserScrollUp")
        }
    }

    func testHandleReachedBottomTransitionsToFollowingBottom() {
        state.transition(to: .freeBrowsing)
        XCTAssertFalse(state.isFollowingBottom)

        state.handleReachedBottom()
        XCTAssertTrue(state.isFollowingBottom)
    }

    func testRapidTransitionsDoNotAccumulate() async throws {
        for _ in 0..<100 {
            state.transition(to: .freeBrowsing)
        }
        XCTAssertFalse(state.isFollowingBottom)
        XCTAssertFalse(state.showScrollToLatest)
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertTrue(state.showScrollToLatest)
        XCTAssertEqual(state.uiVersion, 1, "Only one uiVersion bump despite 100 transition calls")
    }

    // MARK: - Pin Gating

    func testPinSuppressedInFreeBrowsing() {
        state.transition(to: .freeBrowsing)
        let result = state.requestPinToBottom()

        XCTAssertFalse(result, "requestPinToBottom should return false in freeBrowsing mode")
        XCTAssertTrue(scrollToCalls.isEmpty,
                      "Pin requests should be suppressed in freeBrowsing mode")
    }

    func testPinSuppressedWhileStabilizing() {
        state.transition(to: .followingBottom)
        state.beginStabilization(.expansion)
        let result = state.requestPinToBottom()

        XCTAssertFalse(result, "requestPinToBottom should return false when stabilizing")
        XCTAssertTrue(scrollToCalls.isEmpty,
                      "Pin requests should be suppressed when stabilizing")
    }

    func testPinAllowedWhenFollowingBottom() {
        state.transition(to: .followingBottom)
        let result = state.requestPinToBottom()

        XCTAssertTrue(result, "requestPinToBottom should return true when following bottom")
        XCTAssertFalse(scrollToCalls.isEmpty,
                       "scrollTo should have been called")
        XCTAssertEqual(scrollToCalls.first?.id, "scroll-bottom-anchor" as AnyHashable)
    }

    func testPinAllowedAfterTransitionToFollowingBottom() {
        state.transition(to: .freeBrowsing)
        let suppressed = state.requestPinToBottom()
        XCTAssertFalse(suppressed)
        XCTAssertTrue(scrollToCalls.isEmpty)

        state.transition(to: .followingBottom)
        let allowed = state.requestPinToBottom()
        XCTAssertTrue(allowed)
        XCTAssertFalse(scrollToCalls.isEmpty,
                       "Pin requests should proceed after transitioning to followingBottom")
    }

    func testUserInitiatedBypassesGuards() {
        state.transition(to: .freeBrowsing)
        state.beginStabilization(.expansion)

        let result = state.requestPinToBottom(userInitiated: true)

        XCTAssertTrue(result,
                      "User-initiated requests should always return true")
        XCTAssertFalse(scrollToCalls.isEmpty,
                       "User-initiated requests should bypass mode checks")
    }

    // MARK: - Stabilization

    func testStabilizationPreservesFollowingBottom() {
        state.transition(to: .followingBottom)
        state.beginStabilization(.resize)
        XCTAssertTrue(state.isSuppressed)
        XCTAssertTrue(state.isFollowingBottom,
                      "isFollowingBottom should reflect the pre-stabilization mode")

        state.endStabilization()
        XCTAssertFalse(state.isSuppressed)
        XCTAssertTrue(state.isFollowingBottom)
    }

    func testStabilizationPreservesFreeBrowsing() {
        state.transition(to: .freeBrowsing)
        state.beginStabilization(.resize)
        XCTAssertTrue(state.isSuppressed)
        XCTAssertFalse(state.isFollowingBottom)

        state.endStabilization()
        XCTAssertFalse(state.isSuppressed)
        XCTAssertFalse(state.isFollowingBottom)
    }

    // MARK: - Stabilization: Expansion 200ms Auto-Clear

    func testExpansionAutoClears() async throws {
        state.transition(to: .followingBottom)
        state.beginStabilization(.expansion)
        XCTAssertTrue(state.isSuppressed)

        try await Task.sleep(nanoseconds: 250_000_000)

        XCTAssertFalse(state.isSuppressed,
                       "Expansion stabilization should auto-clear after 200ms")
    }

    func testExpansionTimerReset() async throws {
        state.transition(to: .followingBottom)
        state.beginStabilization(.expansion)
        XCTAssertTrue(state.isSuppressed)

        try await Task.sleep(nanoseconds: 100_000_000)

        state.beginStabilization(.expansion)
        XCTAssertTrue(state.isSuppressed)

        try await Task.sleep(nanoseconds: 150_000_000)

        XCTAssertTrue(state.isSuppressed,
                      "Timer was reset -- should still be stabilizing")

        try await Task.sleep(nanoseconds: 100_000_000)

        XCTAssertFalse(state.isSuppressed,
                       "Expansion stabilization should auto-clear after the reset timeout")
    }

    // MARK: - Push-to-Top Mode

    func testEnterPushToTop() {
        let messageId = UUID()
        state.enterPushToTop(messageId: messageId)

        if case .pushToTop(let id) = state.mode {
            XCTAssertEqual(id, messageId)
        } else {
            XCTFail("Expected .pushToTop mode")
        }
        XCTAssertEqual(state.pendingPushToTopTarget, messageId)
        XCTAssertTrue(state.mode.showsTailSpacer)
    }

    func testExitPushToTop() {
        let messageId = UUID()
        state.enterPushToTop(messageId: messageId)
        state.exitPushToTop(animated: false)

        XCTAssertTrue(state.isFollowingBottom)
        XCTAssertNil(state.mode.pushToTopMessageId)
        XCTAssertNil(state.pendingPushToTopTarget)
    }

    func testHandlePushToTopOverflow() {
        let messageId = UUID()
        state.enterPushToTop(messageId: messageId)

        let result = state.handlePushToTopOverflow()
        XCTAssertTrue(result)
        XCTAssertTrue(state.isFollowingBottom)
    }

    func testHandlePushToTopOverflowNoopWhenNotInPushToTop() {
        state.transition(to: .followingBottom)
        let result = state.handlePushToTopOverflow()
        XCTAssertFalse(result)
    }

    // MARK: - Reset

    func testResetRestoresDefaults() {
        let oldId = UUID()
        let newId = UUID()

        state.transition(to: .freeBrowsing)
        state.beginStabilization(.resize)
        state.isPaginationInFlight = true
        state.wasPaginationTriggerInRange = true
        state.isAtBottom = false
        state.currentConversationId = oldId

        state.reset(for: newId)

        XCTAssertTrue(state.isFollowingBottom, "Should restore following state")
        XCTAssertFalse(state.showScrollToLatest, "Should sync showScrollToLatest immediately on reset")
        XCTAssertFalse(state.isSuppressed, "Should clear stabilization")
        XCTAssertFalse(state.isPaginationInFlight, "Should clear pagination flag")
        XCTAssertFalse(state.wasPaginationTriggerInRange, "Should clear trigger range flag")
        XCTAssertTrue(state.isAtBottom, "Should reset isAtBottom to true")
        XCTAssertFalse(state.hasBeenInteracted, "Should reset to initialLoad mode")
        XCTAssertEqual(state.currentConversationId, newId, "Should update conversation ID")
        XCTAssertNil(state.mode.pushToTopMessageId, "Should clear pushToTopMessageId")
        XCTAssertTrue(state.hideScrollIndicators,
                      "Should hide scroll indicators during conversation switch")
        XCTAssertFalse(state.showTailSpacer)
        XCTAssertTrue(state.scrollIndicatorsHidden)
        XCTAssertFalse(state.showScrollToLatest)
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

    func testCancelAllResetsMode() {
        state.transition(to: .freeBrowsing)
        state.beginStabilization(.resize)
        XCTAssertTrue(state.isSuppressed)

        state.cancelAll()

        XCTAssertFalse(state.isSuppressed, "cancelAll should clear stabilization")
        XCTAssertFalse(state.hideScrollIndicators,
                       "cancelAll should restore scroll indicators")
        XCTAssertFalse(state.isPaginationInFlight,
                       "cancelAll should clear pagination flag")
    }

    // MARK: - Computed Properties

    func testShowScrollToLatest() async throws {
        XCTAssertFalse(state.showScrollToLatest,
                       "Should be false when following bottom")

        state.transition(to: .freeBrowsing)
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertTrue(state.showScrollToLatest,
                      "Should be true when in freeBrowsing mode")
        XCTAssertGreaterThan(state.uiVersion, 0)

        state.transition(to: .followingBottom)
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertFalse(state.showScrollToLatest,
                       "Should be false again after transitioning to followingBottom")
    }

    func testTailSpacerHeight() {
        XCTAssertEqual(state.tailSpacerHeight, 0,
                       "Should be 0 when not in pushToTop mode")

        state.viewportHeight = 600
        state.enterPushToTop(messageId: UUID())

        XCTAssertGreaterThan(state.tailSpacerHeight, 0,
                             "Should be positive when in pushToTop mode and viewport is finite")
        XCTAssertLessThanOrEqual(state.tailSpacerHeight, 600,
                                 "Should not exceed viewport height")
    }

    func testTailSpacerHeightZeroWhenViewportInfinite() {
        state.viewportHeight = .infinity
        state.enterPushToTop(messageId: UUID())

        XCTAssertEqual(state.tailSpacerHeight, 0,
                       "Should be 0 when viewport height is not finite")
    }

    // MARK: - uiVersion Coalescing

    func testUIVersionCoalescesMultipleChanges() async throws {
        let vBefore = state.uiVersion
        state.transition(to: .freeBrowsing)
        state.enterPushToTop(messageId: UUID())
        state.hideScrollIndicators = true
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(state.uiVersion, vBefore + 1,
                       "Multiple changes coalesce into one uiVersion bump")
        XCTAssertTrue(state.showScrollToLatest)
        XCTAssertTrue(state.showTailSpacer)
        XCTAssertTrue(state.scrollIndicatorsHidden)
    }

    func testSyncUIImmediately() {
        state.transition(to: .freeBrowsing)
        state.enterPushToTop(messageId: UUID())
        state.syncUIImmediately()
        XCTAssertTrue(state.showScrollToLatest)
        XCTAssertTrue(state.showTailSpacer)
        XCTAssertGreaterThan(state.uiVersion, 0)
    }

    // MARK: - Circuit Breaker

    func testCircuitBreakerTripsAfterRapidEvaluations() {
        for _ in 0...100 {
            state.recordBodyEvaluation()
        }
        XCTAssertTrue(state.isThrottled, "Circuit breaker should be active")
    }

    func testCircuitBreakerRecovery() async throws {
        for _ in 0...100 {
            state.recordBodyEvaluation()
        }
        XCTAssertTrue(state.isThrottled)
        try await Task.sleep(nanoseconds: 600_000_000)
        XCTAssertFalse(state.isThrottled, "Circuit breaker should auto-recover")
    }

    // MARK: - Pagination Cooldown

    func testPaginationCooldownResetOnConversationSwitch() {
        state.lastPaginationCompletedAt = Date()
        state.reset(for: UUID())
        XCTAssertEqual(state.lastPaginationCompletedAt, .distantPast)
    }

    func testScheduleUISyncSuppressedWhenThrottled() async throws {
        for _ in 0...100 {
            state.recordBodyEvaluation()
        }
        XCTAssertTrue(state.isThrottled)
        state.transition(to: .freeBrowsing)
        XCTAssertFalse(state.isFollowingBottom)
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertFalse(state.showScrollToLatest,
                       "showScrollToLatest should NOT update while throttled")
    }

    // MARK: - Programmatic Scroll Mode

    func testProgrammaticScrollMode() {
        state.transition(to: .programmaticScroll(reason: .deepLinkAnchor(id: UUID())))
        XCTAssertFalse(state.isFollowingBottom)
        XCTAssertFalse(state.mode.allowsAutoScroll)
    }

    func testProgrammaticScrollToFollowingBottomViaReachedBottom() {
        state.transition(to: .programmaticScroll(reason: .conversationSwitch))
        state.handleReachedBottom()
        XCTAssertTrue(state.isFollowingBottom)
    }
}
