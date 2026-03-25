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

    // MARK: - makeResizeTask: Suppression Cleared Before Pin

    /// Regression test: `makeResizeTask` must clear suppression BEFORE requesting
    /// a bottom pin. If suppression is still active when the pin fires, the
    /// `onPinRequested` callback returns false (suppressed) and the scroll-to-
    /// bottom never happens.
    func testMakeResizeTaskPinsAfterSuppressionCleared() async throws {
        let convId = UUID()

        // Wire the bottom pin coordinator so pin requests flow through to scrollTo.
        coordinator.configureBottomPinCoordinator(
            scrollViewportHeight: 600,
            conversationId: convId,
            isNearBottom: .constant(true)
        )

        // Preconditions: near bottom but not at bottom, no anchor.
        coordinator.isAtBottom = false
        coordinator.bottomPinCoordinator.reattach()

        var wasSuppressedDuringScroll: Bool?
        let originalScrollTo = coordinator.scrollTo
        coordinator.scrollTo = { [weak self] id, anchor in
            // Record whether suppression was active at the moment scrollTo fires.
            wasSuppressedDuringScroll = self?.coordinator.isSuppressed ?? true
            originalScrollTo?(id, anchor)
        }

        // Re-configure after swapping scrollTo so the pin coordinator callback
        // uses the new closure.
        coordinator.configureBottomPinCoordinator(
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

        // Wire the bottom pin coordinator so pin requests flow through to scrollTo.
        coordinator.configureBottomPinCoordinator(
            scrollViewportHeight: 600,
            conversationId: convId,
            isNearBottom: .constant(true)
        )
        coordinator.bottomPinCoordinator.reattach()

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

        // Wire the bottom pin coordinator so pin requests flow through to scrollTo.
        coordinator.configureBottomPinCoordinator(
            scrollViewportHeight: 600,
            conversationId: convId,
            isNearBottom: .constant(true)
        )
        coordinator.bottomPinCoordinator.reattach()

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
}
