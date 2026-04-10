import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class MessageListProjectionCacheTests: XCTestCase {
    /// Verifies that bumping messagesRevision invalidates the projection cache,
    /// ensuring streaming text growth is reflected in the projected output.
    func testMessageRevisionInvalidatesProjectionCacheForStreamingTextGrowth() {
        // GIVEN a shared projection cache and an initial streaming message
        let messageId = UUID()
        let sharedCache = ProjectionCache()

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
        initialView.projectionCache = sharedCache

        // WHEN we compute the derived state for the first time
        let initialProjection = initialView.derivedState
        // THEN the projection contains the initial text and version is bumped
        XCTAssertEqual(initialProjection.rows.last?.message.text, "Hello")
        XCTAssertEqual(sharedCache.messageListVersion, 1)

        // GIVEN the message text grows (streaming) with a new revision
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
        updatedView.projectionCache = sharedCache

        // WHEN we recompute the derived state
        let updatedProjection = updatedView.derivedState
        // THEN the projection reflects the updated text and version is bumped again
        XCTAssertEqual(updatedProjection.rows.last?.message.text, "Hello, world")
        XCTAssertEqual(sharedCache.messageListVersion, 2)
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
