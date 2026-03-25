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
}
