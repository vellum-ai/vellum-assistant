import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class MessageListTypographyRefreshTests: XCTestCase {
    func testMessageListContentViewEqualityIncludesTypographyGeneration() {
        XCTAssertNotEqual(
            makeMessageListContentView(typographyGeneration: 0),
            makeMessageListContentView(typographyGeneration: 1)
        )
    }

    func testMessageCellViewEqualityIncludesTypographyGeneration() {
        XCTAssertNotEqual(
            makeMessageCellView(typographyGeneration: 0),
            makeMessageCellView(typographyGeneration: 1)
        )
    }

    func testChatBubbleEqualityIncludesTypographyGeneration() {
        XCTAssertNotEqual(
            makeChatBubble(typographyGeneration: 0),
            makeChatBubble(typographyGeneration: 1)
        )
    }

    private func makeMessageListContentView(typographyGeneration: Int) -> MessageListContentView {
        MessageListContentView(
            state: makeDerivedState(),
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

    private func makeMessageCellView(typographyGeneration: Int) -> MessageCellView {
        let message = ChatMessage(role: .assistant, text: "*italic*")
        return MessageCellView(
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

    private func makeChatBubble(typographyGeneration: Int) -> ChatBubble {
        ChatBubble(
            message: ChatMessage(role: .assistant, text: "*italic*"),
            decidedConfirmation: nil,
            onSurfaceAction: { _, _, _ in },
            onDismissDocumentWidget: { _ in },
            dismissedDocumentSurfaceIds: [],
            isLatestAssistantMessage: true,
            typographyGeneration: typographyGeneration
        )
    }

    private func makeDerivedState() -> MessageListDerivedState {
        let message = ChatMessage(role: .assistant, text: "*italic*")
        return MessageListDerivedState(
            messageIndexById: [message.id: 0],
            showTimestamp: [],
            hasPrecedingAssistantByIndex: [],
            hasUserMessage: false,
            latestAssistantId: message.id,
            subagentsByParent: [:],
            orphanSubagents: [],
            effectiveStatusText: nil,
            displayMessages: [message],
            activePendingRequestId: nil,
            nextDecidedConfirmationByIndex: [:],
            isConfirmationRenderedInlineByIndex: [],
            anchoredThinkingIndex: nil,
            hasActiveToolCall: false,
            canInlineProcessing: false,
            shouldShowThinkingIndicator: false,
            isStreamingWithoutText: false,
            hasMessages: true
        )
    }
}
