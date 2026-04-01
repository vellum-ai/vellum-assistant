#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

// Loaded once at startup; avoids decoding the 2.3MB PNG on every re-render.
let chatBackgroundImage: UIImage? = {
    guard let url = Bundle.main.url(forResource: "background", withExtension: "png") else { return nil }
    return UIImage(contentsOfFile: url.path)
}()

/// Preference key that propagates the bottom anchor's Y position (in the
/// scroll view's coordinate space) so the view can determine whether the
/// user is near the bottom of the conversation.
private struct BottomAnchorMinYKey: PreferenceKey {
    static var defaultValue: CGFloat = .infinity
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = min(value, nextValue())
    }
}

/// Preference key that captures the scroll view's viewport height from a
/// background GeometryReader so anchor visibility can be computed.
private struct ScrollViewportHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

struct PendingChatAnchorResolution: Equatable {
    let localMessageId: UUID
    let requiresExpandedWindow: Bool
}

enum PendingChatAnchorSearchStep: Equatable {
    case scroll(localMessageId: UUID, requiresExpandedWindow: Bool)
    case loadOlderPage
    case consume
}

func makeOnForkFromMessageAction(
    conversationLocalId: UUID?,
    forkConversationFromMessage: ((UUID, String) async -> UUID?)?
) -> ((String) -> Void)? {
    guard let conversationLocalId, let forkConversationFromMessage else {
        return nil
    }

    return { daemonMessageId in
        Task {
            _ = await forkConversationFromMessage(conversationLocalId, daemonMessageId)
        }
    }
}

func resolvePendingChatAnchor(
    daemonMessageId: String,
    displayedMessages: [ChatMessage],
    displayedMessageCount: Int
) -> PendingChatAnchorResolution? {
    guard let messageIndex = displayedMessages.firstIndex(where: { $0.daemonMessageId == daemonMessageId }) else {
        return nil
    }

    let visibleCount = displayedMessageCount == Int.max
        ? displayedMessages.count
        : min(displayedMessageCount, displayedMessages.count)
    let visibleStartIndex = max(0, displayedMessages.count - visibleCount)

    return PendingChatAnchorResolution(
        localMessageId: displayedMessages[messageIndex].id,
        requiresExpandedWindow: displayedMessageCount != Int.max && messageIndex < visibleStartIndex
    )
}

func nextPendingChatAnchorSearchStep(
    daemonMessageId: String,
    displayedMessages: [ChatMessage],
    displayedMessageCount: Int,
    hasMoreMessages: Bool
) -> PendingChatAnchorSearchStep {
    guard let resolution = resolvePendingChatAnchor(
        daemonMessageId: daemonMessageId,
        displayedMessages: displayedMessages,
        displayedMessageCount: displayedMessageCount
    ) else {
        return hasMoreMessages ? .loadOlderPage : .consume
    }

    return .scroll(
        localMessageId: resolution.localMessageId,
        requiresExpandedWindow: resolution.requiresExpandedWindow
    )
}

struct ChatContentView: View {
    @Bindable var viewModel: ChatViewModel
    var pendingAnchorRequestId: UUID? = nil
    var pendingAnchorDaemonMessageId: String? = nil
    var onPendingAnchorHandled: ((UUID) -> Void)? = nil
    var onForkFromMessage: ((String) -> Void)? = nil
    @FocusState private var isInputFocused: Bool
    @Environment(\.colorScheme) private var colorScheme
    @State private var emptyStateVisible = false

    /// Whether the bottom anchor is within or near the visible viewport.
    /// When true, auto-scroll follows new content; when false, the user
    /// has scrolled up and auto-scroll is suppressed.
    @State private var isNearBottom: Bool = true
    /// The scroll view's viewport height, used to determine anchor visibility.
    @State private var scrollViewportHeight: CGFloat = .infinity
    /// The last reported Y position of the bottom anchor in the scroll
    /// view's coordinate space. Used to determine whether content actually
    /// exceeds the viewport (so the "Scroll to latest" button is hidden
    /// when all content fits on screen).
    @State private var lastAnchorMinY: CGFloat = .infinity
    /// Prevents stacking concurrent pagination loads. Gates the pagination
    /// sentinel's onAppear so only one page load is in flight at a time.
    @State private var isPaginationInFlight: Bool = false
    /// Task for the staged scroll-to-bottom retry on conversation switch.
    @State private var scrollRestoreTask: Task<Void, Never>?

    /// The slice of messages shown in the view, honoring the pagination window.
    private var visibleMessages: [ChatMessage] {
        let all = viewModel.displayedMessages
        // When the user has scrolled back through the full history (displayedMessageCount
        // reaches all.count), keep showing everything — don't clamp the window back down
        // as new messages arrive, which would cause previously loaded history to vanish.
        guard viewModel.displayedMessageCount < all.count else { return all }
        return Array(all.suffix(viewModel.displayedMessageCount))
    }

    private var hasPendingAnchor: Bool {
        pendingAnchorRequestId != nil && pendingAnchorDaemonMessageId != nil
    }

    var body: some View {
        VStack(spacing: 0) {
            // Messages area — empty state when no messages, otherwise scrollable list
            if viewModel.messages.isEmpty && !viewModel.isSending && !viewModel.isThinking {
                emptyStateView
            } else {
                messagesScrollView
            }

            // Generic error banner (conversation errors are shown inline in messages)
            if viewModel.conversationError == nil, let errorText = viewModel.errorText {
                genericErrorBanner(errorText)
            }


            // Input bar
            InputBarView(
                text: $viewModel.inputText,
                isInputFocused: $isInputFocused,
                isGenerating: (viewModel.isAssistantBusy && !viewModel.hasPendingConfirmation) || viewModel.isThinking,
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
        .animation(VAnimation.standard, value: viewModel.conversationError != nil)
        .animation(VAnimation.standard, value: viewModel.errorText)
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

                    // Invisible anchor at the very bottom of all content.
                    // A GeometryReader reports its Y position so the view
                    // can track whether the user is near the bottom.
                    Color.clear.frame(height: 1)
                        .id("scroll-bottom-anchor")
                        .background {
                            GeometryReader { geo in
                                Color.clear.preference(
                                    key: BottomAnchorMinYKey.self,
                                    value: geo.frame(in: .named("chatScrollView")).minY
                                )
                            }
                        }
                }
                .animation(VAnimation.standard, value: viewModel.messages.count)
                .padding(VSpacing.lg)
            }
            .coordinateSpace(name: "chatScrollView")
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .background {
                GeometryReader { geo in
                    Color.clear.preference(
                        key: ScrollViewportHeightKey.self,
                        value: geo.size.height
                    )
                }
            }
            .onPreferenceChange(ScrollViewportHeightKey.self) { height in
                scrollViewportHeight = height
            }
            .onPreferenceChange(BottomAnchorMinYKey.self) { minY in
                lastAnchorMinY = minY
                // The anchor is "near bottom" when its top edge is within
                // or just below the viewport. A 20pt tolerance avoids
                // flickering at the exact boundary.
                let newNearBottom = minY <= scrollViewportHeight + 20
                if isNearBottom != newNearBottom {
                    isNearBottom = newNearBottom
                    if !newNearBottom {
                        scrollRestoreTask?.cancel()
                        scrollRestoreTask = nil
                    }
                }
            }
            .onChange(of: viewModel.messages.count) { _, _ in
                if !hasPendingAnchor && isNearBottom && !viewModel.isLoadingMoreMessages {
                    scrollToBottom(proxy: proxy, animated: true)
                } else if hasPendingAnchor {
                    attemptPendingAnchorScrollIfNeeded(proxy: proxy)
                }
            }
            .onChange(of: viewModel.hasMoreHistory) { _, _ in
                if hasPendingAnchor {
                    attemptPendingAnchorScrollIfNeeded(proxy: proxy)
                }
            }
            .onChange(of: viewModel.messages.last?.text) { _, _ in
                // Scroll without animation during streaming to avoid jank.
                // Only scroll when actively streaming and the user hasn't
                // scrolled away.
                if !hasPendingAnchor && viewModel.messages.last?.isStreaming == true && isNearBottom {
                    scrollToBottom(proxy: proxy, animated: false)
                }
            }
            .onChange(of: viewModel.isSending) { _, isSending in
                if !hasPendingAnchor && isSending {
                    isNearBottom = true
                    withAnimation(.easeOut(duration: 0.3)) {
                        proxy.scrollTo("scroll-bottom-anchor", anchor: .bottom)
                    }
                }
            }
            .onChange(of: viewModel.activeSubagents.count) { oldCount, newCount in
                if !hasPendingAnchor && newCount > oldCount && isNearBottom {
                    scrollToBottom(proxy: proxy, animated: true)
                }
            }
            .onChange(of: viewModel.conversationId) { _, _ in
                // Reset scroll state when the conversation changes so the
                // new conversation starts bottom-following correctly.
                isNearBottom = true
                isPaginationInFlight = false
                scrollRestoreTask?.cancel()
                guard !hasPendingAnchor else { return }
                scrollRestoreTask = Task { @MainActor in
                    // Stage 0: immediate — covers the happy path where
                    // layout is already ready.
                    scrollToBottom(proxy: proxy, animated: false)

                    // Stage 1: ~3 frames — handles most conversation switches.
                    try? await Task.sleep(nanoseconds: 50_000_000)
                    guard !Task.isCancelled else { return }
                    scrollToBottom(proxy: proxy, animated: false)

                    // Stage 2: catches slower async-loaded conversations.
                    try? await Task.sleep(nanoseconds: 150_000_000)
                    guard !Task.isCancelled else { return }
                    scrollToBottom(proxy: proxy, animated: false)
                }
            }
            .onAppear {
                attemptPendingAnchorScrollIfNeeded(proxy: proxy)
            }
            .onChange(of: pendingAnchorRequestId) { _, _ in
                attemptPendingAnchorScrollIfNeeded(proxy: proxy)
            }
            .onChange(of: viewModel.isHistoryLoaded) { _, isHistoryLoaded in
                guard isHistoryLoaded else { return }
                attemptPendingAnchorScrollIfNeeded(proxy: proxy)
            }
            .onDisappear {
                scrollRestoreTask?.cancel()
                scrollRestoreTask = nil
            }
            .overlay(alignment: .bottom) {
                // Only show the button when the user has scrolled up AND
                // the content actually exceeds the viewport. This prevents
                // the pill from appearing in short conversations where all
                // content fits on screen.
                if !isNearBottom && lastAnchorMinY > scrollViewportHeight + 20 {
                    Button(action: {
                        isNearBottom = true
                        withAnimation(VAnimation.standard) {
                            proxy.scrollTo("scroll-bottom-anchor", anchor: .bottom)
                        }
                    }) {
                        HStack(spacing: VSpacing.xs) {
                            VIconView(.arrowDown, size: 10)
                            Text("Scroll to latest")
                                .font(VFont.bodySmallDefault)
                        }
                        .padding(.horizontal, VSpacing.md)
                        .padding(.vertical, VSpacing.sm)
                        .background(.ultraThinMaterial)
                        .clipShape(Capsule())
                        .shadow(color: VColor.auxBlack.opacity(0.15), radius: 4, y: 2)
                    }
                    .padding(.bottom, VSpacing.sm)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .animation(VAnimation.standard, value: isNearBottom)
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
        } else if viewModel.hasMoreMessages && !isPaginationInFlight {
            // Invisible sentinel: fires when the user scrolls to the top,
            // triggering the next-older page of messages to be revealed.
            Color.clear
                .frame(height: 1)
                .id("page-load-trigger")
                .onAppear {
                    guard !isPaginationInFlight else { return }
                    isPaginationInFlight = true
                    // Capture the current first-visible message ID before the
                    // pagination window expands so we can restore scroll position.
                    let anchorId = visibleMessages.first?.id
                    Task {
                        let hadMore = await viewModel.loadPreviousMessagePage()
                        isPaginationInFlight = false
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
        if message.modelList != nil {
            ModelListBubble(
                currentModel: viewModel.selectedModel,
                configuredProviders: viewModel.configuredProviders,
                providerCatalog: viewModel.providerCatalog
            )
            .id(message.id)
            .transition(.asymmetric(
                insertion: .move(edge: .bottom).combined(with: .opacity),
                removal: .opacity
            ))
        } else if message.commandList != nil {
            commandListBubble(message: message, index: index, messages: messages)
                .id(message.id)
                .transition(.asymmetric(
                    insertion: .move(edge: .bottom).combined(with: .opacity),
                    removal: .opacity
                ))
        } else {
            regularMessageBubble(message: message, index: index, messages: messages)
                .id(message.id)
                .transition(.asymmetric(
                    insertion: .move(edge: .bottom).combined(with: .opacity),
                    removal: .opacity
                ))
        }
    }

    @ViewBuilder
    private func commandListBubble(message: ChatMessage, index: Int, messages: [ChatMessage]) -> some View {
        if let parsedEntries = CommandListBubble.parsedEntries(from: message.text) {
            CommandListBubble(commands: parsedEntries)
        } else {
            let fallbackMessage = commandListFallbackMessage(from: message)
            regularMessageBubble(
                message: fallbackMessage,
                index: index,
                messages: messages
            )
        }
    }

    private func commandListFallbackMessage(from message: ChatMessage) -> ChatMessage {
        var fallbackMessage = message
        fallbackMessage.commandList = nil
        return fallbackMessage
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

        // Inline media embeds (images, videos)
        if !message.text.isEmpty && !message.isStreaming {
            MessageMediaEmbedsView(message: message)
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
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentSecondary)
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
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentSecondary)
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

    // MARK: - Conversation Error Banner

    @ViewBuilder
    private func conversationErrorBanner(_ error: ConversationError) -> some View {
        HStack(spacing: VSpacing.sm) {
            VIconView(conversationErrorIcon(error.category), size: 14)
                .foregroundStyle(conversationErrorAccent(error.category))

            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text(error.message)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(2)
                Text(error.recoverySuggestion)
                    .font(VFont.labelSmall)
                    .foregroundStyle(VColor.contentSecondary)
                    .lineLimit(1)
            }

            Spacer()

            if error.isRetryable {
                Button(action: { viewModel.retryAfterConversationError() }) {
                    Text("Retry")
                        .font(VFont.labelDefault)
                        .foregroundStyle(.white)
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.xs)
                        .background(conversationErrorAccent(error.category))
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                }
            }

            Button(action: { viewModel.dismissConversationError() }) {
                VIconView(.x, size: 10)
                    .foregroundStyle(VColor.contentTertiary)
            }
            .accessibilityLabel("Dismiss")
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
        .background(conversationErrorAccent(error.category).opacity(0.1))
        .overlay(
            Rectangle()
                .fill(conversationErrorAccent(error.category))
                .frame(width: 3),
            alignment: .leading
        )
        .transition(.move(edge: .top).combined(with: .opacity))
    }

    @ViewBuilder
    private func genericErrorBanner(_ errorText: String) -> some View {
        HStack(spacing: VSpacing.sm) {
            VIconView(.triangleAlert, size: 14)
                .foregroundStyle(.white)
            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text(errorText)
                    .font(VFont.labelDefault)
                    .foregroundStyle(.white)
                    .lineLimit(2)
                if viewModel.isConnectionError, let hint = viewModel.connectionDiagnosticHint {
                    Text(hint)
                        .font(VFont.labelSmall)
                        .foregroundStyle(.white.opacity(0.8))
                        .lineLimit(2)
                }
            }
            Spacer()
            if viewModel.isSecretBlockError {
                Button(action: { viewModel.sendAnyway() }) {
                    Text("Send Anyway")
                        .font(VFont.labelDefault)
                        .foregroundStyle(.white)
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.xs)
                        .background(Color.white.opacity(0.25)) // Intentional: translucent contrast on VColor.systemNegativeStrong banner
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                }
            } else if viewModel.isRetryableError {
                Button(action: { viewModel.retryLastMessage() }) {
                    Text("Retry")
                        .font(VFont.labelDefault)
                        .foregroundStyle(.white)
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.xs)
                        .background(Color.white.opacity(0.25)) // Intentional: translucent contrast on VColor.systemNegativeStrong banner
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                }
            }
            Button(action: { viewModel.dismissError() }) {
                VIconView(.x, size: 14)
                    .foregroundStyle(.white)
            }
            .accessibilityLabel("Dismiss")
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
        .background(VColor.systemNegativeStrong)
        .transition(.move(edge: .top).combined(with: .opacity))
    }

    private func conversationErrorIcon(_ category: ConversationErrorCategory) -> VIcon {
        switch category {
        case .providerNetwork: return .wifiOff
        case .rateLimit: return .clockAlert
        case .providerOverloaded: return .cloudOff
        case .providerApi: return .cloudOff
        case .providerOrdering: return .cloudOff
        case .providerWebSearch: return .cloudOff
        case .conversationAborted: return .circleStop
        case .processingFailed, .regenerateFailed: return .refreshCw
        case .contextTooLarge: return .fileText
        case .providerBilling: return .creditCard
        case .authenticationRequired: return .lock
        case .providerNotConfigured, .managedKeyInvalid: return .keyRound
        case .unknown: return .triangleAlert
        }
    }

    private func conversationErrorAccent(_ category: ConversationErrorCategory) -> Color {
        switch category {
        case .rateLimit: return VColor.systemNegativeHover
        case .providerNetwork, .providerOverloaded: return .orange
        case .conversationAborted: return VColor.contentSecondary
        case .contextTooLarge: return VColor.systemNegativeHover
        default: return VColor.systemNegativeStrong
        }
    }

    // MARK: - Empty State

    private var emptyStateView: some View {
        VStack(spacing: VSpacing.lg) {
            Spacer()
            Spacer()

            HStack(spacing: VSpacing.md) {
                VIconView(.sparkles, size: 48)
                    .foregroundStyle(VColor.primaryBase)

                if let greeting = viewModel.emptyStateGreeting {
                    Text(greeting)
                        .font(.system(size: 22, weight: .medium))
                        .foregroundStyle(VColor.contentSecondary)
                        .multilineTextAlignment(.leading)
                        .transition(.opacity)
                }
            }
            .animation(.easeOut(duration: 0.4), value: viewModel.emptyStateGreeting != nil)
            .opacity(emptyStateVisible ? 1 : 0)
            .scaleEffect(emptyStateVisible ? 1 : 0.8)

            Spacer()
            Spacer()
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(RadialGradient(
            gradient: Gradient(colors: [
                VColor.primaryBase.opacity(0.07),
                VColor.primaryBase.opacity(0.02),
                Color.clear,
            ]),
            center: .center,
            startRadius: 20,
            endRadius: 350
        ).offset(y: -40).allowsHitTesting(false))
        .onAppear {
            viewModel.generateGreeting()
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

    private func attemptPendingAnchorScrollIfNeeded(proxy: ScrollViewProxy) {
        scrollRestoreTask?.cancel()
        scrollRestoreTask = Task { @MainActor in
            while !Task.isCancelled {
                guard let pendingAnchorRequestId,
                      let pendingAnchorDaemonMessageId,
                      viewModel.isHistoryLoaded else {
                    return
                }

                switch nextPendingChatAnchorSearchStep(
                    daemonMessageId: pendingAnchorDaemonMessageId,
                    displayedMessages: viewModel.displayedMessages,
                    displayedMessageCount: viewModel.displayedMessageCount,
                    hasMoreMessages: viewModel.hasMoreMessages
                ) {
                case let .scroll(localMessageId, requiresExpandedWindow):
                    if requiresExpandedWindow {
                        viewModel.displayedMessageCount = Int.max
                        try? await Task.sleep(nanoseconds: 50_000_000)
                        guard !Task.isCancelled else { return }
                        continue
                    }

                    withAnimation(.easeOut(duration: 0.3)) {
                        proxy.scrollTo(localMessageId, anchor: .center)
                    }
                    onPendingAnchorHandled?(pendingAnchorRequestId)
                    return

                case .loadOlderPage:
                    if viewModel.isLoadingMoreMessages {
                        return
                    }

                    let startedLoading = await viewModel.loadPreviousMessagePage()
                    guard startedLoading else {
                        guard !viewModel.isLoadingMoreMessages else { return }
                        onPendingAnchorHandled?(pendingAnchorRequestId)
                        return
                    }

                    if viewModel.isLoadingMoreMessages {
                        return
                    }

                case .consume:
                    onPendingAnchorHandled?(pendingAnchorRequestId)
                    return
                }
            }
        }
    }
}
#endif
