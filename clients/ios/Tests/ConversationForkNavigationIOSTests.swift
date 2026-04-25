#if canImport(UIKit)
import SwiftUI
import XCTest

@testable import VellumAssistantShared
@testable import vellum_assistant_ios

@MainActor
final class ConversationForkNavigationIOSTests: XCTestCase {
    func testOpenForkParentFetchesMissingParentPublishesSelectionAndAnchor() async throws {
        let (userDefaults, suiteName) = makeUserDefaults()
        defer { clear(userDefaults, suiteName: suiteName) }

        let connectionManager = GatewayConnectionManager()
        connectionManager.isConnected = true
        let detailClient = MockConversationDetailClient()
        detailClient.response = ConversationListResponseItem(
            id: "conv-parent",
            title: "Parent thread",
            createdAt: 1_700_000_000,
            updatedAt: 1_700_000_100
        )

        let store = IOSConversationStore(
            connectionManager: connectionManager,
            eventStreamClient: connectionManager.eventStreamClient,
            connectedModeOverride: true,
            conversationDetailClient: detailClient,
            userDefaults: userDefaults
        )
        store.isLoadingInitialConversations = false
        let child = IOSConversation(
            title: "Forked child",
            conversationId: "conv-child",
            forkParent: ConversationForkParent(
                conversationId: "conv-parent",
                messageId: "msg-source",
                title: "Parent thread"
            )
        )
        store.conversations = [child]

        let openedParentLocalId = await store.openForkParent(of: child.id)
        let parentLocalId = try XCTUnwrap(openedParentLocalId)

        XCTAssertEqual(detailClient.requests, ["conv-parent"])
        XCTAssertEqual(store.selectionRequest?.conversationLocalId, parentLocalId)
        XCTAssertEqual(
            store.pendingAnchorRequest(for: parentLocalId)?.daemonMessageId,
            "msg-source"
        )

        let parentConversation = try XCTUnwrap(
            store.conversations.first(where: { $0.id == parentLocalId })
        )
        XCTAssertEqual(parentConversation.conversationId, "conv-parent")
        XCTAssertEqual(parentConversation.title, "Parent thread")
    }

    func testResolvePendingChatAnchorReportsWindowPositionForInAboveAndBelow() {
        let oldest = makeMessage(text: "Oldest", daemonMessageId: "msg-oldest")
        let middle = makeMessage(text: "Middle", daemonMessageId: "msg-middle")
        let newest = makeMessage(text: "Newest", daemonMessageId: "msg-newest")
        let displayedMessages = [oldest, middle, newest]

        // Window = full array → every target is in-window.
        XCTAssertEqual(
            resolvePendingChatAnchor(
                daemonMessageId: "msg-middle",
                displayedMessages: displayedMessages,
                paginatedVisibleMessages: displayedMessages
            ),
            PendingChatAnchorResolution(localMessageId: middle.id, windowPosition: .inWindow)
        )

        // Suffix window of 2 → oldest is above, middle/newest are in-window.
        let suffixWindow = [middle, newest]
        XCTAssertEqual(
            resolvePendingChatAnchor(
                daemonMessageId: "msg-oldest",
                displayedMessages: displayedMessages,
                paginatedVisibleMessages: suffixWindow
            ),
            PendingChatAnchorResolution(localMessageId: oldest.id, windowPosition: .olderThanWindow)
        )
        XCTAssertEqual(
            resolvePendingChatAnchor(
                daemonMessageId: "msg-newest",
                displayedMessages: displayedMessages,
                paginatedVisibleMessages: suffixWindow
            ),
            PendingChatAnchorResolution(localMessageId: newest.id, windowPosition: .inWindow)
        )

        // Prefix window (user paginated back) → newest is below the window.
        let prefixWindow = [oldest, middle]
        XCTAssertEqual(
            resolvePendingChatAnchor(
                daemonMessageId: "msg-newest",
                displayedMessages: displayedMessages,
                paginatedVisibleMessages: prefixWindow
            ),
            PendingChatAnchorResolution(localMessageId: newest.id, windowPosition: .newerThanWindow)
        )

        XCTAssertNil(
            resolvePendingChatAnchor(
                daemonMessageId: "msg-missing",
                displayedMessages: displayedMessages,
                paginatedVisibleMessages: suffixWindow
            )
        )
    }

    func testPendingChatAnchorSearchProducesLoadOlderSnapToLatestScrollAndConsume() {
        let oldest = makeMessage(text: "Oldest", daemonMessageId: "msg-oldest")
        let middle = makeMessage(text: "Middle", daemonMessageId: "msg-middle")
        let newest = makeMessage(text: "Newest", daemonMessageId: "msg-newest")
        let displayedMessages = [oldest, middle, newest]
        let suffixWindow = [middle, newest]
        let prefixWindow = [oldest, middle]

        // Target in window → scroll directly.
        XCTAssertEqual(
            nextPendingChatAnchorSearchStep(
                daemonMessageId: "msg-newest",
                displayedMessages: displayedMessages,
                paginatedVisibleMessages: suffixWindow,
                hasMoreMessages: false
            ),
            .scroll(localMessageId: newest.id)
        )

        // Target above window → load the next older page.
        XCTAssertEqual(
            nextPendingChatAnchorSearchStep(
                daemonMessageId: "msg-oldest",
                displayedMessages: displayedMessages,
                paginatedVisibleMessages: suffixWindow,
                hasMoreMessages: true
            ),
            .loadOlderPage
        )

        // Target below window → snap the window to latest.
        XCTAssertEqual(
            nextPendingChatAnchorSearchStep(
                daemonMessageId: "msg-newest",
                displayedMessages: displayedMessages,
                paginatedVisibleMessages: prefixWindow,
                hasMoreMessages: false
            ),
            .snapToLatest
        )

        // Target missing locally but more history available → load older.
        XCTAssertEqual(
            nextPendingChatAnchorSearchStep(
                daemonMessageId: "msg-missing",
                displayedMessages: displayedMessages,
                paginatedVisibleMessages: suffixWindow,
                hasMoreMessages: true
            ),
            .loadOlderPage
        )

        // Target missing locally and daemon exhausted → consume.
        XCTAssertEqual(
            nextPendingChatAnchorSearchStep(
                daemonMessageId: "msg-missing",
                displayedMessages: displayedMessages,
                paginatedVisibleMessages: suffixWindow,
                hasMoreMessages: false
            ),
            .consume
        )
    }

    private func makeUserDefaults() -> (UserDefaults, String) {
        let suiteName = "ConversationForkNavigationIOSTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        return (defaults, suiteName)
    }

    private func clear(_ userDefaults: UserDefaults, suiteName: String) {
        userDefaults.removePersistentDomain(forName: suiteName)
    }

    private func makeMessage(text: String, daemonMessageId: String) -> ChatMessage {
        var message = ChatMessage(role: .assistant, text: text)
        message.daemonMessageId = daemonMessageId
        return message
    }
}

@MainActor
private final class MockConversationDetailClient: ConversationDetailClientProtocol {
    var response: ConversationListResponseItem?
    private(set) var requests: [String] = []

    func fetchConversation(conversationId: String) async -> ConversationListResponseItem? {
        requests.append(conversationId)
        return response
    }
}
#endif
