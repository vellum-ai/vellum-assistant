#if canImport(UIKit)
import XCTest

@testable import vellum_assistant_ios

@MainActor
final class ConversationListOrderingIOSTests: XCTestCase {
    func testConnectedModeSortsPinnedThenRecencyThenExplicitOrder() {
        let conversations = [
            IOSConversation(
                title: "explicit-late",
                lastActivityAt: Date(timeIntervalSince1970: 20),
                conversationId: "explicit-late",
                displayOrder: 2
            ),
            IOSConversation(
                title: "recent",
                lastActivityAt: Date(timeIntervalSince1970: 50),
                conversationId: "recent"
            ),
            IOSConversation(
                title: "pinned-second",
                lastActivityAt: Date(timeIntervalSince1970: 10),
                conversationId: "pinned-second",
                isPinned: true,
                displayOrder: 2
            ),
            IOSConversation(
                title: "explicit-first",
                lastActivityAt: Date(timeIntervalSince1970: 30),
                conversationId: "explicit-first",
                displayOrder: 1
            ),
            IOSConversation(
                title: "pinned-first",
                lastActivityAt: Date(timeIntervalSince1970: 40),
                conversationId: "pinned-first",
                isPinned: true,
                displayOrder: 1
            ),
            IOSConversation(
                title: "older",
                lastActivityAt: Date(timeIntervalSince1970: 5),
                conversationId: "older"
            ),
        ]

        let sorted = sortConversationsForDisplay(conversations, isConnectedMode: true)

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

    func testConnectedModeSortsPinnedConversationsWithoutOrderAfterOrderedPins() {
        let conversations = [
            IOSConversation(
                title: "pinned-unordered",
                lastActivityAt: Date(timeIntervalSince1970: 60),
                conversationId: "pinned-unordered",
                isPinned: true
            ),
            IOSConversation(
                title: "pinned-second",
                lastActivityAt: Date(timeIntervalSince1970: 20),
                conversationId: "pinned-second",
                isPinned: true,
                displayOrder: 1
            ),
            IOSConversation(
                title: "regular",
                lastActivityAt: Date(timeIntervalSince1970: 50),
                conversationId: "regular"
            ),
            IOSConversation(
                title: "pinned-first",
                lastActivityAt: Date(timeIntervalSince1970: 10),
                conversationId: "pinned-first",
                isPinned: true,
                displayOrder: 0
            ),
        ]

        let sorted = sortConversationsForDisplay(conversations, isConnectedMode: true)

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
        let conversations = [
            IOSConversation(title: "first", conversationId: "first", isPinned: true, displayOrder: 1),
            IOSConversation(title: "second", conversationId: "second"),
            IOSConversation(title: "third", conversationId: "third", displayOrder: 1),
        ]

        let sorted = sortConversationsForDisplay(conversations, isConnectedMode: false)

        XCTAssertEqual(sorted.map(\.title), ["first", "second", "third"])
    }
}
#endif
