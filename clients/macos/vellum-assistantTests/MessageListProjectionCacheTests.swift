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

    func testChangingHighlightedMessageIdInvalidatesProjectionCache() {
        let messageId = UUID()
        let sharedScrollState = MessageListScrollState()

        let message = ChatMessage(
            id: messageId,
            role: .assistant,
            text: "Hello",
            isStreaming: false
        )

        // First projection with no highlighted message.
        let view1 = makeView(messages: [message], messagesRevision: 1)
        view1.scrollState = sharedScrollState
        let projection1 = view1.derivedState

        // Capture the cache key after the first projection (highlightedMessageId == nil).
        let keyWithoutHighlight = sharedScrollState.derivedStateCache.cachedProjectionKey

        // Second projection with a highlighted message — same content,
        // different highlightedMessageId.
        let view2 = makeView(
            messages: [message],
            messagesRevision: 1,
            highlightedMessageId: messageId
        )
        view2.scrollState = sharedScrollState
        let projection2 = view2.derivedState

        // Capture the cache key after the second projection (highlightedMessageId == messageId).
        let keyWithHighlight = sharedScrollState.derivedStateCache.cachedProjectionKey

        // The two cache keys must differ so the projector re-runs and picks
        // up the new isHighlighted flag.
        XCTAssertNotEqual(
            keyWithoutHighlight,
            keyWithHighlight,
            "Changing highlightedMessageId should produce a different cache key"
        )

        // Verify the projections reflect the highlight state correctly.
        let rows1Highlighted = projection1.rows.contains { $0.isHighlighted }
        let rows2Highlighted = projection2.rows.contains { $0.isHighlighted }
        XCTAssertFalse(rows1Highlighted, "No rows should be highlighted when highlightedMessageId is nil")
        XCTAssertTrue(rows2Highlighted, "The matching row should be highlighted when highlightedMessageId is set")
    }

    private func makeView(
        messages: [ChatMessage],
        messagesRevision: UInt64,
        highlightedMessageId: UUID? = nil
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
            highlightedMessageId: .constant(highlightedMessageId),
            isInteractionEnabled: true,
            containerWidth: 800
        )
    }
}
