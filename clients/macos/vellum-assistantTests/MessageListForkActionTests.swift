import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class MessageListForkActionTests: XCTestCase {
    func testForkActionIsHiddenForStreamingAndLocalOnlyMessages() {
        let view = makeView(onForkFromMessage: { _ in })
        let localOnlyMessage = makeMessage(daemonMessageId: nil, isStreaming: false)
        let streamingMessage = makeMessage(daemonMessageId: "msg-stream", isStreaming: true)

        XCTAssertFalse(view.canFork(from: localOnlyMessage))
        XCTAssertFalse(view.canFork(from: streamingMessage))
    }

    func testForkActionIsVisibleForPersistedMessagesWhenHandlerExists() {
        let view = makeView(onForkFromMessage: { _ in })
        let persistedMessage = makeMessage(daemonMessageId: "msg-persisted", isStreaming: false)

        XCTAssertTrue(view.canFork(from: persistedMessage))
    }

    func testForkActionRoutesThroughInjectedHandler() {
        var capturedMessageId: String?
        let view = makeView(onForkFromMessage: { daemonMessageId in
            capturedMessageId = daemonMessageId
        })

        view.forkFromMessage("msg-persisted")

        XCTAssertEqual(capturedMessageId, "msg-persisted")
    }

    private func makeView(
        messages: [ChatMessage] = [],
        onForkFromMessage: ((String) -> Void)? = nil
    ) -> MessageListView {
        MessageListView(
            messages: messages,
            isSending: false,
            isThinking: false,
            isCompacting: false,
            assistantActivityPhase: "idle",
            assistantActivityAnchor: "composer",
            assistantActivityReason: nil,
            assistantStatusText: nil,
            selectedModel: "",
            configuredProviders: [],
            providerCatalog: [],
            activeSubagents: [],
            dismissedDocumentSurfaceIds: [],
            onConfirmationAllow: { _ in },
            onConfirmationDeny: { _ in },
            onAlwaysAllow: { _, _, _, _ in },
            onTemporaryAllow: nil,
            onSurfaceAction: { _, _, _ in },
            onGuardianAction: nil,
            onDismissDocumentWidget: nil,
            onReportMessage: nil,
            onForkFromMessage: onForkFromMessage,
            showInspectButton: false,
            onInspectMessage: nil,
            mediaEmbedSettings: nil,
            resolveHttpPort: { nil },
            onAbortSubagent: nil,
            onSubagentTap: nil,
            onRehydrateMessage: nil,
            onSurfaceRefetch: nil,
            onRetryFailedMessage: nil,
            onRetryConversationError: nil,
            subagentDetailStore: SubagentDetailStore(),
            creditsExhaustedError: nil,
            onAddFunds: nil,
            onDismissCreditsExhausted: nil,
            displayedMessageCount: .max,
            hasMoreMessages: false,
            isLoadingMoreMessages: false,
            loadPreviousMessagePage: nil,
            conversationId: nil,
            anchorMessageId: .constant(nil),
            highlightedMessageId: .constant(nil),
            isNearBottom: .constant(true),
            containerWidth: 0
        )
    }

    private func makeMessage(daemonMessageId: String?, isStreaming: Bool) -> ChatMessage {
        var message = ChatMessage(role: .assistant, text: "Forkable reply", isStreaming: isStreaming)
        message.daemonMessageId = daemonMessageId
        return message
    }
}
