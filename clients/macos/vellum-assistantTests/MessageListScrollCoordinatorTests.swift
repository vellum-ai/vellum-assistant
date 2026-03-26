import SwiftUI
import XCTest
@testable import VellumAssistantLib

@MainActor
final class MessageListScrollCoordinatorTests: XCTestCase {
    private var coordinator: MessageListScrollCoordinator!
    private var scrollToCalls: [(id: AnyHashable, anchor: UnitPoint?)] = []

    override func setUp() {
        super.setUp()
        coordinator = MessageListScrollCoordinator()
        scrollToCalls = []

        coordinator.scrollTo = { [weak self] id, anchor in
            self?.scrollToCalls.append((id: id as! AnyHashable, anchor: anchor))
        }
    }

    override func tearDown() {
        coordinator.cancelAllTasks()
        coordinator = nil
        super.tearDown()
    }

    // MARK: - Follow/Detach State

    func testInitialStateIsFollowingBottom() {
        XCTAssertTrue(coordinator.isFollowingBottom)
    }

    func testScrollUpDetachesFromBottom() {
        coordinator.handleScrollUp()
        XCTAssertFalse(coordinator.isFollowingBottom)
    }

    func testRepeatedScrollUpDoesNotDuplicateDetach() {
        var isNearBottomUpdates: [Bool] = []
        coordinator.isNearBottomBinding = Binding<Bool>(
            get: { true },
            set: { isNearBottomUpdates.append($0) }
        )

        coordinator.handleScrollUp()
        coordinator.handleScrollUp()

        XCTAssertFalse(coordinator.isFollowingBottom)
        // Only one state change should fire (first detach).
        XCTAssertEqual(isNearBottomUpdates, [false])
    }

    func testScrollToBottomReattaches() {
        coordinator.handleScrollUp()
        XCTAssertFalse(coordinator.isFollowingBottom)

        coordinator.handleScrollToBottom()
        XCTAssertTrue(coordinator.isFollowingBottom)
    }

    func testPinRequestSuppressedWhileDetached() {
        let convId = UUID()
        coordinator.configureScrollCallbacks(
            scrollViewportHeight: 600,
            conversationId: convId,
            isNearBottom: .constant(true)
        )

        coordinator.handleScrollUp()
        coordinator.requestBottomPin(reason: .resize, conversationId: convId)

        XCTAssertTrue(scrollToCalls.isEmpty,
                      "Pin requests should be suppressed while detached")
    }

    func testPinRequestAllowedAfterReattach() {
        let convId = UUID()
        coordinator.configureScrollCallbacks(
            scrollViewportHeight: 600,
            conversationId: convId,
            isNearBottom: .constant(true)
        )

        coordinator.handleScrollUp()
        coordinator.requestBottomPin(reason: .messageCount, conversationId: convId)
        XCTAssertTrue(scrollToCalls.isEmpty)

        coordinator.handleScrollToBottom()
        coordinator.requestBottomPin(reason: .messageCount, conversationId: convId)
        XCTAssertFalse(scrollToCalls.isEmpty,
                       "Pin requests should proceed after reattach")
    }

    func testPinSuppressedWhileSuppressionActive() {
        let convId = UUID()
        coordinator.configureScrollCallbacks(
            scrollViewportHeight: 600,
            conversationId: convId,
            isNearBottom: .constant(true)
        )
        coordinator.reattachToBottom()

        coordinator.beginExpansionSuppression()
        coordinator.requestBottomPin(reason: .messageCount, conversationId: convId)

        XCTAssertTrue(scrollToCalls.isEmpty,
                      "Pin requests should be suppressed when isSuppressed is true")
    }

    func testUserInitiatedBypassesBothGuards() {
        let convId = UUID()
        coordinator.configureScrollCallbacks(
            scrollViewportHeight: 600,
            conversationId: convId,
            isNearBottom: .constant(true)
        )

        // Detach AND add suppression — both guards active.
        coordinator.handleScrollUp()
        coordinator.beginExpansionSuppression()

        coordinator.requestBottomPin(
            reason: .initialRestore,
            conversationId: convId,
            animated: false,
            userInitiated: true
        )

        XCTAssertFalse(scrollToCalls.isEmpty,
                       "User-initiated requests should bypass both follow-state and suppression checks")
    }

    func testResetRestoresFollowingState() {
        coordinator.handleScrollUp()
        XCTAssertFalse(coordinator.isFollowingBottom)

        coordinator.resetForConversationSwitch(
            oldConversationId: UUID(),
            newConversationId: UUID()
        )

        XCTAssertTrue(coordinator.isFollowingBottom)
    }

    // MARK: - makeResizeTask: Suppression Cleared Before Pin

    /// Regression test: `makeResizeTask` must clear suppression BEFORE requesting
    /// a bottom pin. If suppression is still active when the pin fires, the
    /// request is rejected (suppressed) and the scroll-to-bottom never happens.
    func testMakeResizeTaskPinsAfterSuppressionCleared() async throws {
        let convId = UUID()

        // Wire the scroll coordinator so pin requests flow through to scrollTo.
        coordinator.configureScrollCallbacks(
            scrollViewportHeight: 600,
            conversationId: convId,
            isNearBottom: .constant(true)
        )

        // Preconditions: near bottom but not at bottom, no anchor.
        coordinator.isAtBottom = false
        coordinator.reattachToBottom()

        var wasSuppressedDuringScroll: Bool?
        let originalScrollTo = coordinator.scrollTo
        coordinator.scrollTo = { [weak self] id, anchor in
            // Record whether suppression was active at the moment scrollTo fires.
            wasSuppressedDuringScroll = self?.coordinator.isSuppressed ?? true
            originalScrollTo?(id, anchor)
        }

        // Re-configure after swapping scrollTo so the coordinator
        // uses the new closure.
        coordinator.configureScrollCallbacks(
            scrollViewportHeight: 600,
            conversationId: convId,
            isNearBottom: .constant(true)
        )

        let completionExpectation = expectation(description: "resize task completed")
        let task = coordinator.makeResizeTask(
            conversationId: convId,
            isNearBottom: true,
            anchorMessageId: nil,
            onComplete: { completionExpectation.fulfill() }
        )

        await fulfillment(of: [completionExpectation], timeout: 2.0)
        _ = task // keep task alive

        // The pin should have fired (scrollTo was called).
        XCTAssertFalse(scrollToCalls.isEmpty,
                       "scrollTo should have been called — the bottom pin should fire after resize")

        // At the moment scrollTo was called, suppression must have been cleared.
        XCTAssertEqual(wasSuppressedDuringScroll, false,
                       "Suppression must be cleared before the pin request, not after")
    }

    // MARK: - restoreScrollToBottom: Delayed Fallback

    /// Regression test: when the coordinator is not at bottom, has no anchor,
    /// and has not received a scroll event, the delayed restore fallback should
    /// fire `requestBottomPin` after 100ms.
    func testRestoreScrollToBottomFallbackFiresWhenNotAtBottom() async throws {
        let convId = UUID()

        // Wire the scroll coordinator so pin requests flow through to scrollTo.
        coordinator.configureScrollCallbacks(
            scrollViewportHeight: 600,
            conversationId: convId,
            isNearBottom: .constant(true)
        )
        coordinator.reattachToBottom()

        // Preconditions: not at bottom, no anchor, no scroll events.
        coordinator.isAtBottom = false
        coordinator.hasReceivedScrollEvent = false

        var anchorMessageId: UUID? = nil
        let anchorBinding = Binding<UUID?>(
            get: { anchorMessageId },
            set: { anchorMessageId = $0 }
        )

        coordinator.restoreScrollToBottom(
            conversationId: convId,
            anchorMessageId: anchorBinding
        )

        // Wait for the 100ms delay plus a small margin.
        try await Task.sleep(nanoseconds: 200_000_000)

        // The fallback should have fired requestBottomPin, resulting in a scrollTo call.
        XCTAssertFalse(scrollToCalls.isEmpty,
                       "restoreScrollToBottom fallback should fire requestBottomPin when not at bottom")
        XCTAssertEqual(scrollToCalls.first?.id, "scroll-bottom-anchor" as AnyHashable,
                       "fallback should scroll to the bottom anchor")
    }

    // MARK: - restoreScrollToBottom: Deep-Link Anchor Prevents Fallback

    /// Regression test: when `anchorMessageId` is non-nil (deep-link in progress),
    /// `restoreScrollToBottom` must NOT fire `requestBottomPin` — the anchor guard
    /// prevents fighting between the deep-link scroll and the restore fallback.
    func testRestoreScrollToBottomRespectsDeepLinkAnchor() async throws {
        let convId = UUID()

        // Wire the scroll coordinator so pin requests flow through to scrollTo.
        coordinator.configureScrollCallbacks(
            scrollViewportHeight: 600,
            conversationId: convId,
            isNearBottom: .constant(true)
        )
        coordinator.reattachToBottom()

        // Preconditions: not at bottom, no scroll events, but anchor IS set.
        coordinator.isAtBottom = false
        coordinator.hasReceivedScrollEvent = false

        var anchorMessageId: UUID? = UUID() // non-nil deep-link anchor
        let anchorBinding = Binding<UUID?>(
            get: { anchorMessageId },
            set: { anchorMessageId = $0 }
        )

        coordinator.restoreScrollToBottom(
            conversationId: convId,
            anchorMessageId: anchorBinding
        )

        // Wait for the 100ms delay plus a small margin.
        try await Task.sleep(nanoseconds: 200_000_000)

        // The fallback should NOT have fired because anchorMessageId is non-nil.
        XCTAssertTrue(scrollToCalls.isEmpty,
                      "restoreScrollToBottom must not fire requestBottomPin when a deep-link anchor is set")
    }

    // MARK: - Suppression: Overlapping Reasons

    /// Expansion + pagination overlap: clearing one reason leaves the other active.
    func testExpansionAndPaginationOverlap() {
        coordinator.beginExpansionSuppression()
        coordinator.beginPaginationSuppression()
        XCTAssertTrue(coordinator.isSuppressed)

        coordinator.endPaginationSuppression()
        XCTAssertTrue(coordinator.isSuppressed, "Expansion is still active")

        coordinator.endExpansionSuppression()
        XCTAssertFalse(coordinator.isSuppressed, "All reasons cleared")
    }

    /// Expansion + resize overlap: clearing one reason leaves the other active.
    func testExpansionAndResizeOverlap() {
        coordinator.beginExpansionSuppression()
        coordinator.beginResizeSuppression()
        XCTAssertTrue(coordinator.isSuppressed)

        coordinator.endResizeSuppression()
        XCTAssertTrue(coordinator.isSuppressed, "Expansion is still active")

        coordinator.endExpansionSuppression()
        XCTAssertFalse(coordinator.isSuppressed, "All reasons cleared")
    }

    // MARK: - Suppression: clearAllSuppression

    /// Setting all three flags then calling clearAllSuppression clears everything.
    func testClearAllSuppression() {
        coordinator.beginResizeSuppression()
        coordinator.beginPaginationSuppression()
        coordinator.beginExpansionSuppression()

        XCTAssertTrue(coordinator.isResizeSuppressed)
        XCTAssertTrue(coordinator.isPaginationSuppressed)
        XCTAssertTrue(coordinator.isExpansionSuppressed)

        coordinator.clearAllSuppression()

        XCTAssertFalse(coordinator.isResizeSuppressed)
        XCTAssertFalse(coordinator.isPaginationSuppressed)
        XCTAssertFalse(coordinator.isExpansionSuppressed)
        XCTAssertFalse(coordinator.isSuppressed)
        XCTAssertNil(coordinator.expansionTimeoutTask,
                     "Expansion timeout task should be cancelled and nil'd")
    }

    // MARK: - Suppression: Conversation Switch / Disappear Cleanup

    /// resetForConversationSwitch clears all suppression flags.
    func testResetForConversationSwitchClearsSuppression() {
        coordinator.beginResizeSuppression()
        coordinator.beginPaginationSuppression()
        coordinator.beginExpansionSuppression()

        coordinator.resetForConversationSwitch(
            oldConversationId: UUID(),
            newConversationId: UUID()
        )

        XCTAssertFalse(coordinator.isResizeSuppressed)
        XCTAssertFalse(coordinator.isPaginationSuppressed)
        XCTAssertFalse(coordinator.isExpansionSuppressed)
        XCTAssertFalse(coordinator.isSuppressed)
    }

    /// cancelAllTasks clears all suppression flags.
    func testCancelAllTasksClearsSuppression() {
        coordinator.beginResizeSuppression()
        coordinator.beginPaginationSuppression()
        coordinator.beginExpansionSuppression()

        coordinator.cancelAllTasks()

        XCTAssertFalse(coordinator.isResizeSuppressed)
        XCTAssertFalse(coordinator.isPaginationSuppressed)
        XCTAssertFalse(coordinator.isExpansionSuppressed)
        XCTAssertFalse(coordinator.isSuppressed)
    }

    // MARK: - Suppression: Expansion 200ms Auto-Clear

    /// Expansion suppression auto-clears after the 200ms timeout.
    func testExpansionAutoClears() async throws {
        coordinator.beginExpansionSuppression()
        XCTAssertTrue(coordinator.isExpansionSuppressed)

        // Wait 250ms (200ms timeout + 50ms tolerance).
        try await Task.sleep(nanoseconds: 250_000_000)

        XCTAssertFalse(coordinator.isExpansionSuppressed,
                       "Expansion suppression should auto-clear after 200ms")
        XCTAssertFalse(coordinator.isSuppressed)
    }

    // MARK: - Suppression: Expansion Timer Reset

    /// Triggering expansion suppression a second time resets the 200ms timer.
    func testExpansionTimerReset() async throws {
        coordinator.beginExpansionSuppression()
        XCTAssertTrue(coordinator.isExpansionSuppressed)

        // Wait 100ms (halfway through original timeout).
        try await Task.sleep(nanoseconds: 100_000_000)

        // Re-trigger — this should reset the 200ms timer.
        coordinator.beginExpansionSuppression()
        XCTAssertTrue(coordinator.isExpansionSuppressed)

        // Wait 150ms — past the original 200ms but before the reset 200ms.
        try await Task.sleep(nanoseconds: 150_000_000)

        XCTAssertTrue(coordinator.isExpansionSuppressed,
                      "Timer was reset — should still be suppressed")

        // Wait remaining 100ms + tolerance (50ms past the reset timeout).
        try await Task.sleep(nanoseconds: 100_000_000)

        XCTAssertFalse(coordinator.isExpansionSuppressed,
                       "Expansion suppression should auto-clear after the reset timeout")
    }

    // MARK: - Suppression: Diagnostic Reason Output

    /// activeSuppressionReasons returns correct strings when multiple reasons are active.
    func testActiveSuppressionReasons() {
        XCTAssertEqual(coordinator.activeSuppressionReasons, [],
                       "No reasons active initially")

        coordinator.beginResizeSuppression()
        XCTAssertEqual(coordinator.activeSuppressionReasons, ["resize"])

        coordinator.beginExpansionSuppression()
        XCTAssertEqual(coordinator.activeSuppressionReasons, ["resize", "expansion"])

        coordinator.beginPaginationSuppression()
        XCTAssertEqual(coordinator.activeSuppressionReasons, ["resize", "pagination", "expansion"])

        coordinator.endResizeSuppression()
        XCTAssertEqual(coordinator.activeSuppressionReasons, ["pagination", "expansion"])

        coordinator.clearAllSuppression()
        XCTAssertEqual(coordinator.activeSuppressionReasons, [],
                       "Empty after clearAll")
    }

    // MARK: - Suppression: Snapshot String Format

    /// Verifies the comma-joined suppressionReason string that gets passed to
    /// ChatTranscriptSnapshot matches the expected format (e.g. "resize,expansion").
    /// This catches formatting bugs like wrong separator, trailing commas, or
    /// unexpected ordering that the array-level test above would not surface.
    func testSuppressionReasonJoinedStringFormat() {
        // No reasons → empty string (snapshot passes nil in this case).
        XCTAssertEqual(coordinator.activeSuppressionReasons.joined(separator: ","), "",
                       "No reasons should produce empty string")

        // Single reason.
        coordinator.beginResizeSuppression()
        XCTAssertEqual(coordinator.activeSuppressionReasons.joined(separator: ","), "resize",
                       "Single reason should produce plain string without separators")

        // Two reasons — mirrors the snapshot construction expression exactly.
        coordinator.beginExpansionSuppression()
        XCTAssertEqual(coordinator.activeSuppressionReasons.joined(separator: ","), "resize,expansion",
                       "Two reasons should be comma-separated with no spaces")

        // All three reasons.
        coordinator.beginPaginationSuppression()
        XCTAssertEqual(coordinator.activeSuppressionReasons.joined(separator: ","), "resize,pagination,expansion",
                       "Three reasons should be comma-separated in stable order")

        // After clearing one, the joined string updates correctly.
        coordinator.endResizeSuppression()
        XCTAssertEqual(coordinator.activeSuppressionReasons.joined(separator: ","), "pagination,expansion",
                       "Joined string should reflect remaining reasons after partial clear")

        // After clearing all, back to empty.
        coordinator.clearAllSuppression()
        XCTAssertEqual(coordinator.activeSuppressionReasons.joined(separator: ","), "",
                       "Joined string should be empty after clearAll")
    }
}
