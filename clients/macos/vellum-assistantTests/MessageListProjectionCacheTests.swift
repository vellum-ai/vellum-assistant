import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class MessageListProjectionCacheTests: XCTestCase {
    func testMessageRevisionInvalidatesProjectionCacheForStreamingTextGrowth() {
        let messageId = UUID()
        let sharedScrollState = MessageListScrollState()

        let initialMessage = ChatMessage(
            id: messageId,
            role: .assistant,
            text: "Hello",
            isStreaming: true
        )
        let initialView = makeView(
            messages: [initialMessage],
            messagesRevision: 1
        )
        initialView.scrollState = sharedScrollState

        let initialProjection = initialView.derivedState
        XCTAssertEqual(initialProjection.rows.last?.message.text, "Hello")
        XCTAssertEqual(sharedScrollState.messageListVersion, 1)

        let updatedMessage = ChatMessage(
            id: messageId,
            role: .assistant,
            text: "Hello, world",
            isStreaming: true
        )
        let updatedView = makeView(
            messages: [updatedMessage],
            messagesRevision: 2
        )
        updatedView.scrollState = sharedScrollState

        let updatedProjection = updatedView.derivedState
        XCTAssertEqual(updatedProjection.rows.last?.message.text, "Hello, world")
        XCTAssertEqual(sharedScrollState.messageListVersion, 2)
    }

    private func makeView(
        messages: [ChatMessage],
        messagesRevision: UInt64
    ) -> MessageListView {
        MessageListView(
            messages: messages,
            messagesRevision: messagesRevision,
            isSending: true,
            isThinking: false,
            isCompacting: false,
            assistantActivityPhase: "streaming",
            assistantActivityAnchor: "assistant_turn",
            assistantActivityReason: nil,
            assistantStatusText: nil,
            selectedModel: "",
            configuredProviders: [],
            providerCatalog: [],
            activeSubagents: [],
            dismissedDocumentSurfaceIds: [],
            onConfirmationAllow: nil,
            onConfirmationDeny: nil,
            onAlwaysAllow: nil,
            onTemporaryAllow: nil,
            onSurfaceAction: nil,
            onGuardianAction: nil,
            onDismissDocumentWidget: nil,
            onForkFromMessage: nil,
            showInspectButton: false,
            onInspectMessage: nil,
            mediaEmbedSettings: nil,
            onAbortSubagent: nil,
            onSubagentTap: nil,
            onRehydrateMessage: nil,
            onSurfaceRefetch: nil,
            onRetryFailedMessage: nil,
            onRetryConversationError: nil,
            subagentDetailStore: SubagentDetailStore(),
            activePendingRequestId: nil,
            paginatedVisibleMessages: messages,
            displayedMessageCount: .max,
            hasMoreMessages: false,
            isLoadingMoreMessages: false,
            loadPreviousMessagePage: nil,
            conversationId: nil,
            anchorMessageId: .constant(nil),
            highlightedMessageId: .constant(nil),
            isInteractionEnabled: true,
            containerWidth: 800
        )
    }
}
