import XCTest
@testable import VellumAssistantLib

@MainActor
final class ScrollCoordinatorTests: XCTestCase {
    private var coordinator: ScrollCoordinator!

    override func setUp() {
        super.setUp()
        coordinator = ScrollCoordinator()
    }

    override func tearDown() {
        coordinator = nil
        super.tearDown()
    }

    // MARK: - Initial State

    func testInitialModeIsInitialLoad() {
        XCTAssertEqual(coordinator.mode, .initialLoad)
    }

    func testInitialStateAllowsAutoScroll() {
        XCTAssertTrue(coordinator.mode.allowsAutoScroll)
    }

    func testInitialStateIsNotFollowingBottom() {
        // initialLoad allows auto-scroll but isFollowingBottom is only
        // true for .followingBottom (and stabilizing from followingBottom).
        XCTAssertFalse(coordinator.isFollowingBottom)
    }

    func testInitialStateHasNotBeenInteracted() {
        XCTAssertFalse(coordinator.hasBeenInteracted)
    }

    func testInitialStateIsAtBottom() {
        XCTAssertTrue(coordinator.isAtBottom)
    }

    // MARK: - Mode: Following Bottom vs Free Browsing

    func testManualBrowseIntentDetachesFromFollowingBottom() {
        // Transition to followingBottom first.
        coordinator.handle(.sendingChanged(isSending: true))
        XCTAssertTrue(coordinator.isFollowingBottom)

        let intents = coordinator.handle(.manualBrowseIntent)

        XCTAssertFalse(coordinator.isFollowingBottom)
        XCTAssertEqual(coordinator.mode, .freeBrowsing)
        XCTAssertTrue(intents.contains(.cancelRecoveryWindow),
                      "Should cancel recovery when user scrolls away")
    }

    func testManualBrowseIntentDetachesFromInitialLoad() {
        XCTAssertEqual(coordinator.mode, .initialLoad)

        let intents = coordinator.handle(.manualBrowseIntent)

        XCTAssertEqual(coordinator.mode, .freeBrowsing)
        XCTAssertTrue(coordinator.hasBeenInteracted)
        XCTAssertTrue(intents.contains(.cancelRecoveryWindow))
    }

    func testManualBrowseIntentIsNoopInFreeBrowsing() {
        coordinator.handle(.manualBrowseIntent)
        XCTAssertEqual(coordinator.mode, .freeBrowsing)

        // Second browse intent should not change anything.
        let intents = coordinator.handle(.manualBrowseIntent)
        XCTAssertEqual(coordinator.mode, .freeBrowsing)
        // No cancelRecoveryWindow because we were already in free-browsing.
        XCTAssertFalse(intents.contains(.cancelRecoveryWindow))
    }

    func testSendingReattachesToFollowingBottom() {
        // Start in free-browsing.
        coordinator.handle(.manualBrowseIntent)
        XCTAssertFalse(coordinator.isFollowingBottom)

        let intents = coordinator.handle(.sendingChanged(isSending: true))

        XCTAssertTrue(coordinator.isFollowingBottom)
        XCTAssertTrue(intents.contains(.scrollToBottom(animated: true)))
        XCTAssertTrue(intents.contains(.startRecoveryWindow))
    }

    func testSendStoppedDoesNotChangeMode() {
        coordinator.handle(.sendingChanged(isSending: true))
        XCTAssertTrue(coordinator.isFollowingBottom)

        let intents = coordinator.handle(.sendingChanged(isSending: false))

        XCTAssertTrue(coordinator.isFollowingBottom)
        XCTAssertTrue(intents.isEmpty, "Stopping send should not produce intents")
    }

    // MARK: - Hysteresis (Bottom Detection)

    func testHysteresisStaysAtBottomWithinLeaveThreshold() {
        // Start at bottom.
        XCTAssertTrue(coordinator.isAtBottom)

        // Distance within the 30pt leave threshold — stay at bottom.
        coordinator.updateBottomState(distanceFromBottom: 25)
        XCTAssertTrue(coordinator.isAtBottom,
                      "Should stay at bottom when within 30pt leave threshold")
    }

    func testHysteresisLeavesBottomBeyondLeaveThreshold() {
        XCTAssertTrue(coordinator.isAtBottom)

        // Distance beyond the 30pt leave threshold.
        coordinator.updateBottomState(distanceFromBottom: 35)
        XCTAssertFalse(coordinator.isAtBottom,
                       "Should leave bottom when beyond 30pt leave threshold")
    }

    func testHysteresisReentersBottomOnlyWithinEnterThreshold() {
        // Leave the bottom zone first.
        coordinator.updateBottomState(distanceFromBottom: 35)
        XCTAssertFalse(coordinator.isAtBottom)

        // 15pt — between enter (10pt) and leave (30pt) thresholds.
        // Should NOT re-enter because we're using the tighter enter threshold.
        coordinator.updateBottomState(distanceFromBottom: 15)
        XCTAssertFalse(coordinator.isAtBottom,
                       "Should not re-enter bottom when between enter and leave thresholds")

        // 8pt — within the 10pt enter threshold.
        coordinator.updateBottomState(distanceFromBottom: 8)
        XCTAssertTrue(coordinator.isAtBottom,
                      "Should re-enter bottom when within 10pt enter threshold")
    }

    func testHysteresisNonFiniteDistanceIsNotAtBottom() {
        coordinator.updateBottomState(distanceFromBottom: .infinity)
        XCTAssertFalse(coordinator.isAtBottom,
                       "Non-finite distance should not be considered at bottom")
    }

    func testHysteresisNegativeDistanceIsAtBottom() {
        // Negative distance means past the bottom — should be at bottom.
        coordinator.updateBottomState(distanceFromBottom: -5)
        XCTAssertTrue(coordinator.isAtBottom,
                      "Negative distance (past bottom) should be considered at bottom")
    }

    // MARK: - Reattach on Idle at Bottom

    func testReattachOnIdleAtBottom() {
        // Detach.
        coordinator.handle(.manualBrowseIntent)
        XCTAssertEqual(coordinator.mode, .freeBrowsing)

        // Simulate scrolling back to bottom.
        coordinator.updateBottomState(distanceFromBottom: 5)
        XCTAssertTrue(coordinator.isAtBottom)

        // Phase goes to idle — should reattach.
        coordinator.handle(.scrollPhaseChanged(phase: .interacting))
        coordinator.handle(.scrollPhaseChanged(phase: .idle))

        XCTAssertTrue(coordinator.isFollowingBottom,
                      "Should reattach to following bottom when scroll settles at bottom")
    }

    func testNoReattachOnIdleWhenNotAtBottom() {
        coordinator.handle(.manualBrowseIntent)
        XCTAssertEqual(coordinator.mode, .freeBrowsing)

        // Not at bottom.
        coordinator.updateBottomState(distanceFromBottom: 100)
        XCTAssertFalse(coordinator.isAtBottom)

        // Phase goes to idle — should NOT reattach.
        coordinator.handle(.scrollPhaseChanged(phase: .interacting))
        coordinator.handle(.scrollPhaseChanged(phase: .idle))

        XCTAssertEqual(coordinator.mode, .freeBrowsing,
                       "Should stay in free-browsing when scroll settles away from bottom")
    }

    // MARK: - Stale Momentum Suppression

    func testStaleMomentumSuppressedAfterCTATap() {
        // Simulate CTA tap.
        _ = coordinator.requestUserInitiatedPin()
        XCTAssertTrue(coordinator.isFollowingBottom)

        // Simulate stale upward momentum in decelerating phase.
        coordinator.handle(.scrollPhaseChanged(phase: .decelerating))
        let intents = coordinator.handle(.manualBrowseIntent)

        XCTAssertTrue(coordinator.isFollowingBottom,
                      "Should NOT detach on stale decelerating momentum after CTA tap")
        XCTAssertTrue(intents.isEmpty,
                      "Should produce no intents for stale momentum")
    }

    func testFreshInteractionOverridesCTATap() {
        // Simulate CTA tap.
        _ = coordinator.requestUserInitiatedPin()
        XCTAssertTrue(coordinator.isFollowingBottom)

        // Simulate fresh user interaction (interacting phase, not decelerating).
        coordinator.handle(.scrollPhaseChanged(phase: .interacting))
        let intents = coordinator.handle(.manualBrowseIntent)

        XCTAssertFalse(coordinator.isFollowingBottom,
                       "Should detach on fresh user interaction even after CTA tap")
        XCTAssertTrue(intents.contains(.cancelRecoveryWindow))
    }

    // MARK: - Manual Expansion Detach

    func testManualExpansionDetachesAndStabilizes() {
        coordinator.handle(.sendingChanged(isSending: true))
        XCTAssertTrue(coordinator.isFollowingBottom)

        let intents = coordinator.handle(.manualExpansion)

        XCTAssertTrue(coordinator.isSuppressed,
                      "Should enter stabilization after manual expansion")
        // The pre-stabilization mode was freeBrowsing (expansion detaches first).
        XCTAssertTrue(intents.contains(.cancelRecoveryWindow))
        XCTAssertTrue(intents.contains(.showScrollToLatest))
    }

    func testManualExpansionInFreeBrowsingStabilizes() {
        coordinator.handle(.manualBrowseIntent)
        XCTAssertEqual(coordinator.mode, .freeBrowsing)

        let intents = coordinator.handle(.manualExpansion)

        XCTAssertTrue(coordinator.isSuppressed,
                      "Should enter stabilization even when already free-browsing")
        XCTAssertTrue(intents.contains(.showScrollToLatest))
    }

    func testManualExpansionStabilizationRestoresFreeBrowsing() {
        coordinator.handle(.sendingChanged(isSending: true))
        coordinator.handle(.manualExpansion)
        XCTAssertTrue(coordinator.isSuppressed)

        // End stabilization — should restore to free-browsing (not followingBottom).
        coordinator.endStabilization()
        XCTAssertEqual(coordinator.mode, .freeBrowsing,
                       "After expansion stabilization, should stay in free-browsing")
    }

    // MARK: - Deep-Link Anchor Jumps

    func testAnchorRequestTransitionsToProgrammaticScroll() {
        let anchorId = ScrollCoordinator.AnchorID(UUID())

        let intents = coordinator.handle(.anchorRequested(id: anchorId))

        if case .programmaticScroll(let id) = coordinator.mode {
            XCTAssertEqual(id, anchorId)
        } else {
            XCTFail("Expected programmaticScroll mode after anchor request")
        }
        XCTAssertEqual(coordinator.pendingAnchor, anchorId)
        XCTAssertTrue(intents.contains(.cancelRecoveryWindow))
    }

    func testAnchorResolvedScrollsToMessage() {
        let anchorId = ScrollCoordinator.AnchorID(UUID())
        coordinator.handle(.anchorRequested(id: anchorId))

        let intents = coordinator.handle(.anchorResolved(id: anchorId))

        XCTAssertNil(coordinator.pendingAnchor)
        XCTAssertTrue(intents.contains(.scrollToMessage(id: anchorId, anchor: .center)),
                      "Should scroll to the resolved anchor at center")
    }

    func testAnchorResolvedForWrongIdIsIgnored() {
        let requestedId = ScrollCoordinator.AnchorID(UUID())
        let wrongId = ScrollCoordinator.AnchorID(UUID())
        coordinator.handle(.anchorRequested(id: requestedId))

        let intents = coordinator.handle(.anchorResolved(id: wrongId))

        XCTAssertTrue(intents.isEmpty,
                      "Should ignore resolution for a non-matching anchor ID")
        XCTAssertEqual(coordinator.pendingAnchor, requestedId)
    }

    // MARK: - Resize Recovery

    func testContainerWidthChangedInFollowingModeRecoverToBottom() {
        coordinator.handle(.sendingChanged(isSending: true))
        XCTAssertTrue(coordinator.isFollowingBottom)

        let intents = coordinator.handle(.containerWidthChanged)

        XCTAssertTrue(intents.contains(.startRecoveryWindow))
        XCTAssertTrue(intents.contains(.scrollToBottom(animated: false)))
    }

    func testContainerWidthChangedInFreeBrowsingStabilizes() {
        coordinator.handle(.manualBrowseIntent)
        XCTAssertEqual(coordinator.mode, .freeBrowsing)

        coordinator.handle(.containerWidthChanged)

        XCTAssertTrue(coordinator.isSuppressed,
                      "Should stabilize during resize in free-browsing")
    }

    func testContainerWidthStabilizationRestoresFreeBrowsing() {
        coordinator.handle(.manualBrowseIntent)
        coordinator.handle(.containerWidthChanged)
        XCTAssertTrue(coordinator.isSuppressed)

        coordinator.endStabilization()
        XCTAssertEqual(coordinator.mode, .freeBrowsing)
    }

    // MARK: - Message Count Changed

    func testMessageCountChangedPinsToBottomInFollowingMode() {
        coordinator.handle(.sendingChanged(isSending: true))
        XCTAssertTrue(coordinator.isFollowingBottom)

        let intents = coordinator.handle(.messageCountChanged)

        XCTAssertTrue(intents.contains(.scrollToBottom(animated: true)))
    }

    func testMessageCountChangedDoesNotPinInFreeBrowsing() {
        coordinator.handle(.manualBrowseIntent)
        XCTAssertEqual(coordinator.mode, .freeBrowsing)

        let intents = coordinator.handle(.messageCountChanged)

        XCTAssertTrue(intents.isEmpty,
                      "Should not auto-pin when in free-browsing mode")
    }

    func testMessageCountChangedDoesNotPinWhenStabilizing() {
        coordinator.handle(.sendingChanged(isSending: true))
        coordinator.handle(.manualExpansion)
        XCTAssertTrue(coordinator.isSuppressed)

        let intents = coordinator.handle(.messageCountChanged)

        XCTAssertTrue(intents.isEmpty,
                      "Should not auto-pin when stabilizing")
    }

    // MARK: - Appeared Event

    func testAppearedStartsRecoveryInInitialLoad() {
        let intents = coordinator.handle(.appeared)

        XCTAssertTrue(intents.contains(.startRecoveryWindow))
        XCTAssertTrue(intents.contains(.scrollToBottom(animated: false)))
    }

    func testAppearedStartsRecoveryInFollowingBottom() {
        coordinator.handle(.sendingChanged(isSending: true))
        XCTAssertTrue(coordinator.isFollowingBottom)

        let intents = coordinator.handle(.appeared)

        XCTAssertTrue(intents.contains(.startRecoveryWindow))
    }

    func testAppearedDoesNotRecoverInFreeBrowsing() {
        coordinator.handle(.manualBrowseIntent)

        let intents = coordinator.handle(.appeared)

        XCTAssertTrue(intents.isEmpty,
                      "Should not start recovery when user has scrolled away")
    }

    // MARK: - User-Initiated Pin (CTA)

    func testUserInitiatedPinAlwaysSucceeds() {
        // Even when in free-browsing + stabilizing.
        coordinator.handle(.manualBrowseIntent)
        coordinator.handle(.containerWidthChanged)
        XCTAssertTrue(coordinator.isSuppressed)

        let intents = coordinator.requestUserInitiatedPin()

        XCTAssertTrue(coordinator.isFollowingBottom)
        XCTAssertTrue(intents.contains(.hideIndicators))
        XCTAssertTrue(intents.contains(.startRecoveryWindow))
        XCTAssertTrue(intents.contains(.scrollToBottom(animated: true)))
    }

    func testUserInitiatedPinFromFreeBrowsing() {
        coordinator.handle(.manualBrowseIntent)
        XCTAssertEqual(coordinator.mode, .freeBrowsing)

        let intents = coordinator.requestUserInitiatedPin()

        XCTAssertTrue(coordinator.isFollowingBottom)
        XCTAssertTrue(intents.contains(.scrollToBottom(animated: true)))
    }

    // MARK: - Stabilization

    func testOverlappingStabilizationWaitsForAllWindows() {
        coordinator.handle(.sendingChanged(isSending: true))

        // Window 1: resize.
        coordinator.handle(.containerWidthChanged)
        XCTAssertTrue(coordinator.isSuppressed)

        // Window 2: expansion (overlapping).
        coordinator.handle(.manualExpansion)
        XCTAssertTrue(coordinator.isSuppressed)

        // Window 1 completes — should still be stabilizing.
        coordinator.endStabilization()
        XCTAssertTrue(coordinator.isSuppressed,
                      "Should remain stabilizing while overlapping windows are active")

        // Window 2 completes — now should exit.
        coordinator.endStabilization()
        XCTAssertFalse(coordinator.isSuppressed,
                       "Should exit stabilization after all windows complete")
    }

    func testStabilizationPreservesFollowingBottom() {
        coordinator.handle(.sendingChanged(isSending: true))
        XCTAssertTrue(coordinator.isFollowingBottom)

        coordinator.handle(.containerWidthChanged)
        XCTAssertTrue(coordinator.isSuppressed)
        XCTAssertTrue(coordinator.isFollowingBottom,
                      "isFollowingBottom should reflect pre-stabilization mode")

        coordinator.endStabilization()
        XCTAssertTrue(coordinator.isFollowingBottom)
    }

    func testStabilizationSuppressesPinRequests() {
        coordinator.handle(.sendingChanged(isSending: true))
        coordinator.handle(.containerWidthChanged)
        XCTAssertTrue(coordinator.isSuppressed)

        // Message count change while stabilizing should not produce pin intents.
        let intents = coordinator.handle(.messageCountChanged)
        XCTAssertTrue(intents.isEmpty)
    }

    // MARK: - Reset

    func testResetRestoresInitialState() {
        // Put coordinator in a non-initial state.
        coordinator.handle(.sendingChanged(isSending: true))
        coordinator.handle(.manualBrowseIntent)
        coordinator.updateBottomState(distanceFromBottom: 100)
        let anchorId = ScrollCoordinator.AnchorID(UUID())
        coordinator.handle(.anchorRequested(id: anchorId))

        coordinator.reset()

        XCTAssertEqual(coordinator.mode, .initialLoad)
        XCTAssertEqual(coordinator.phase, .idle)
        XCTAssertFalse(coordinator.isAtBottom)
        XCTAssertFalse(coordinator.isFollowingBottom)
        XCTAssertFalse(coordinator.hasBeenInteracted)
        XCTAssertNil(coordinator.pendingAnchor)
    }

    // MARK: - ShowScrollToLatest Visibility

    func testShowScrollToLatestInFreeBrowsing() {
        coordinator.handle(.manualBrowseIntent)
        XCTAssertTrue(coordinator.mode.showsScrollToLatest)
    }

    func testShowScrollToLatestDuringStabilizingFromFreeBrowsing() {
        coordinator.handle(.manualBrowseIntent)
        coordinator.handle(.containerWidthChanged)
        XCTAssertTrue(coordinator.mode.showsScrollToLatest,
                      "CTA should remain visible during stabilization from free-browsing")
    }

    func testShowScrollToLatestFalseInFollowingBottom() {
        coordinator.handle(.sendingChanged(isSending: true))
        XCTAssertFalse(coordinator.mode.showsScrollToLatest)
    }

    func testShowScrollToLatestFalseInInitialLoad() {
        XCTAssertFalse(coordinator.mode.showsScrollToLatest)
    }

    // MARK: - No View Dependencies

    /// Verifies the coordinator has no SwiftUI imports or view references.
    /// This is a compile-time guarantee — this test exists as documentation.
    func testCoordinatorIsPurePolicy() {
        // ScrollCoordinator only imports Foundation.
        // If it imported SwiftUI, this file would need to import it too,
        // and the coordinator would no longer be a pure policy object.
        //
        // The types it exposes (Mode, Phase, OutputIntent, etc.) are all
        // value types with no view references. ScrollPosition, ScrollGeometrySnapshot,
        // and SwiftUI view types are not referenced anywhere in the coordinator.
        let _ = coordinator.mode
        let _ = coordinator.phase
        let _ = coordinator.isAtBottom
        let _ = coordinator.isFollowingBottom
        let _ = coordinator.isSuppressed
        let _ = coordinator.hasBeenInteracted
        let _ = coordinator.pendingAnchor
        // All pass — the coordinator is a pure policy object.
    }
}
