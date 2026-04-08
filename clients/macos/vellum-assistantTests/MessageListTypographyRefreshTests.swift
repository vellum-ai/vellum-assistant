import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class MessageListTypographyRefreshTests: XCTestCase {
    func testMessageListContentViewEqualityIncludesTypographyGeneration() {
        let state = makeDerivedState()
        XCTAssertNotEqual(
            makeMessageListContentView(state: state, typographyGeneration: 0),
            makeMessageListContentView(state: state, typographyGeneration: 1)
        )
    }

    func testMessageCellViewEqualityIncludesTypographyGeneration() {
        let message = ChatMessage(role: .assistant, text: "*italic*")
        XCTAssertNotEqual(
            makeMessageCellView(message: message, typographyGeneration: 0),
            makeMessageCellView(message: message, typographyGeneration: 1)
        )
    }

    func testChatBubbleEqualityIncludesTypographyGeneration() {
        let message = ChatMessage(role: .assistant, text: "*italic*")
        XCTAssertNotEqual(
            makeChatBubble(message: message, typographyGeneration: 0),
            makeChatBubble(message: message, typographyGeneration: 1)
        )
    }

    private func makeMessageListContentView(state: TranscriptRenderModel, typographyGeneration: Int) -> MessageListContentView {
        MessageListContentView(
            state: state,
            providerCatalog: [],
            providerCatalogHash: 0,
            typographyGeneration: typographyGeneration,
            isLoadingMoreMessages: false,
            isCompacting: false,
            isInteractionEnabled: true,
            containerWidth: 800,
            dismissedDocumentSurfaceIds: [],
            activeSurfaceId: nil,
            highlightedMessageId: nil,
            mediaEmbedSettings: nil,
            hasEverSentMessage: true,
            showInspectButton: false,
            isTTSEnabled: false,
            selectedModel: "",
            configuredProviders: [],
            subagentDetailStore: SubagentDetailStore(),
            assistantStatusText: nil,
            scrollState: MessageListScrollState()
        )
    }

    private func makeMessageCellView(message: ChatMessage, typographyGeneration: Int) -> MessageCellView {
        MessageCellView(
            message: message,
            showTimestamp: false,
            nextDecidedConfirmation: nil,
            isConfirmationRenderedInline: false,
            hasPrecedingAssistant: false,
            activePendingRequestId: nil,
            subagentsByParent: [:],
            isLatestAssistantMessage: true,
            typographyGeneration: typographyGeneration,
            isProcessingAfterTools: false,
            processingStatusText: nil,
            hideInlineAvatar: false,
            showAnchoredThinkingIndicator: false,
            anchoredThinkingLabel: "",
            dismissedDocumentSurfaceIds: [],
            activeSurfaceId: nil,
            isHighlighted: false,
            mediaEmbedSettings: nil,
            onDismissDocumentWidget: nil,
            subagentDetailStore: SubagentDetailStore(),
            selectedModel: "",
            configuredProviders: [],
            providerCatalog: [],
            providerCatalogHash: 0
        )
    }

    private func makeChatBubble(message: ChatMessage, typographyGeneration: Int) -> ChatBubble {
        ChatBubble(
            message: message,
            decidedConfirmation: nil,
            onSurfaceAction: { _, _, _ in },
            onDismissDocumentWidget: { _ in },
            dismissedDocumentSurfaceIds: [],
            isLatestAssistantMessage: true,
            typographyGeneration: typographyGeneration
        )
    }

    private func makeDerivedState() -> TranscriptRenderModel {
        let message = ChatMessage(role: .assistant, text: "*italic*")
        return TranscriptProjector.project(
            messages: [message],
            paginatedVisibleMessages: [message],
            activeSubagents: [],
            isSending: false,
            isThinking: false,
            isCompacting: false,
            assistantStatusText: nil,
            assistantActivityPhase: "",
            assistantActivityAnchor: "",
            assistantActivityReason: nil,
            activePendingRequestId: nil,
            highlightedMessageId: nil
        )
    }
}
