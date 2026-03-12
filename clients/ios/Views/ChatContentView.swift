#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

// Loaded once at startup; avoids decoding the 2.3MB PNG on every re-render.
let chatBackgroundImage: UIImage? = {
    guard let url = Bundle.main.url(forResource: "background", withExtension: "png") else { return nil }
    return UIImage(contentsOfFile: url.path)
}()

private let greetingChoices = [
    "What are we working on?",
    "I'm here whenever you need me.",
    "What's on your mind?",
    "Let's make something happen.",
    "Ready when you are.",
]

struct ChatContentView: View {
    @ObservedObject var viewModel: ChatViewModel
    @FocusState private var isInputFocused: Bool
    @Environment(\.colorScheme) private var colorScheme
    @State private var emptyStateVisible = false
    @State private var greeting: String = greetingChoices.randomElement()!

    /// The slice of messages shown in the view, honoring the pagination window.
    private var visibleMessages: [ChatMessage] {
        let all = viewModel.displayedMessages
        // When the user has scrolled back through the full history (displayedMessageCount
        // reaches all.count), keep showing everything — don't clamp the window back down
        // as new messages arrive, which would cause previously loaded history to vanish.
        guard viewModel.displayedMessageCount < all.count else { return all }
        return Array(all.suffix(viewModel.displayedMessageCount))
    }

    var body: some View {
        VStack(spacing: 0) {
            // Messages area — empty state when no messages, otherwise scrollable list
            if viewModel.messages.isEmpty && !viewModel.isSending && !viewModel.isThinking {
                emptyStateView
            } else {
                messagesScrollView
            }

            // Generic error banner (session errors are shown inline in messages)
            if viewModel.sessionError == nil, let errorText = viewModel.errorText {
                genericErrorBanner(errorText)
            }


            // Input bar
            InputBarView(
                text: $viewModel.inputText,
                isInputFocused: $isInputFocused,
                isGenerating: (viewModel.isSending && !viewModel.hasPendingConfirmation) || viewModel.isThinking,
                isCancelling: viewModel.isCancelling,
                onSend: { viewModel.sendMessage() },
                onStop: { viewModel.stopGenerating() },
                onVoiceResult: { _ in
                    viewModel.pendingVoiceMessage = true
                    viewModel.sendMessage()
                },
                viewModel: viewModel
            )
        }
        .background(alignment: .bottom) { chatBackground }
        .background(VColor.surfaceOverlay)
        .animation(VAnimation.standard, value: viewModel.sessionError != nil)
        .animation(VAnimation.standard, value: viewModel.errorText)
        .onChange(of: viewModel.messages.isEmpty) { _, isEmpty in
            if isEmpty {
                greeting = greetingChoices.randomElement()!
            }
        }
    }

    // MARK: - Messages Scroll View

    private var messagesScrollView: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: VSpacing.md) {
                    paginationHeader(proxy: proxy)

                    let messages = visibleMessages
                    ForEach(Array(messages.enumerated()), id: \.element.id) { index, message in
                        messageBubble(message: message, index: index, messages: messages)

                        // Subagent chips anchored to the message that spawned them
                        ForEach(viewModel.activeSubagents.filter { $0.parentMessageId == message.id }) { subagent in
                            SubagentStatusChip(subagent: subagent)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .id("subagent-\(subagent.id)")
                        }
                    }

                    // Subagents with no parent message (e.g. from history load)
                    ForEach(viewModel.activeSubagents.filter { $0.parentMessageId == nil }) { subagent in
                        SubagentStatusChip(subagent: subagent)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .id("subagent-\(subagent.id)")
                    }

                    typingIndicatorSection

                    // Invisible anchor at the very bottom of all content
                    Color.clear.frame(height: 1)
                        .id("scroll-bottom-anchor")
                }
                .animation(VAnimation.standard, value: viewModel.messages.count)
                .padding(VSpacing.lg)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: viewModel.messages.count) { _, _ in
                scrollToBottom(proxy: proxy, animated: true)
            }
            .onChange(of: viewModel.messages.last?.text) { _, _ in
                // Scroll without animation during streaming to avoid jank.
                // Only scroll when actively streaming to avoid overriding the animated
                // scroll from new message additions (handled by count change above).
                if viewModel.messages.last?.isStreaming == true {
                    scrollToBottom(proxy: proxy, animated: false)
                }
            }
            .onChange(of: viewModel.isSending) { _, isSending in
                if isSending {
                    withAnimation(.easeOut(duration: 0.3)) {
                        proxy.scrollTo("scroll-bottom-anchor", anchor: .bottom)
                    }
                }
            }
            .onChange(of: viewModel.activeSubagents.count) { oldCount, newCount in
                if newCount > oldCount {
                    scrollToBottom(proxy: proxy, animated: true)
                }
            }
        }
    }

    // MARK: - Pagination Header

    @ViewBuilder
    private func paginationHeader(proxy: ScrollViewProxy) -> some View {
        // Loading indicator shown at the very top when fetching an older page.
        if viewModel.isLoadingMoreMessages {
            HStack {
                Spacer()
                VLoadingIndicator(size: 18)
                Spacer()
            }
            .padding(.vertical, VSpacing.sm)
            .id("page-loading-indicator")
        } else if viewModel.hasMoreMessages {
            // Invisible sentinel: fires when the user scrolls to the top,
            // triggering the next-older page of messages to be revealed.
            Color.clear
                .frame(height: 1)
                .id("page-load-trigger")
                .onAppear {
                    // Capture the current first-visible message ID before the
                    // pagination window expands so we can restore scroll position.
                    let anchorId = visibleMessages.first?.id
                    Task {
                        let hadMore = await viewModel.loadPreviousMessagePage()
                        // Restore position to the message that was previously at
                        // the top so the content doesn't jump unexpectedly.
                        if hadMore, let id = anchorId {
                            proxy.scrollTo(id, anchor: .top)
                        }
                    }
                }
        }
    }

    // MARK: - Message Bubble

    @ViewBuilder
    private func messageBubble(message: ChatMessage, index: Int, messages: [ChatMessage]) -> some View {
        if message.modelPicker != nil {
            ModelPickerBubble(
                models: ModelListBubble.anthropicModels.map { (id: $0.model, name: $0.display) },
                selectedModelId: viewModel.selectedModel,
                onSelect: { modelId in
                    viewModel.setModel(modelId)
                }
            )
            .id(message.id)
            .transition(.asymmetric(
                insertion: .move(edge: .bottom).combined(with: .opacity),
                removal: .opacity
            ))
        } else if message.modelList != nil {
            ModelListBubble(currentModel: viewModel.selectedModel, configuredProviders: viewModel.configuredProviders)
                .id(message.id)
                .transition(.asymmetric(
                    insertion: .move(edge: .bottom).combined(with: .opacity),
                    removal: .opacity
                ))
        } else if message.commandList != nil {
            CommandListBubble()
                .id(message.id)
                .transition(.asymmetric(
                    insertion: .move(edge: .bottom).combined(with: .opacity),
                    removal: .opacity
                ))
        } else {
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
                onSurfaceRefetch: { surfaceId, sessionId in
                    viewModel.refetchStrippedSurface(surfaceId: surfaceId, sessionId: sessionId)
                }
            )
            .id(message.id)
            .transition(.asymmetric(
                insertion: .move(edge: .bottom).combined(with: .opacity),
                removal: .opacity
            ))

            // Inline media embeds (images, videos)
            if !message.text.isEmpty && !message.isStreaming {
                MessageMediaEmbedsView(message: message)
            }
        }
    }

    // MARK: - Typing Indicator

    @ViewBuilder
    private var typingIndicatorSection: some View {
        // Typing / step indicator shown while generating
        // Suppress the indicator while awaiting a confirmation prompt —
        // the user should see the confirmation UI, not a spinner.
        if viewModel.isSending && !viewModel.hasPendingConfirmation {
            let lastMessage = viewModel.messages.last
            let allToolCalls = lastMessage?.toolCalls ?? []
            let isStreaming = lastMessage?.isStreaming == true
            let hasActiveToolCall = allToolCalls.contains { !$0.isComplete }
            // True when the assistant is streaming but has not yet emitted any text.
            // This happens between tool-call completion and the next text chunk.
            let isStreamingWithoutText = isStreaming && (lastMessage?.text.isEmpty ?? true)

            if !isStreaming && !hasActiveToolCall {
                // No streaming text or active tool call yet — show typing dots
                HStack {
                    TypingIndicatorView()
                    if let statusText = viewModel.assistantStatusText, !statusText.isEmpty {
                        Text(statusText)
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentSecondary)
                    }
                    Spacer()
                }
                .padding(.horizontal, VSpacing.lg)
                .id("step-indicator")
                .transition(.opacity.combined(with: .move(edge: .bottom)))
            } else if hasActiveToolCall {
                // Tool execution in progress — show step indicator
                CurrentStepIndicator(
                    toolCalls: allToolCalls,
                    isStreaming: viewModel.isSending,
                    onTap: {}
                )
                .padding(.horizontal, VSpacing.lg)
                .id("step-indicator")
            } else if isStreamingWithoutText {
                // Tool call just finished but no text has arrived yet — show
                // typing dots so the user isn't left without feedback.
                HStack {
                    TypingIndicatorView()
                    Spacer()
                }
                .padding(.horizontal, VSpacing.lg)
                .id("step-indicator")
                .transition(.opacity.combined(with: .move(edge: .bottom)))
            } else if viewModel.isThinking {
                // LLM is processing tool results but streaming text is
                // already visible — show typing dots with status text.
                HStack {
                    TypingIndicatorView()
                    if let statusText = viewModel.assistantStatusText, !statusText.isEmpty {
                        Text(statusText)
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentSecondary)
                    }
                    Spacer()
                }
                .padding(.horizontal, VSpacing.lg)
                .id("step-indicator")
                .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
            // Otherwise isStreaming with text: the growing message bubble is the indicator
        }
    }

    // MARK: - Session Error Banner

    @ViewBuilder
    private func sessionErrorBanner(_ error: SessionError) -> some View {
        HStack(spacing: VSpacing.sm) {
            VIconView(sessionErrorIcon(error.category), size: 14)
                .foregroundColor(sessionErrorAccent(error.category))

            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text(error.message)
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentDefault)
                    .lineLimit(2)
                Text(error.recoverySuggestion)
                    .font(VFont.small)
                    .foregroundColor(VColor.contentSecondary)
                    .lineLimit(1)
            }

            Spacer()

            if error.isRetryable {
                Button(action: { viewModel.retryAfterSessionError() }) {
                    Text("Retry")
                        .font(VFont.captionMedium)
                        .foregroundColor(.white)
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.xs)
                        .background(sessionErrorAccent(error.category))
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                }
            }

            Button(action: { viewModel.dismissSessionError() }) {
                VIconView(.x, size: 10)
                    .foregroundColor(VColor.contentTertiary)
            }
            .accessibilityLabel("Dismiss")
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
        .background(sessionErrorAccent(error.category).opacity(0.1))
        .overlay(
            Rectangle()
                .fill(sessionErrorAccent(error.category))
                .frame(width: 3),
            alignment: .leading
        )
        .transition(.move(edge: .top).combined(with: .opacity))
    }

    @ViewBuilder
    private func genericErrorBanner(_ errorText: String) -> some View {
        HStack(spacing: VSpacing.sm) {
            VIconView(.triangleAlert, size: 14)
                .foregroundColor(.white)
            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text(errorText)
                    .font(VFont.caption)
                    .foregroundColor(.white)
                    .lineLimit(2)
                if viewModel.isConnectionError, let hint = viewModel.connectionDiagnosticHint {
                    Text(hint)
                        .font(VFont.small)
                        .foregroundColor(.white.opacity(0.8))
                        .lineLimit(2)
                }
            }
            Spacer()
            if viewModel.isSecretBlockError {
                Button(action: { viewModel.sendAnyway() }) {
                    Text("Send Anyway")
                        .font(VFont.captionMedium)
                        .foregroundColor(.white)
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.xs)
                        .background(Color.white.opacity(0.25)) // Intentional: translucent contrast on VColor.systemDangerStrong banner
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                }
            } else if viewModel.isRetryableError {
                Button(action: { viewModel.retryLastMessage() }) {
                    Text("Retry")
                        .font(VFont.captionMedium)
                        .foregroundColor(.white)
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.xs)
                        .background(Color.white.opacity(0.25)) // Intentional: translucent contrast on VColor.systemDangerStrong banner
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                }
            }
            Button(action: { viewModel.dismissError() }) {
                VIconView(.x, size: 14)
                    .foregroundColor(.white)
            }
            .accessibilityLabel("Dismiss")
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
        .background(VColor.systemDangerStrong)
        .transition(.move(edge: .top).combined(with: .opacity))
    }

    private func sessionErrorIcon(_ category: SessionErrorCategory) -> VIcon {
        switch category {
        case .providerNetwork: return .wifiOff
        case .rateLimit: return .clockAlert
        case .providerApi: return .cloudOff
        case .providerOrdering: return .cloudOff
        case .providerWebSearch: return .cloudOff
        case .sessionAborted: return .circleStop
        case .processingFailed, .regenerateFailed: return .refreshCw
        case .contextTooLarge: return .fileText
        case .providerBilling: return .creditCard
        case .authenticationRequired: return .lock
        case .unknown: return .triangleAlert
        }
    }

    private func sessionErrorAccent(_ category: SessionErrorCategory) -> Color {
        switch category {
        case .rateLimit: return VColor.systemDangerHover
        case .providerNetwork: return .orange
        case .sessionAborted: return VColor.contentSecondary
        case .contextTooLarge: return VColor.systemDangerHover
        default: return VColor.systemDangerStrong
        }
    }

    // MARK: - Empty State

    private var emptyStateView: some View {
        VStack(spacing: VSpacing.lg) {
            Spacer()
            Spacer()
            VIconView(.sparkles, size: 48)
                .foregroundColor(VColor.primaryBase)
                .opacity(emptyStateVisible ? 1 : 0)
                .scaleEffect(emptyStateVisible ? 1 : 0.8)
            Text(greeting)
                .font(.system(size: 22, weight: .medium))
                .foregroundColor(VColor.contentSecondary)
                .multilineTextAlignment(.center)
                .opacity(emptyStateVisible ? 1 : 0)
                .offset(y: emptyStateVisible ? 0 : 8)
                .padding(.horizontal, VSpacing.xl)
            Spacer()
            Spacer()
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(
            RadialGradient(
                gradient: Gradient(colors: [
                    VColor.primaryBase.opacity(0.07),
                    VColor.primaryBase.opacity(0.02),
                    Color.clear,
                ]),
                center: .center,
                startRadius: 20,
                endRadius: 350
            )
            .offset(y: -40)
            .opacity(emptyStateVisible ? 1 : 0)
        )
        .onAppear {
            withAnimation(.easeOut(duration: 0.5)) {
                emptyStateVisible = true
            }
        }
        .onDisappear {
            emptyStateVisible = false
        }
    }

    // MARK: - Chat Background

    @ViewBuilder
    private var chatBackground: some View {
        if colorScheme == .dark, let uiImage = chatBackgroundImage {
            Image(uiImage: uiImage)
                .resizable()
                .scaledToFill()
                .clipped()
                .allowsHitTesting(false)
        }
    }

    private func scrollToBottom(proxy: ScrollViewProxy, animated: Bool) {
        if animated {
            withAnimation(.easeOut(duration: 0.3)) {
                proxy.scrollTo("scroll-bottom-anchor", anchor: .bottom)
            }
        } else {
            proxy.scrollTo("scroll-bottom-anchor", anchor: .bottom)
        }
    }
}
#endif
