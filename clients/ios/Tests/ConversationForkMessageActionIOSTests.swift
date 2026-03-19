#if canImport(UIKit)
import SwiftUI
import XCTest

@testable import VellumAssistantShared
@testable import vellum_assistant_ios

@MainActor
final class ConversationForkMessageActionIOSTests: XCTestCase {
    func testPersistedMessagesExposeForkActionWhenHandlerExists() {
        let message = makeMessage(daemonMessageId: "msg-persisted", isStreaming: false)
        let view = MessageBubbleView(
            message: message,
            onConfirmationResponse: nil,
            onSurfaceAction: nil,
            onRegenerate: nil,
            onForkFromMessage: { _ in }
        )

        XCTAssertTrue(view.canForkFromMessage)
    }

    func testStreamingAndLocalOnlyMessagesDoNotExposeForkAction() {
        let localOnlyMessage = makeMessage(daemonMessageId: nil, isStreaming: false)
        let streamingMessage = makeMessage(daemonMessageId: "msg-stream", isStreaming: true)

        let localOnlyView = MessageBubbleView(
            message: localOnlyMessage,
            onConfirmationResponse: nil,
            onSurfaceAction: nil,
            onRegenerate: nil,
            onForkFromMessage: { _ in }
        )
        let streamingView = MessageBubbleView(
            message: streamingMessage,
            onConfirmationResponse: nil,
            onSurfaceAction: nil,
            onRegenerate: nil,
            onForkFromMessage: { _ in }
        )

        XCTAssertFalse(localOnlyView.canForkFromMessage)
        XCTAssertFalse(streamingView.canForkFromMessage)
    }

    func testPrivateConversationDoesNotExposeMessageForkAction() {
        let store = IOSConversationStore(daemonClient: MockDaemonClient(), connectedModeOverride: true)
        let privateConversation = IOSConversation(
            title: "Private",
            conversationId: "conv-private",
            isPrivate: true
        )

        XCTAssertNil(
            makeConversationForkFromMessageAction(
                store: store,
                conversation: privateConversation
            )
        )
    }

    func testMessageForkActionUsesStoreHelperAndPublishesSelectionForNewFork() async throws {
        let (userDefaults, suiteName) = makeUserDefaults()
        defer { clear(userDefaults, suiteName: suiteName) }

        let daemonClient = MockDaemonClient()
        daemonClient.isConnected = true
        let forkClient = MockConversationForkClient()
        forkClient.response = makeForkedConversationItem(messageId: "msg-branch")

        let store = IOSConversationStore(
            daemonClient: daemonClient,
            connectedModeOverride: true,
            conversationForkClient: forkClient,
            userDefaults: userDefaults
        )
        store.isLoadingInitialConversations = false

        let parent = IOSConversation(
            title: "Parent thread",
            conversationId: "conv-parent"
        )
        store.conversations = [parent]

        let action = try XCTUnwrap(
            makeOnForkFromMessageAction(
                conversationLocalId: parent.id,
                forkConversationFromMessage: { conversationLocalId, daemonMessageId in
                    await store.forkConversation(
                        conversationLocalId: conversationLocalId,
                        throughDaemonMessageId: daemonMessageId
                    )
                }
            )
        )

        action("msg-branch")

        await waitUntil(timeout: 1.0) { store.selectionRequest != nil }

        XCTAssertEqual(forkClient.requests.count, 1)
        XCTAssertEqual(forkClient.requests.first?.conversationId, "conv-parent")
        XCTAssertEqual(forkClient.requests.first?.throughMessageId, "msg-branch")

        let forkedLocalId = try XCTUnwrap(store.selectionRequest?.conversationLocalId)
        XCTAssertEqual(store.conversations.first?.id, forkedLocalId)
        XCTAssertEqual(store.conversations.first?.conversationId, "conv-forked")

        let request = try XCTUnwrap(store.selectionRequest)
        var compactPath: [UUID] = []
        var compactSelection: UUID?
        applyConversationSelectionRequest(
            request,
            horizontalSizeClass: .compact,
            navigationPath: &compactPath,
            selectedConversationId: &compactSelection
        )
        XCTAssertEqual(compactPath, [forkedLocalId])
        XCTAssertNil(compactSelection)
    }

    private func makeUserDefaults() -> (UserDefaults, String) {
        let suiteName = "ConversationForkMessageActionIOSTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        return (defaults, suiteName)
    }

    private func clear(_ userDefaults: UserDefaults, suiteName: String) {
        userDefaults.removePersistentDomain(forName: suiteName)
    }

    private func makeMessage(daemonMessageId: String?, isStreaming: Bool) -> ChatMessage {
        var message = ChatMessage(role: .assistant, text: "Persisted reply", isStreaming: isStreaming)
        message.daemonMessageId = daemonMessageId
        return message
    }

    private func waitUntil(
        timeout: TimeInterval,
        file: StaticString = #filePath,
        line: UInt = #line,
        condition: @escaping @Sendable () -> Bool
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
