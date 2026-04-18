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

/// Where a pending anchor target sits relative to the currently rendered
/// paginated window. Used by the fork/deep-link resolution machinery to
/// decide whether the ForEach already contains the target, or whether the
/// sliding window must shift (older/newer) first.
enum PendingChatAnchorWindowPosition: Equatable {
    /// Target is inside `paginatedVisibleMessages`; the view can scroll to it.
    case inWindow
    /// Target is in `displayedMessages` but above the current window — the
    /// caller should page older (either grow the non-show-all suffix or
    /// shift the sliding window older) and re-resolve.
    case olderThanWindow
    /// Target is in `displayedMessages` but below the current window — the
    /// caller should snap the window to the latest slice and re-resolve.
    /// Only reachable in show-all mode with a concrete `windowOldestIndex`.
    case newerThanWindow
}

struct PendingChatAnchorResolution: Equatable {
    let localMessageId: UUID
    let windowPosition: PendingChatAnchorWindowPosition
}

enum PendingChatAnchorSearchStep: Equatable {
    case scroll(localMessageId: UUID)
    case loadOlderPage
    case snapToLatest
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

/// Locate `daemonMessageId` within the currently loaded messages and report
/// where it sits relative to the rendered paginated window. `paginatedVisibleMessages`
/// is always a contiguous slice of `displayedMessages`; the window's position
/// inside the full array is inferred from the slice's first/last ids.
func resolvePendingChatAnchor(
    daemonMessageId: String,
    displayedMessages: [ChatMessage],
    paginatedVisibleMessages: [ChatMessage]
) -> PendingChatAnchorResolution? {
    guard let messageIndex = displayedMessages.firstIndex(where: { $0.daemonMessageId == daemonMessageId }) else {
        return nil
    }
    let localMessageId = displayedMessages[messageIndex].id

    // Window = full array → target is in the window.
    if paginatedVisibleMessages.count == displayedMessages.count {
        return PendingChatAnchorResolution(
            localMessageId: localMessageId,
            windowPosition: .inWindow
        )
    }

    // Locate the window inside `displayedMessages`. Fall back to the suffix
    // position (the default slice shape) if the first id can't be matched,
    // which preserves the old non-show-all behavior.
    let windowStart: Int = {
        if let firstId = paginatedVisibleMessages.first?.id,
           let start = displayedMessages.firstIndex(where: { $0.id == firstId }) {
            return start
        }
        return max(0, displayedMessages.count - paginatedVisibleMessages.count)
    }()
    let windowEnd = windowStart + paginatedVisibleMessages.count

    let position: PendingChatAnchorWindowPosition
    if messageIndex < windowStart {
        position = .olderThanWindow
    } else if messageIndex >= windowEnd {
        position = .newerThanWindow
    } else {
        position = .inWindow
    }
    return PendingChatAnchorResolution(
        localMessageId: localMessageId,
        windowPosition: position
    )
}

func nextPendingChatAnchorSearchStep(
    daemonMessageId: String,
    displayedMessages: [ChatMessage],
    paginatedVisibleMessages: [ChatMessage],
    hasMoreMessages: Bool
) -> PendingChatAnchorSearchStep {
    guard let resolution = resolvePendingChatAnchor(
        daemonMessageId: daemonMessageId,
        displayedMessages: displayedMessages,
        paginatedVisibleMessages: paginatedVisibleMessages
    ) else {
        return hasMoreMessages ? .loadOlderPage : .consume
    }

    switch resolution.windowPosition {
    case .inWindow:
        return .scroll(localMessageId: resolution.localMessageId)
    case .olderThanWindow:
        return .loadOlderPage
    case .newerThanWindow:
        return .snapToLatest
    }
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
    /// Task that drives the pending-anchor search loop in
    /// `attemptPendingAnchorScrollIfNeeded`. Held as state so it can be
    /// cancelled when the conversation switches, the user scrolls away,
    /// or the view disappears.
    @State private var pendingAnchorTask: Task<Void, Never>?

    /// Bounded slice of messages rendered by the ForEach. Delegates to the
    /// shared pagination state on the view model so the ForEach item count
    /// stays under `ChatPaginationState.maxPaginatedWindowSize` regardless
    /// of conversation length.
    private var visibleMessages: [ChatMessage] {
        viewModel.paginatedVisibleMessages
    }

    private var hasPendingAnchor: Bool {
        pendingAnchorRequestId != nil && pendingAnchorDaemonMessageId != nil
    }

    var body: some View {
        let queuedMessages = viewModel.queuedMessages
        VStack(spacing: 0) {
            // Messages area — empty state when no messages, otherwise scrollable list
            Group {
                if viewModel.messages.isEmpty && !viewModel.isSending && !viewModel.isThinking {
                    emptyStateView
                } else {
                    messagesScrollView
                }
            }
            .animation(nil, value: queuedMessages.isEmpty)

            // Generic error banner (conversation errors are shown inline in messages)
            if viewModel.conversationError == nil, let errorText = viewModel.errorText {
                genericErrorBanner(errorText)
                    .animation(nil, value: queuedMessages.isEmpty)
            }

            // Queue drawer — lists user messages still waiting to be sent.
            // Collapses when the queue is empty. The drawer's show/hide
            // animation is driven by a parent-level `.animation(...)` keyed
            // on `queuedMessages.isEmpty` so the removal transition fires
            // even as this subtree is torn down.
            if !queuedMessages.isEmpty {
                QueuedMessagesDrawer_iOS(
                    viewModel: viewModel,
                    composerText: $viewModel.inputText,
                    composerAttachments: $viewModel.pendingAttachments
                )
                .transition(.move(edge: .bottom).combined(with: .opacity))
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
            .animation(nil, value: queuedMessages.isEmpty)
        }
        .background(alignment: .bottom) { chatBackground }
        .background(VColor.surfaceOverlay)
        .animation(VAnimation.standard, value: viewModel.conversationError != nil)
        .animation(VAnimation.standard, value: viewModel.errorText)
        .animation(.spring(duration: 0.28, bounce: 0.15), value: queuedMessages.isEmpty)
    }

    // MARK: - Messages Scroll View

    private var messagesScrollView: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: VSpacing.md) {
                    paginationHeader(proxy: proxy)

                    // Collapse consecutive inline queued user bubbles into a
                    // single marker. The queued messages are still managed in
                    // the drawer (`QueuedMessagesDrawer_iOS`) — rendering them
                    // inline here duplicates the information and clutters the
                    // transcript when many follow-ups are queued. The pure
                    // helper `TranscriptItems.build(from:)` is shared in
                    // `clients/shared/Features/Chat/TranscriptItems.swift`.
                    let messages = visibleMessages
                    let indexByMessageId: [UUID: Int] = Dictionary(
                        uniqueKeysWithValues: messages.enumerated().map { ($0.element.id, $0.offset) }
                    )
                    let transcriptItems = TranscriptItems.build(from: messages)
                    ForEach(transcriptItems) { item in
                        transcriptRowContent(
                            item: item,
                            messages: messages,
                            indexByMessageId: indexByMessageId
                        )
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
                // The anchor is a 1pt sentinel pinned to the bottom of the
                // content; when the scroll view sits exactly at the bottom
                // its top edge lands ~1pt above the viewport bottom. A
                // 2pt tolerance covers float rounding without masking real
                // user scroll-up — anything further than that should stop
                // auto-follow so streaming tokens don't yank the user back.
                let newNearBottom = minY <= scrollViewportHeight + 2
                if isNearBottom != newNearBottom {
                    isNearBottom = newNearBottom
                    if !newNearBottom {
                        pendingAnchorTask?.cancel()
                        pendingAnchorTask = nil
                    }
                }
            }
            // React to the newest visible message id — fires once on first
            // appearance (`initial: true`) and whenever a new message is
            // appended or the conversation is swapped and its last message
            // id resolves. Replaces the old `.defaultScrollAnchor(.bottom)` +
            // fixed-delay retry approach, which raced against async history
            // load.
            .onChange(of: visibleMessages.last?.id, initial: true) { _, _ in
                if hasPendingAnchor {
                    attemptPendingAnchorScrollIfNeeded(proxy: proxy)
                } else if isNearBottom && !viewModel.isLoadingMoreMessages {
                    scrollToBottom(proxy: proxy, animated: false)
                }
            }
            .onChange(of: viewModel.hasMoreHistory) { _, _ in
                if hasPendingAnchor {
                    attemptPendingAnchorScrollIfNeeded(proxy: proxy)
                }
            }
            // Re-enter the pending-anchor search loop after an older-history
            // page finishes loading. `attemptPendingAnchorScrollIfNeeded`
            // exits while `isLoadingMoreMessages` is true (line ~891), and
            // prepending older messages does not change
            // `visibleMessages.last?.id`, so the window-bottom observer
            // above would not re-trigger the search for multi-page backfills.
            .onChange(of: viewModel.isLoadingMoreMessages) { _, isLoading in
                if !isLoading && hasPendingAnchor {
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
                // new conversation starts bottom-following correctly. The
                // `.onChange(of: visibleMessages.last?.id)` handler above
                // performs the actual scroll once the newest message id
                // resolves (including after async history hydration).
                isNearBottom = true
                isPaginationInFlight = false
                pendingAnchorTask?.cancel()
                pendingAnchorTask = nil
            }
            .onAppear {
                attemptPendingAnchorScrollIfNeeded(proxy: proxy)
                // Re-entering the same conversation does not change
                // `visibleMessages.last?.id` or `conversationId`, so the
                // reactive observers above will not re-scroll. Handle the
                // re-appear case here.
                if !hasPendingAnchor && isNearBottom {
                    scrollToBottom(proxy: proxy, animated: false)
                }
            }
            .onChange(of: pendingAnchorRequestId) { _, _ in
                attemptPendingAnchorScrollIfNeeded(proxy: proxy)
            }
            .onChange(of: viewModel.isHistoryLoaded) { _, isHistoryLoaded in
                guard isHistoryLoaded else { return }
                attemptPendingAnchorScrollIfNeeded(proxy: proxy)
            }
            .onDisappear {
                pendingAnchorTask?.cancel()
                pendingAnchorTask = nil
            }
            .overlay(alignment: .bottom) {
                // Only show the button when the user has scrolled up AND
                // the content actually exceeds the viewport. This prevents
                // the pill from appearing in short conversations where all
                // content fits on screen.
                if !isNearBottom && lastAnchorMinY > scrollViewportHeight + 20 {
                    Button(action: {
                        // Snap the pagination window to the newest slice so
                        // the scroll lands on the current tail, not the tail
                        // of a paginated-back window.
                        viewModel.snapWindowToLatest()
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

    // MARK: - Transcript Row

    /// Renders a single item from the collapsed transcript. Either the queue
    /// marker (in place of one or more inline queued user bubbles) or a normal
    /// message bubble plus any subagent chips anchored to it.
    @ViewBuilder
    private func transcriptRowContent(
        item: TranscriptItem,
        messages: [ChatMessage],
        indexByMessageId: [UUID: Int]
    ) -> some View {
        switch item {
        case .queuedMarker(let count):
            // No `.id(...)` needed — the enclosing `ForEach` keys rows by
            // `TranscriptItem.id`, and `.queuedMarker` returns the stable
            // sentinel `TranscriptItems.queueMarkerId`.
            QueuedMessagesMarker_iOS(count: count)
        case .message(let message):
            // Safe: every `.message` in the collapsed transcript originates
            // from `messages`, so the index lookup is always present.
            let index = indexByMessageId[message.id] ?? 0
            messageBubble(message: message, index: index, messages: messages)

            // Subagent chips anchored to the message that spawned them
            ForEach(viewModel.activeSubagents.filter { $0.parentMessageId == message.id }) { subagent in
                SubagentStatusChip(subagent: subagent)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .id("subagent-\(subagent.id)")
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
        pendingAnchorTask?.cancel()
        pendingAnchorTask = Task { @MainActor in
            while !Task.isCancelled {
                guard let pendingAnchorRequestId,
                      let pendingAnchorDaemonMessageId,
                      viewModel.isHistoryLoaded else {
                    return
                }

                switch nextPendingChatAnchorSearchStep(
                    daemonMessageId: pendingAnchorDaemonMessageId,
                    displayedMessages: viewModel.displayedMessages,
                    paginatedVisibleMessages: viewModel.paginatedVisibleMessages,
                    hasMoreMessages: viewModel.hasMoreMessages
                ) {
                case let .scroll(localMessageId):
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

                case .snapToLatest:
                    // Target lives below the current window (only possible in
                    // show-all mode after the user paginated back). Reset the
                    // window so the target becomes part of the rendered slice,
                    // then re-resolve on the next loop iteration.
                    viewModel.snapWindowToLatest()
                    try? await Task.sleep(nanoseconds: 50_000_000)
                    guard !Task.isCancelled else { return }
                    continue

                case .consume:
                    onPendingAnchorHandled?(pendingAnchorRequestId)
                    return
                }
            }
        }
    }
}
#endif
