import SwiftUI
import XCTest
@testable import VellumAssistantLib

@MainActor
final class MessageListScrollStateTests: XCTestCase {
    private var state: MessageListScrollState!
    private var scrollToCalls: [(id: AnyHashable, anchor: UnitPoint?)] = []
    private var scrollToEdgeCalls: [Edge] = []

    override func setUp() {
        super.setUp()
        state = MessageListScrollState()
        scrollToCalls = []
        scrollToEdgeCalls = []

        state.scrollTo = { [weak self] id, anchor in
            self?.scrollToCalls.append((id: id as! AnyHashable, anchor: anchor))
        }
        state.scrollToEdge = { [weak self] edge in
            self?.scrollToEdgeCalls.append(edge)
        }
    }

    override func tearDown() {
        state.cancelAll()
        state = nil
        super.tearDown()
    }

    // MARK: - Initial State

    func testInitialStateAllowsAutoScrollWithoutInteraction() {
        XCTAssertFalse(state.isFollowingBottom)
        XCTAssertFalse(state.hasBeenInteracted)
        XCTAssertTrue(state.mode.allowsAutoScroll)

        let result = state.requestPinToBottom()
        XCTAssertTrue(result, "initialLoad should still allow bottom pinning")
        // When lastMessageId is nil (fresh state), executeScrollToBottom
        // falls through to scrollToEdge(.bottom) — not scrollTo(id:).
        XCTAssertFalse(scrollToEdgeCalls.isEmpty,
                       "Should fall back to edge-based scroll when lastMessageId is nil")
        XCTAssertEqual(scrollToEdgeCalls.first, .bottom)
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
        // Seed lastMessageId so the ID-based path fires (not edge fallback).
        state.lastMessageId = UUID()
        let result = state.requestPinToBottom()

        XCTAssertTrue(result, "requestPinToBottom should return true when following bottom")
        // ID-based scroll fires synchronously (targets real ForEach content).
        // Edge-based is only used as fallback when lastMessageId is nil.
        XCTAssertFalse(scrollToCalls.isEmpty,
                       "scrollTo should have been called synchronously")
    }

    func testPinAllowedAfterTransitionToFollowingBottom() {
        state.transition(to: .freeBrowsing)
        let suppressed = state.requestPinToBottom()
        XCTAssertFalse(suppressed)
        XCTAssertTrue(scrollToCalls.isEmpty)

        state.transition(to: .followingBottom)
        // Seed lastMessageId so the ID-based path fires (not edge fallback).
        state.lastMessageId = UUID()
        let allowed = state.requestPinToBottom()
        XCTAssertTrue(allowed)
        XCTAssertFalse(scrollToCalls.isEmpty,
                       "ID-based scroll should proceed after transitioning to followingBottom")
    }

    func testUserInitiatedBypassesGuards() {
        state.transition(to: .freeBrowsing)
        state.beginStabilization(.expansion)

        let result = state.requestPinToBottom(userInitiated: true)

        XCTAssertTrue(result,
                      "User-initiated requests should always return true")
        // User-initiated uses ID-based scroll as primary (targets real
        // ForEach content, never overshoots) with edge-based correction
        // in a Task.
        XCTAssertFalse(scrollToCalls.isEmpty,
                       "User-initiated requests should bypass mode checks and scroll to ID")
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

    func testManualExpansionDetachesFollowingBottom() async throws {
        state.transition(to: .followingBottom)
        state.recoveryDeadline = Date().addingTimeInterval(2.0)
        state.scrollRestoreTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_000_000_000)
        }

        state.handleManualExpansionInteraction()

        XCTAssertTrue(state.isSuppressed,
                      "Manual expansion should enter stabilization while layout settles")
        XCTAssertFalse(state.isFollowingBottom,
                       "Manual expansion should detach from following-bottom mode")
        XCTAssertNil(state.recoveryDeadline,
                     "Manual expansion should cancel bottom recovery")
        XCTAssertNil(state.scrollRestoreTask,
                     "Manual expansion should cancel delayed restore pins")

        try await Task.sleep(nanoseconds: 250_000_000)

        XCTAssertFalse(state.isSuppressed,
                       "Expansion stabilization should still auto-clear")
        if case .freeBrowsing = state.mode {
            // correct
        } else {
            XCTFail("Manual expansion should settle into freeBrowsing")
        }
    }

    // MARK: - Deferred Bottom Pins

    func testDeferredBottomPinExecutesOnNextRunLoop() async throws {
        state.transition(to: .followingBottom)
        let lastId = UUID()
        state.lastMessageId = lastId

        state.scheduleDeferredBottomPin(animated: true)

        XCTAssertTrue(scrollToCalls.isEmpty,
                      "Deferred pin should not mutate scroll position synchronously")

        try await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertEqual(scrollToCalls.count, 1)
        XCTAssertEqual(scrollToCalls.first?.id, AnyHashable(lastId))
        XCTAssertEqual(scrollToCalls.first?.anchor, .bottom)
    }

    func testDeferredBottomPinCoalescesRepeatedRequests() async throws {
        state.transition(to: .followingBottom)
        let lastId = UUID()
        state.lastMessageId = lastId

        state.scheduleDeferredBottomPin(animated: true)
        state.scheduleDeferredBottomPin(animated: true)
        state.scheduleDeferredBottomPin(animated: true, forceFollowingBottom: true, refreshRecoveryWindow: true)

        try await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertEqual(scrollToCalls.count, 1,
                       "Repeated deferred pins from one update cycle should coalesce")
        XCTAssertTrue(state.isFollowingBottom)
        XCTAssertFalse(state.bottomAnchorAppeared)
        XCTAssertNotNil(state.recoveryDeadline)
    }

    func testDeferredBottomPinCancelledByReset() async throws {
        state.transition(to: .followingBottom)
        state.lastMessageId = UUID()

        state.scheduleDeferredBottomPin(animated: true)
        state.reset(for: UUID())

        try await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertTrue(scrollToCalls.isEmpty,
                      "Reset should cancel any deferred bottom pin from the old conversation")
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

        if case .initialLoad = state.mode {
            // correct
        } else {
            XCTFail("Reset should return to .initialLoad mode")
        }
        XCTAssertFalse(state.isFollowingBottom, "initialLoad is distinct from followingBottom")
        XCTAssertTrue(state.mode.allowsAutoScroll, "Reset should restore auto-scroll eligibility")
        XCTAssertFalse(state.showScrollToLatest, "Should sync showScrollToLatest immediately on reset")
        XCTAssertFalse(state.isSuppressed, "Should clear stabilization")
        XCTAssertFalse(state.isPaginationInFlight, "Should clear pagination flag")
        XCTAssertFalse(state.wasPaginationTriggerInRange, "Should clear trigger range flag")
        XCTAssertFalse(state.isAtBottom, "Should wait for fresh geometry before claiming bottom")
        XCTAssertFalse(state.hasBeenInteracted, "Should reset to initialLoad mode")
        XCTAssertEqual(state.currentConversationId, newId, "Should update conversation ID")
        XCTAssertTrue(state.hideScrollIndicators,
                      "Should hide scroll indicators during conversation switch")
        XCTAssertTrue(state.scrollIndicatorsHidden)
        XCTAssertFalse(state.showScrollToLatest)
    }

    func testResetClearsBottomAnchorAppeared() {
        state.bottomAnchorAppeared = true
        state.reset(for: UUID())
        XCTAssertFalse(state.bottomAnchorAppeared,
                       "Should reset bottomAnchorAppeared so recovery fires for new conversation")
    }

    func testResetClearsLastMessageId() {
        state.lastMessageId = UUID()
        state.reset(for: UUID())
        XCTAssertNil(state.lastMessageId,
                     "Should clear lastMessageId so it gets re-seeded for the new conversation")
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
        XCTAssertNil(state.cachedProjectionKey)
        XCTAssertNil(state.cachedProjection)
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

    // MARK: - Property-Level Tracking

    /// Verifies that each UI property reflects the final mode state after
    /// multiple transitions and a debounced sync.
    func testUIPropertiesReflectFinalState() async throws {
        // GIVEN multiple mode transitions ending in freeBrowsing
        state.transition(to: .followingBottom)
        state.transition(to: .freeBrowsing)

        // AND a scroll indicator change that requires a debounced sync
        state.hideScrollIndicators = true

        // WHEN the debounced sync fires
        try await Task.sleep(nanoseconds: 50_000_000)

        // THEN each property reflects the final mode (.freeBrowsing)
        XCTAssertTrue(state.showScrollToLatest,
                      "freeBrowsing mode shows scroll-to-latest")
        XCTAssertTrue(state.scrollIndicatorsHidden,
                      "scroll indicators should be hidden")
    }

    /// Verifies that syncUIImmediately bypasses debounce and updates all
    /// properties immediately.
    func testSyncUIImmediately() {
        // GIVEN freeBrowsing mode
        state.transition(to: .freeBrowsing)
        state.syncUIImmediately()

        // THEN properties reflect the current mode (.freeBrowsing)
        XCTAssertTrue(state.showScrollToLatest,
                      "freeBrowsing mode shows scroll-to-latest")
    }

    /// Verifies that syncUIImmediately reflects followingBottom correctly.
    func testSyncUIImmediatelyFollowingBottom() {
        // GIVEN followingBottom mode
        state.transition(to: .followingBottom)
        state.syncUIImmediately()

        // THEN properties reflect the current mode (.followingBottom)
        XCTAssertFalse(state.showScrollToLatest,
                       "followingBottom mode does not show scroll-to-latest")
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
        state.transition(to: .programmaticScroll(reason: .deepLinkAnchor(id: UUID())))
        state.handleReachedBottom()
        XCTAssertTrue(state.isFollowingBottom)
    }

    // MARK: - scrollPhase Reset

    func testResetClearsScrollPhase() {
        state.scrollPhase = .interacting
        state.reset(for: UUID())
        XCTAssertEqual(state.scrollPhase, .idle)
    }

    // MARK: - Coordinator-Backed Behavior

    /// Verifies that manual expansion detaches from follow-bottom via
    /// both the coordinator policy and the scrollState runtime executor.
    func testCoordinatorManualExpansionDetachesFollowingBottom() async throws {
        let coordinator = ScrollCoordinator()

        // Start following bottom via sending.
        _ = coordinator.handle(.sendingChanged(isSending: true))
        XCTAssertTrue(coordinator.isFollowingBottom)

        state.transition(to: .followingBottom)
        state.recoveryDeadline = Date().addingTimeInterval(2.0)

        // Simulate the coordinator path (what the view layer does).
        let intents = coordinator.handle(.manualExpansion)

        // Coordinator should detach and stabilize.
        XCTAssertTrue(coordinator.isSuppressed,
                      "Coordinator should enter stabilization on manual expansion")
        XCTAssertFalse(coordinator.isFollowingBottom,
                       "Coordinator should detach from following-bottom")
        XCTAssertTrue(intents.contains(.cancelRecoveryWindow),
                      "Coordinator should cancel recovery window")
        XCTAssertTrue(intents.contains(.showScrollToLatest),
                      "Coordinator should signal CTA should appear")

        // Simulate executor-side sync (what the view layer also does).
        state.handleManualExpansionInteraction()
        XCTAssertFalse(state.isFollowingBottom,
                       "ScrollState executor should also detach from following-bottom")
    }

    /// Verifies that scrolling up while streaming detaches and stays
    /// detached until an explicit reattach event (scroll to idle at bottom).
    func testCoordinatorScrollUpDuringStreamingStaysDetached() {
        let coordinator = ScrollCoordinator()

        // Start streaming (following bottom).
        _ = coordinator.handle(.sendingChanged(isSending: true))
        XCTAssertTrue(coordinator.isFollowingBottom)

        // User scrolls up — detach.
        _ = coordinator.handle(.manualBrowseIntent)
        XCTAssertEqual(coordinator.mode, .freeBrowsing)

        // New messages arrive while scrolled up.
        let messageIntents = coordinator.handle(.messageCountChanged)
        XCTAssertTrue(messageIntents.isEmpty,
                      "Should NOT auto-pin when free-browsing during streaming")
        XCTAssertEqual(coordinator.mode, .freeBrowsing,
                       "Should stay in free-browsing despite new messages")

        // User scrolls back to bottom and scroll settles.
        coordinator.updateBottomState(distanceFromBottom: 5)
        XCTAssertTrue(coordinator.isAtBottom)
        _ = coordinator.handle(.scrollPhaseChanged(phase: .interacting))
        _ = coordinator.handle(.scrollPhaseChanged(phase: .idle))
        XCTAssertTrue(coordinator.isFollowingBottom,
                      "Should reattach when user scrolls back to bottom and scroll settles")
    }

    /// Verifies that anchor/search jumps remain valid while free browsing
    /// and don't accidentally reattach to the bottom.
    func testCoordinatorAnchorJumpDuringFreeBrowsing() {
        let coordinator = ScrollCoordinator()

        // Detach into free browsing.
        _ = coordinator.handle(.manualBrowseIntent)
        XCTAssertEqual(coordinator.mode, .freeBrowsing)

        // Request an anchor jump (deep-link or search).
        let anchorId = ScrollCoordinator.AnchorID(UUID())
        let requestIntents = coordinator.handle(.anchorRequested(id: anchorId))

        // Should transition to programmatic scroll.
        if case .programmaticScroll = coordinator.mode {
            // correct
        } else {
            XCTFail("Expected programmaticScroll mode after anchor request in free-browsing")
        }
        XCTAssertTrue(requestIntents.contains(.cancelRecoveryWindow))

        // Anchor resolves.
        let resolveIntents = coordinator.handle(.anchorResolved(id: anchorId))
        XCTAssertTrue(resolveIntents.contains(.scrollToMessage(id: anchorId, anchor: .center)),
                      "Anchor resolution should produce scroll-to-message intent")
        XCTAssertNil(coordinator.pendingAnchor,
                     "Pending anchor should be cleared after resolution")
    }

    /// Verifies that the coordinator and scrollState both reset on
    /// conversation switch.
    func testCoordinatorResetOnConversationSwitch() {
        let coordinator = ScrollCoordinator()

        // Put coordinator in non-initial state.
        _ = coordinator.handle(.sendingChanged(isSending: true))
        _ = coordinator.handle(.manualBrowseIntent)
        coordinator.updateBottomState(distanceFromBottom: 100)
        XCTAssertEqual(coordinator.mode, .freeBrowsing)
        XCTAssertFalse(coordinator.isAtBottom)

        // Reset (what handleConversationSwitched does).
        coordinator.reset()

        XCTAssertEqual(coordinator.mode, .initialLoad)
        XCTAssertEqual(coordinator.phase, .idle)
        XCTAssertFalse(coordinator.isAtBottom)
        XCTAssertFalse(coordinator.hasBeenInteracted)
    }
}
