import Foundation
import XCTest
@testable import VellumAssistantLib

@MainActor
final class MessageListScrollGeometryDispatcherTests: XCTestCase {

    func testEnqueueDefersDeliveryAndCoalescesToLatestSnapshot() async {
        let dispatcher = ScrollGeometryUpdateDispatcher()
        let owner = MessageListScrollState()
        let delivered = expectation(description: "geometry delivered")

        let first = ScrollGeometrySnapshot(
            contentOffsetY: 1,
            contentHeight: 100,
            containerHeight: 80,
            visibleRectHeight: 80
        )
        let second = ScrollGeometrySnapshot(
            contentOffsetY: 2,
            contentHeight: 120,
            containerHeight: 80,
            visibleRectHeight: 80
        )

        var received: [ScrollGeometrySnapshot] = []
        let handler: @MainActor (ScrollGeometrySnapshot) -> Void = { snapshot in
            received.append(snapshot)
            delivered.fulfill()
        }

        dispatcher.enqueue(for: owner, snapshot: first, handler: handler)
        dispatcher.enqueue(for: owner, snapshot: second, handler: handler)

        XCTAssertTrue(received.isEmpty, "Geometry updates should not run inline inside the modifier callback")

        await fulfillment(of: [delivered], timeout: 1.0)
        XCTAssertEqual(received, [second])
    }

    func testEnqueueDuringHandlerSchedulesFollowUpOnLaterMainQueueTurn() async {
        let dispatcher = ScrollGeometryUpdateDispatcher()
        let owner = MessageListScrollState()
        let markerReached = expectation(description: "marker reached")
        let secondDelivery = expectation(description: "second delivery")

        let first = ScrollGeometrySnapshot(
            contentOffsetY: 10,
            contentHeight: 200,
            containerHeight: 100,
            visibleRectHeight: 100
        )
        let second = ScrollGeometrySnapshot(
            contentOffsetY: 20,
            contentHeight: 220,
            containerHeight: 100,
            visibleRectHeight: 100
        )

        var trace: [String] = []
        var handler: (@MainActor (ScrollGeometrySnapshot) -> Void)!
        handler = { snapshot in
            if snapshot == first {
                trace.append("first-start")
                dispatcher.enqueue(for: owner, snapshot: second, handler: handler)
                DispatchQueue.main.async {
                    trace.append("marker")
                    markerReached.fulfill()
                }
                trace.append("first-end")
            } else {
                trace.append("second")
                secondDelivery.fulfill()
            }
        }

        dispatcher.enqueue(for: owner, snapshot: first, handler: handler)

        await fulfillment(of: [markerReached, secondDelivery], timeout: 1.0)
        XCTAssertEqual(trace, ["first-start", "first-end", "marker", "second"])
    }

    func testCancelInvalidatesPendingDrain() async {
        let dispatcher = ScrollGeometryUpdateDispatcher()
        let owner = MessageListScrollState()

        let snapshot = ScrollGeometrySnapshot(
            contentOffsetY: 5,
            contentHeight: 200,
            containerHeight: 100,
            visibleRectHeight: 100
        )

        var handlerCalled = false
        dispatcher.enqueue(for: owner, snapshot: snapshot) { _ in
            handlerCalled = true
        }
        dispatcher.cancel(for: owner)

        // Allow the run loop to drain so the scheduled DispatchQueue.main.async
        // block executes (it should see a mismatched generation and bail out).
        let drained = expectation(description: "run loop drained")
        DispatchQueue.main.async { drained.fulfill() }
        await fulfillment(of: [drained], timeout: 1.0)

        XCTAssertFalse(handlerCalled, "Handler must not be invoked after cancel(for:) invalidates the pending drain")
    }
}
