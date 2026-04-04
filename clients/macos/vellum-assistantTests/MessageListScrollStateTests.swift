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

    /// Verifies that rapid transitions coalesce into a single UI sync.
    func testRapidTransitionsDoNotAccumulate() async throws {
        // GIVEN 100 rapid transitions to freeBrowsing
        for _ in 0..<100 {
            state.transition(to: .freeBrowsing)
        }

        // WHEN the debounced sync fires
        XCTAssertFalse(state.isFollowingBottom)
        XCTAssertFalse(state.showScrollToLatest)
        try await Task.sleep(nanoseconds: 50_000_000)

        // THEN only one property update occurs
        XCTAssertTrue(state.showScrollToLatest,
                      "showScrollToLatest should be true after debounced sync")
        XCTAssertEqual(state.uiVersion, 1,
                       "Only one internal uiVersion bump despite 100 transition calls")
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

    func testOverlappingStabilizationWaitsForAllWindows() {
        state.transition(to: .followingBottom)

        // Window 1: resize
        state.beginStabilization(.resize)
        XCTAssertTrue(state.isSuppressed)

        // Window 2: expansion (overlapping)
        state.beginStabilization(.expansion)
        XCTAssertTrue(state.isSuppressed)

        // Window 1 completes — should still be stabilizing
        state.endStabilization()
        XCTAssertTrue(state.isSuppressed,
                      "Should remain stabilizing while overlapping windows are active")

        // Window 2 completes — now should exit
        state.endStabilization()
        XCTAssertFalse(state.isSuppressed,
                       "Should exit stabilization after all windows complete")
        XCTAssertTrue(state.isFollowingBottom,
                      "Should restore followingBottom after overlapping stabilization")
    }

    func testOverlappingStabilizationPreservesOriginalMode() {
        state.transition(to: .freeBrowsing)

        state.beginStabilization(.resize)
        state.beginStabilization(.pagination)
        state.endStabilization()
        XCTAssertTrue(state.isSuppressed)

        state.endStabilization()
        XCTAssertFalse(state.isSuppressed)
        XCTAssertFalse(state.isFollowingBottom,
                       "Should restore freeBrowsing (original mode before any stabilization)")
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

    /// Verifies that showScrollToLatest tracks mode transitions independently.
    func testShowScrollToLatest() async throws {
        // GIVEN initial state
        XCTAssertFalse(state.showScrollToLatest,
                       "Should be false when following bottom")

        // WHEN transitioning to freeBrowsing
        state.transition(to: .freeBrowsing)
        try await Task.sleep(nanoseconds: 50_000_000)

        // THEN showScrollToLatest becomes true
        XCTAssertTrue(state.showScrollToLatest,
                      "Should be true when in freeBrowsing mode")

        // WHEN transitioning back to followingBottom
        state.transition(to: .followingBottom)
        try await Task.sleep(nanoseconds: 50_000_000)

        // THEN showScrollToLatest becomes false again
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

    // MARK: - Property-Level Tracking

    /// Verifies that each UI property reflects the final mode state after
    /// multiple transitions and a debounced sync.
    func testUIPropertiesReflectFinalState() async throws {
        // GIVEN multiple mode transitions ending in pushToTop
        state.transition(to: .freeBrowsing)
        state.enterPushToTop(messageId: UUID())

        // AND a scroll indicator change that requires a debounced sync
        state.hideScrollIndicators = true

        // WHEN the debounced sync fires
        try await Task.sleep(nanoseconds: 50_000_000)

        // THEN each property reflects the final mode (.pushToTop)
        XCTAssertFalse(state.showScrollToLatest,
                       "pushToTop mode does not show scroll-to-latest")
        XCTAssertTrue(state.showTailSpacer,
                      "pushToTop mode shows tail spacer")
        XCTAssertTrue(state.scrollIndicatorsHidden,
                      "scroll indicators should be hidden")
    }

    /// Verifies that syncUIImmediately bypasses debounce and updates all
    /// properties immediately.
    func testSyncUIImmediately() {
        // GIVEN pushToTop mode (enterPushToTop already calls syncUIImmediately)
        state.enterPushToTop(messageId: UUID())

        // THEN properties reflect the current mode (.pushToTop)
        XCTAssertFalse(state.showScrollToLatest,
                       "pushToTop mode does not show scroll-to-latest")
        XCTAssertTrue(state.showTailSpacer,
                      "pushToTop mode shows tail spacer")
    }

    /// Verifies that consumePendingPushToTop fires a scroll when a pending
    /// target exists and mode is pushToTop.
    func testConsumePendingPushToTop() {
        // GIVEN push-to-top mode with a pending target
        let messageId = UUID()
        state.enterPushToTop(messageId: messageId)

        // WHEN consuming the pending target
        state.consumePendingPushToTop()

        // THEN a scroll-to call was made for the target
        XCTAssertFalse(scrollToCalls.isEmpty,
                       "consumePendingPushToTop should trigger a scrollTo call")
        XCTAssertEqual(scrollToCalls.last?.id, messageId as AnyHashable)

        // AND the pending target is cleared
        XCTAssertNil(state.pendingPushToTopTarget)
    }

    /// Verifies that consumePendingPushToTop is a no-op when not in pushToTop mode.
    func testConsumePendingPushToTopNoopWhenNotPushToTop() {
        // GIVEN followingBottom mode (no pending target)
        state.transition(to: .followingBottom)

        // WHEN consuming
        state.consumePendingPushToTop()

        // THEN no scroll call is made
        XCTAssertTrue(scrollToCalls.isEmpty)
    }

    /// Verifies that re-entering pushToTop when the tail spacer is already
    /// showing consumes the target immediately via syncUISnapshots.
    func testReEnterPushToTopConsumesImmediately() {
        // GIVEN an initial push-to-top that renders the tail spacer
        let firstId = UUID()
        state.enterPushToTop(messageId: firstId)
        state.syncUIImmediately()
        XCTAssertTrue(state.showTailSpacer)
        state.consumePendingPushToTop()
        scrollToCalls.removeAll()

        // WHEN entering push-to-top again (tail spacer already showing)
        let secondId = UUID()
        state.enterPushToTop(messageId: secondId)

        // THEN the target is consumed immediately (re-enter path)
        XCTAssertFalse(scrollToCalls.isEmpty,
                       "Re-enter push-to-top should consume target immediately")
        XCTAssertEqual(scrollToCalls.last?.id, secondId as AnyHashable)
        XCTAssertNil(state.pendingPushToTopTarget)
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
