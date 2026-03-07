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
                sessionId: "explicit-late",
                displayOrder: 2
            ),
            IOSThread(
                title: "recent",
                lastActivityAt: Date(timeIntervalSince1970: 50),
                sessionId: "recent"
            ),
            IOSThread(
                title: "pinned-second",
                lastActivityAt: Date(timeIntervalSince1970: 10),
                sessionId: "pinned-second",
                isPinned: true,
                displayOrder: 2
            ),
            IOSThread(
                title: "explicit-first",
                lastActivityAt: Date(timeIntervalSince1970: 30),
                sessionId: "explicit-first",
                displayOrder: 1
            ),
            IOSThread(
                title: "pinned-first",
                lastActivityAt: Date(timeIntervalSince1970: 40),
                sessionId: "pinned-first",
                isPinned: true,
                displayOrder: 1
            ),
            IOSThread(
                title: "older",
                lastActivityAt: Date(timeIntervalSince1970: 5),
                sessionId: "older"
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

    func testStandaloneModePreservesOriginalOrder() {
        let threads = [
            IOSThread(title: "first", sessionId: "first", isPinned: true, displayOrder: 1),
            IOSThread(title: "second", sessionId: "second"),
            IOSThread(title: "third", sessionId: "third", displayOrder: 1),
        ]

        let sorted = sortThreadsForDisplay(threads, isConnectedMode: false)

        XCTAssertEqual(sorted.map(\.title), ["first", "second", "third"])
    }
}
#endif
