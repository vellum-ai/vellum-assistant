#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

// Loaded once at startup; avoids decoding the 2.3MB PNG on every re-render.
let chatBackgroundImage: UIImage? = {
    guard let url = Bundle.main.url(forResource: "background", withExtension: "png") else { return nil }
    return UIImage(contentsOfFile: url.path)
}()

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

    /// Whether the chat list is bottom-anchored. Driven by
    /// `ChatMessagesCollectionView` and used to gate the "Scroll to latest"
    /// overlay button's visibility.
    @State private var isNearBottom: Bool = true
    /// Whether the content height exceeds the viewport. Together with
    /// `isNearBottom` this prevents the overlay from appearing when all
    /// messages fit on screen.
    @State private var contentExceedsViewport: Bool = false
    /// Incremented whenever the user taps "Scroll to latest" — the collection
    /// view observes this and scrolls to the newest row.
    @State private var scrollToLatestTrigger: Int = 0

    var body: some View {
        let queuedMessages = viewModel.queuedMessages
        VStack(spacing: 0) {
            // Messages area — empty state when no messages, otherwise scrollable list
            Group {
                if viewModel.messages.isEmpty && !viewModel.isSending && !viewModel.isThinking {
                    emptyStateView
                } else {
                    messagesListView
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

    // MARK: - Messages List

    private var messagesListView: some View {
        ChatMessagesCollectionView(
            viewModel: viewModel,
            pendingAnchorRequestId: pendingAnchorRequestId,
            pendingAnchorDaemonMessageId: pendingAnchorDaemonMessageId,
            scrollToLatestTrigger: scrollToLatestTrigger,
            onPendingAnchorHandled: onPendingAnchorHandled,
            onForkFromMessage: onForkFromMessage,
            onVisibilityStateChanged: { nearBottom, exceedsViewport in
                if isNearBottom != nearBottom { isNearBottom = nearBottom }
                if contentExceedsViewport != exceedsViewport { contentExceedsViewport = exceedsViewport }
            }
        )
        .overlay(alignment: .bottom) {
            if !isNearBottom && contentExceedsViewport {
                scrollToLatestButton
            }
        }
    }

    private var scrollToLatestButton: some View {
        Button {
            scrollToLatestTrigger &+= 1
        } label: {
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
}
#endif
