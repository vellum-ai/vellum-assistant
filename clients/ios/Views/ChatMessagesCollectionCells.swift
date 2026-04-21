#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// SwiftUI row views hosted inside `UICollectionViewListCell`s via
/// `UIHostingConfiguration`. Each view takes a `@Bindable ChatViewModel` so
/// property-level `@Observable` tracking invalidates only the affected rows —
/// not the entire collection — when underlying state changes.

struct PaginationHeaderCellContent: View {
    @Bindable var viewModel: ChatViewModel
    var onRequestLoadMore: () -> Void

    var body: some View {
        Group {
            if viewModel.isLoadingMoreMessages {
                HStack {
                    Spacer()
                    VLoadingIndicator(size: 18)
                    Spacer()
                }
                .padding(.vertical, VSpacing.sm)
            } else if viewModel.hasMoreMessages {
                Color.clear
                    .frame(height: 1)
                    .onAppear(perform: onRequestLoadMore)
            }
        }
    }
}

struct MessageCellContent: View {
    @Bindable var viewModel: ChatViewModel
    let messageId: UUID
    let onForkFromMessage: ((String) -> Void)?

    var body: some View {
        let messages = viewModel.paginatedVisibleMessages
        if let index = messages.firstIndex(where: { $0.id == messageId }) {
            let message = messages[index]
            VStack(alignment: .leading, spacing: VSpacing.md) {
                bubble(for: message, index: index, messages: messages)
                ForEach(viewModel.activeSubagents.filter { $0.parentMessageId == message.id }) { subagent in
                    SubagentStatusChip(subagent: subagent)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    @ViewBuilder
    private func bubble(for message: ChatMessage, index: Int, messages: [ChatMessage]) -> some View {
        if message.modelList != nil {
            ModelListBubble(
                currentModel: viewModel.selectedModel,
                configuredProviders: viewModel.configuredProviders,
                providerCatalog: viewModel.providerCatalog
            )
        } else if message.commandList != nil {
            commandListBubble(message: message, index: index, messages: messages)
        } else {
            regularMessageBubble(message: message, index: index, messages: messages)
        }
    }

    @ViewBuilder
    private func commandListBubble(message: ChatMessage, index: Int, messages: [ChatMessage]) -> some View {
        if let parsedEntries = CommandListBubble.parsedEntries(from: message.text) {
            CommandListBubble(commands: parsedEntries)
        } else {
            var fallback = message
            let _ = (fallback.commandList = nil)
            regularMessageBubble(message: fallback, index: index, messages: messages)
        }
    }

    @ViewBuilder
    private func regularMessageBubble(message: ChatMessage, index: Int, messages: [ChatMessage]) -> some View {
        let isLastAssistant = message.role == .assistant
            && !message.isStreaming
            && (index == messages.count - 1
                || (index == messages.count - 2
                    && messages[messages.count - 1].confirmation != nil
                    && messages[messages.count - 1].confirmation?.state != .pending))
            && !viewModel.isSending
            && !viewModel.isThinking
        MessageBubbleView(
            message: message,
            onConfirmationResponse: { requestId, decision in
                viewModel.respondToConfirmation(requestId: requestId, decision: decision)
            },
            onSurfaceAction: { surfaceId, actionId, data in
                viewModel.sendSurfaceAction(surfaceId: surfaceId, actionId: actionId, data: data)
            },
            onRegenerate: isLastAssistant ? { viewModel.regenerateLastMessage() } : nil,
            onAlwaysAllow: { requestId, selectedPattern, selectedScope, decision in
                viewModel.respondToAlwaysAllow(requestId: requestId, selectedPattern: selectedPattern, selectedScope: selectedScope, decision: decision)
            },
            onGuardianAction: { requestId, action in
                viewModel.submitGuardianDecision(requestId: requestId, action: action)
            },
            onSurfaceRefetch: { surfaceId, conversationId in
                viewModel.refetchStrippedSurface(surfaceId: surfaceId, conversationId: conversationId)
            },
            onRetryConversationError: message.isError && index == messages.count - 1 ? { viewModel.retryAfterConversationError() } : nil,
            onForkFromMessage: onForkFromMessage
        )

        if !message.text.isEmpty && !message.isStreaming {
            MessageMediaEmbedsView(message: message)
        }
    }
}

struct QueuedMarkerCellContent: View {
    @Bindable var viewModel: ChatViewModel

    var body: some View {
        QueuedMessagesMarker_iOS(count: viewModel.queuedMessages.count)
    }
}

struct OrphanSubagentCellContent: View {
    @Bindable var viewModel: ChatViewModel
    let subagentId: String

    var body: some View {
        if let subagent = viewModel.activeSubagents.first(where: { $0.id == subagentId }) {
            SubagentStatusChip(subagent: subagent)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct TypingIndicatorCellContent: View {
    @Bindable var viewModel: ChatViewModel

    var body: some View {
        let lastMessage = viewModel.messages.last
        let allToolCalls = lastMessage?.toolCalls ?? []
        let isStreaming = lastMessage?.isStreaming == true
        let hasActiveToolCall = allToolCalls.contains { !$0.isComplete }
        let isStreamingWithoutText = isStreaming && (lastMessage?.text.isEmpty ?? true)

        if !isStreaming && !hasActiveToolCall {
            HStack {
                TypingIndicatorView()
                if let statusText = viewModel.assistantStatusText, !statusText.isEmpty {
                    Text(statusText)
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentSecondary)
                }
                Spacer()
            }
            .padding(.horizontal, VSpacing.lg)
        } else if hasActiveToolCall {
            CurrentStepIndicator(
                toolCalls: allToolCalls,
                isStreaming: viewModel.isSending,
                onTap: {}
            )
            .padding(.horizontal, VSpacing.lg)
        } else if isStreamingWithoutText {
            HStack {
                TypingIndicatorView()
                Spacer()
            }
            .padding(.horizontal, VSpacing.lg)
        } else if viewModel.isThinking {
            HStack {
                TypingIndicatorView()
                if let statusText = viewModel.assistantStatusText, !statusText.isEmpty {
                    Text(statusText)
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentSecondary)
                }
                Spacer()
            }
            .padding(.horizontal, VSpacing.lg)
        }
    }
}
#endif
