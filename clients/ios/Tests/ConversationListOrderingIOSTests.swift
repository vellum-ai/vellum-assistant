#if canImport(UIKit)
import XCTest

@testable import vellum_assistant_ios

@MainActor
final class ThreadListOrderingIOSTests: XCTestCase {
    func testConnectedModeSortsPinnedThenRecencyThenExplicitOrder() {
        let threads = [
            IOSThread(
                title: "explicit-late",
                lastActivityAt: Date(timeIntervalSince1970: 20),
                conversationId: "explicit-late",
                displayOrder: 2
            ),
            IOSThread(
                title: "recent",
                lastActivityAt: Date(timeIntervalSince1970: 50),
                conversationId: "recent"
            ),
            IOSThread(
                title: "pinned-second",
                lastActivityAt: Date(timeIntervalSince1970: 10),
                conversationId: "pinned-second",
                isPinned: true,
                displayOrder: 2
            ),
            IOSThread(
                title: "explicit-first",
                lastActivityAt: Date(timeIntervalSince1970: 30),
                conversationId: "explicit-first",
                displayOrder: 1
            ),
            IOSThread(
                title: "pinned-first",
                lastActivityAt: Date(timeIntervalSince1970: 40),
                conversationId: "pinned-first",
                isPinned: true,
                displayOrder: 1
            ),
            IOSThread(
                title: "older",
                lastActivityAt: Date(timeIntervalSince1970: 5),
                conversationId: "older"
            ),
        ]

        let sorted = sortThreadsForDisplay(threads, isConnectedMode: true)

        XCTAssertEqual(
            sorted.map(\.title),
            [
                "pinned-first",
                "pinned-second",
                "recent",
                "older",
                "explicit-first",
                "explicit-late",
            ]
        )
    }

    func testConnectedModeSortsPinnedThreadsWithoutOrderAfterOrderedPins() {
        let threads = [
            IOSThread(
                title: "pinned-unordered",
                lastActivityAt: Date(timeIntervalSince1970: 60),
                conversationId: "pinned-unordered",
                isPinned: true
            ),
            IOSThread(
                title: "pinned-second",
                lastActivityAt: Date(timeIntervalSince1970: 20),
                conversationId: "pinned-second",
                isPinned: true,
                displayOrder: 1
            ),
            IOSThread(
                title: "regular",
                lastActivityAt: Date(timeIntervalSince1970: 50),
                conversationId: "regular"
            ),
            IOSThread(
                title: "pinned-first",
                lastActivityAt: Date(timeIntervalSince1970: 10),
                conversationId: "pinned-first",
                isPinned: true,
                displayOrder: 0
            ),
        ]

        let sorted = sortThreadsForDisplay(threads, isConnectedMode: true)

        XCTAssertEqual(
            sorted.map(\.title),
            [
                "pinned-first",
                "pinned-second",
                "pinned-unordered",
                "regular",
            ]
        )
    }

    func testStandaloneModePreservesOriginalOrder() {
        let threads = [
            IOSThread(title: "first", conversationId: "first", isPinned: true, displayOrder: 1),
            IOSThread(title: "second", conversationId: "second"),
            IOSThread(title: "third", conversationId: "third", displayOrder: 1),
        ]

        let sorted = sortThreadsForDisplay(threads, isConnectedMode: false)

        XCTAssertEqual(sorted.map(\.title), ["first", "second", "third"])
    }
}
#endif
