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

        let daemonClient = MockDaemonClient()
        daemonClient.isConnected = true
        let detailClient = MockConversationDetailClient()
        detailClient.response = ConversationListResponseItem(
            id: "conv-parent",
            title: "Parent thread",
            createdAt: 1_700_000_000,
            updatedAt: 1_700_000_100
        )

        let store = IOSConversationStore(
            daemonClient: daemonClient,
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

    func testResolvePendingChatAnchorFindsMessageAndSignalsWindowExpansion() {
        let oldest = makeMessage(text: "Oldest", daemonMessageId: "msg-oldest")
        let middle = makeMessage(text: "Middle", daemonMessageId: "msg-middle")
        let newest = makeMessage(text: "Newest", daemonMessageId: "msg-newest")
        let displayedMessages = [oldest, middle, newest]

        let expandedResolution = resolvePendingChatAnchor(
            daemonMessageId: "msg-oldest",
            displayedMessages: displayedMessages,
            displayedMessageCount: 2
        )
        XCTAssertEqual(
            expandedResolution,
            PendingChatAnchorResolution(
                localMessageId: oldest.id,
                requiresExpandedWindow: true
            )
        )

        let visibleResolution = resolvePendingChatAnchor(
            daemonMessageId: "msg-newest",
            displayedMessages: displayedMessages,
            displayedMessageCount: 2
        )
        XCTAssertEqual(
            visibleResolution,
            PendingChatAnchorResolution(
                localMessageId: newest.id,
                requiresExpandedWindow: false
            )
        )

        XCTAssertNil(
            resolvePendingChatAnchor(
                daemonMessageId: "msg-missing",
                displayedMessages: displayedMessages,
                displayedMessageCount: 2
            )
        )
    }

    func testPendingChatAnchorSearchKeepsLoadingOlderHistoryUntilExhausted() {
        let oldest = makeMessage(text: "Oldest", daemonMessageId: "msg-oldest")
        let newest = makeMessage(text: "Newest", daemonMessageId: "msg-newest")
        let displayedMessages = [oldest, newest]

        XCTAssertEqual(
            nextPendingChatAnchorSearchStep(
                daemonMessageId: "msg-newest",
                displayedMessages: displayedMessages,
                displayedMessageCount: 1,
                hasMoreMessages: true
            ),
            .scroll(localMessageId: newest.id, requiresExpandedWindow: false)
        )

        XCTAssertEqual(
            nextPendingChatAnchorSearchStep(
                daemonMessageId: "msg-missing",
                displayedMessages: displayedMessages,
                displayedMessageCount: 1,
                hasMoreMessages: true
            ),
            .loadOlderPage
        )

        XCTAssertEqual(
            nextPendingChatAnchorSearchStep(
                daemonMessageId: "msg-missing",
                displayedMessages: displayedMessages,
                displayedMessageCount: 1,
                hasMoreMessages: false
            ),
            .consume
        )
    }

    func testCurrentTipForkToolbarActionOnlyExistsForPersistedConversationAndForksCurrentTip() async throws {
        let (userDefaults, suiteName) = makeUserDefaults()
        defer { clear(userDefaults, suiteName: suiteName) }

        let daemonClient = MockDaemonClient()
        daemonClient.isConnected = true
        let forkClient = MockConversationForkClient()
        forkClient.response = makeForkedConversationItem(messageId: "msg-tip")

        let store = IOSConversationStore(
            daemonClient: daemonClient,
            connectedModeOverride: true,
            conversationForkClient: forkClient,
            userDefaults: userDefaults
        )
        store.isLoadingInitialConversations = false

        let persistedConversation = IOSConversation(
            title: "Persisted",
            conversationId: "conv-parent"
        )
        let localConversation = IOSConversation(title: "Draft")
        store.conversations = [persistedConversation, localConversation]

        XCTAssertNil(
            makeCurrentTipForkToolbarAction(store: store, conversation: localConversation)
        )
        XCTAssertFalse(
            shouldShowCurrentTipForkAction(store: store, for: persistedConversation)
        )

        let viewModel = store.viewModel(for: persistedConversation.id)
        XCTAssertNil(
            makeCurrentTipForkToolbarAction(store: store, conversation: persistedConversation)
        )
        viewModel.messages = [makeMessage(text: "Persisted assistant reply", daemonMessageId: "msg-tip")]
        XCTAssertTrue(
            shouldShowCurrentTipForkAction(store: store, for: persistedConversation)
        )

        let action = try XCTUnwrap(
            makeCurrentTipForkToolbarAction(store: store, conversation: persistedConversation)
        )
        action()

        await waitUntil(timeout: 1.0) { store.selectionRequest != nil }

        XCTAssertEqual(forkClient.requests.count, 1)
        XCTAssertEqual(forkClient.requests.first?.conversationId, "conv-parent")
        XCTAssertEqual(forkClient.requests.first?.throughMessageId, "msg-tip")
    }

    func testForkActionsAreHiddenForPrivateConversations() {
        let privateConversation = IOSConversation(
            title: "Private",
            conversationId: "conv-private",
            isPrivate: true,
            forkParent: ConversationForkParent(
                conversationId: "conv-parent",
                messageId: "msg-parent",
                title: "Parent thread"
            )
        )

        XCTAssertFalse(shouldShowCurrentTipForkAction(store: IOSConversationStore(daemonClient: MockDaemonClient(), connectedModeOverride: true), for: privateConversation))
        XCTAssertNil(
            makeCurrentTipForkToolbarAction(
                store: IOSConversationStore(daemonClient: MockDaemonClient(), connectedModeOverride: true),
                conversation: privateConversation
            )
        )
        XCTAssertNil(
            makeOpenForkParentAction(
                store: IOSConversationStore(daemonClient: MockDaemonClient(), connectedModeOverride: true),
                conversation: privateConversation
            )
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

    private func waitUntil(
        timeout: TimeInterval,
        file: StaticString = #filePath,
        line: UInt = #line,
        condition: @escaping () -> Bool
    ) async {
        let deadline = ContinuousClock.now + .seconds(timeout)
        while !condition() && ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(condition(), file: file, line: line)
    }

    private func makeForkedConversationItem(messageId: String) -> ConversationListResponseItem {
        ConversationListResponseItem(
            id: "conv-forked",
            title: "Forked thread",
            createdAt: 1_700_000_100,
            updatedAt: 1_700_000_120,
            forkParent: ConversationForkParent(
                conversationId: "conv-parent",
                messageId: messageId,
                title: "Parent thread"
            )
        )
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

@MainActor
private final class MockConversationForkClient: ConversationForkClientProtocol {
    struct Request: Equatable {
        let conversationId: String
        let throughMessageId: String?
    }

    var response: ConversationListResponseItem?
    private(set) var requests: [Request] = []

    func forkConversation(conversationId: String, throughMessageId: String?) async -> ConversationListResponseItem? {
        requests.append(Request(conversationId: conversationId, throughMessageId: throughMessageId))
        return response
    }
}
#endif
