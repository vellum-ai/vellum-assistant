import Combine
import SwiftUI
import VellumAssistantShared

struct MessageListView: View {
    let messages: [ChatMessage]
    let isSending: Bool
    let isThinking: Bool
    let selectedModel: String
    let configuredProviders: Set<String>
    let activeSubagents: [SubagentInfo]
    let dismissedDocumentSurfaceIds: Set<String>
    let onConfirmationAllow: (String) -> Void
    let onConfirmationDeny: (String) -> Void
    let onAlwaysAllow: (String, String, String, String) -> Void
    let onSurfaceAction: (String, String, [String: AnyCodable]?) -> Void
    /// Called when a guardian decision action button is clicked: (requestId, action).
    var onGuardianAction: ((String, String) -> Void)?
    let onDismissDocumentWidget: ((String) -> Void)?
    let onReportMessage: ((String?) -> Void)?
    let mediaEmbedSettings: MediaEmbedResolverSettings?
    /// Resolves the daemon HTTP port at call time so lazy-loaded video
    /// attachments always use the latest port after daemon restarts.
    var resolveHttpPort: (() -> Int?) = { nil }
    var onModelPickerSelect: ((UUID, String) -> Void)?
    var onAbortSubagent: ((String) -> Void)?
    var onSubagentTap: ((String) -> Void)?
    /// Called to rehydrate truncated message content on demand.
    var onRehydrateMessage: ((UUID) -> Void)?
    @ObservedObject var subagentDetailStore: SubagentDetailStore

    // MARK: - Pagination

    /// Number of messages the view currently displays (suffix window size).
    var displayedMessageCount: Int = .max
    /// Whether older messages exist beyond the current display window.
    var hasMoreMessages: Bool = false
    /// True while a previous-page load is in progress.
    var isLoadingMoreMessages: Bool = false
    /// Callback to load the next older page of messages.
    var loadPreviousMessagePage: (() async -> Bool)?

    var threadId: UUID?
    @Binding var isNearBottom: Bool
    @Environment(\.conversationZoomScale) private var conversationZoomScale
    @AppStorage("hasEverSentMessage") private var hasEverSentMessage: Bool = false
    @AppStorage("completedConversationCount") private var completedConversationCount: Int = 0
    @State private var identity: IdentityInfo? = IdentityInfo.load()
    @State private var appearance = AvatarAppearanceManager.shared
    /// Read once at the list level and passed down to each ChatBubble so that
    /// individual bubbles don't each subscribe to the shared ObservableObject.
    @State private var scrollDebounceTask: Task<Void, Never>?
    /// Only the active surface ID is needed here (to suppress inline rendering).
    /// Observing the full TaskProgressOverlayManager would cause the entire
    /// message list to re-render on every frequent `data` progress tick.
    @State private var activeSurfaceId: String?

    /// The subset of messages actually shown, honoring the pagination window.
    private var visibleMessages: [ChatMessage] {
        let all = messages.filter { !$0.isSubagentNotification }
        // When displayedMessageCount covers all messages (or is Int.max / show-all mode),
        // return everything so new incoming messages don't collapse visible history.
        guard displayedMessageCount < all.count else { return all }
        return Array(all.suffix(displayedMessageCount))
    }

    /// Triggers auto-scroll when the last message's text length changes (e.g. during streaming).
    /// Uses total text length (monotonically increasing) so the trigger never produces the same
    /// value when a new text segment starts after a tool call — unlike a hash of segment count +
    /// last segment length, which can collide and miss scroll events.
    private var streamingScrollTrigger: Int {
        let last = messages.last(where: { if case .queued = $0.status { return false }; return true })
        let textLen = last?.textSegments.reduce(0) { $0 + $1.utf8.count } ?? 0
        return textLen + (last?.toolCalls.count ?? 0) + (last?.inlineSurfaces.count ?? 0)
    }

    /// Pre-compute which message indices should show a timestamp divider.
    /// Avoids creating a Calendar instance per-message inside the ForEach body.
    private func timestampIndices(for list: [ChatMessage]) -> Set<Int> {
        guard !list.isEmpty else { return [] }
        var result: Set<Int> = [0]
        var calendar = Calendar.current
        calendar.timeZone = ChatTimestampTimeZone.resolve()
        for i in 1..<list.count {
            let current = list[i].timestamp
            let previous = list[i - 1].timestamp
            if !calendar.isDate(current, inSameDayAs: previous) || current.timeIntervalSince(previous) > 300 {
                result.insert(i)
            }
        }
        return result
    }

    private func modelPickerView(for message: ChatMessage) -> some View {
        ModelPickerBubble(
            models: SettingsStore.availableModels.map { id in
                (id: id, name: SettingsStore.modelDisplayNames[id] ?? id)
            },
            selectedModelId: selectedModel,
            onSelect: { modelId in
                onModelPickerSelect?(message.id, modelId)
            }
        )
    }

    private func modelListView(for message: ChatMessage) -> some View {
        ModelListBubble(currentModel: selectedModel, configuredProviders: configuredProviders)
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: VSpacing.md) {
                    // MARK: - Pagination sentinel

                    if isLoadingMoreMessages {
                        HStack {
                            Spacer()
                            ProgressView()
                                .controlSize(.small)
                            Spacer()
                        }
                        .padding(.vertical, VSpacing.sm)
                        .id("page-loading-indicator")
                    } else if hasMoreMessages {
                        // Invisible sentinel: fires when the user scrolls to the top,
                        // triggering the next-older page of messages to be revealed.
                        Color.clear
                            .frame(height: 1)
                            .id("page-load-trigger")
                            .onAppear {
                                let anchorId = visibleMessages.first?.id
                                Task {
                                    let hadMore = await loadPreviousMessagePage?() ?? false
                                    if hadMore, let id = anchorId {
                                        proxy.scrollTo(id, anchor: .top)
                                    }
                                }
                            }
                    }

                    let displayMessages = visibleMessages
                    let activePendingRequestId = PendingConfirmationFocusSelector.activeRequestId(from: displayMessages)
                    let latestAssistantId = displayMessages.last(where: { $0.role == .assistant })?.id
                    // Pre-compute subagent lookup to avoid O(n*m) filtering inside ForEach
                    let subagentsByParent: [UUID: [SubagentInfo]] = Dictionary(grouping: activeSubagents.filter { $0.parentMessageId != nil }, by: { $0.parentMessageId! })
                    let orphanSubagents = activeSubagents.filter { $0.parentMessageId == nil }
                    let showTimestamp = timestampIndices(for: displayMessages)
                    ForEach(Array(zip(displayMessages.indices, displayMessages)), id: \.1.id) { index, message in
                        if showTimestamp.contains(index) {
                            TimestampDivider(date: message.timestamp)
                        }

                        if let confirmation = message.confirmation {
                            if confirmation.state == .pending {
                                ToolConfirmationBubble(
                                    confirmation: confirmation,
                                    isKeyboardActive: confirmation.requestId == activePendingRequestId,
                                    onAllow: { onConfirmationAllow(confirmation.requestId) },
                                    onDeny: { onConfirmationDeny(confirmation.requestId) },
                                    onAlwaysAllow: onAlwaysAllow
                                )
                                .id(message.id)
                                .transition(.opacity)
                            } else {
                                let hasPrecedingAssistant: Bool = {
                                    guard index > 0 else { return false }
                                    return displayMessages[index - 1].role == .assistant
                                }()

                                if !hasPrecedingAssistant {
                                    ToolConfirmationBubble(
                                        confirmation: confirmation,
                                        onAllow: { onConfirmationAllow(confirmation.requestId) },
                                        onDeny: { onConfirmationDeny(confirmation.requestId) },
                                        onAlwaysAllow: onAlwaysAllow
                                    )
                                    .id(message.id)
                                    .transition(.opacity)
                                }
                            }
                        } else if message.modelPicker != nil {
                            modelPickerView(for: message)
                                .id(message.id)
                                .transition(.opacity)
                        } else if message.modelList != nil {
                            modelListView(for: message)
                                .id(message.id)
                                .transition(.opacity)
                        } else if message.commandList != nil {
                            CommandListBubble()
                                .id(message.id)
                                .transition(.opacity)
                        } else if let guardianDecision = message.guardianDecision {
                            GuardianDecisionBubble(
                                decision: guardianDecision,
                                onAction: { requestId, action in
                                    onGuardianAction?(requestId, action)
                                }
                            )
                            .id(message.id)
                            .transition(.opacity)
                        } else {
                            let nextIsPendingConfirmation = index + 1 < displayMessages.count
                                && displayMessages[index + 1].confirmation?.state == .pending

                            let nextDecidedConfirmation: ToolConfirmationData? = {
                                guard index + 1 < displayMessages.count,
                                      let conf = displayMessages[index + 1].confirmation,
                                      conf.state != .pending else { return nil }
                                return conf
                            }()

                            let previousIsAssistant = index > 0 && displayMessages[index - 1].role == .assistant

                            ChatBubble(
                                message: message,
                                hideToolCalls: nextIsPendingConfirmation,
                                decidedConfirmation: nextDecidedConfirmation,
                                onSurfaceAction: onSurfaceAction,
                                onDismissDocumentWidget: { surfaceId in
                                    onDismissDocumentWidget?(surfaceId)
                                },
                                dismissedDocumentSurfaceIds: dismissedDocumentSurfaceIds,
                                onReportMessage: onReportMessage,
                                onRehydrate: message.wasTruncated ? { onRehydrateMessage?(message.id) } : nil,
                                mediaEmbedSettings: mediaEmbedSettings,
                                resolveHttpPort: resolveHttpPort,
                                showAvatar: !previousIsAssistant,
                                isLatestAssistantMessage: message.role == .assistant && message.id == latestAssistantId,
                                activeSurfaceId: activeSurfaceId
                            )
                                .id(message.id)
                                .transition(.opacity)
                        }

                        ForEach(subagentsByParent[message.id] ?? []) { subagent in
                            SubagentThreadView(
                                subagent: subagent,
                                events: subagentDetailStore.eventsBySubagent[subagent.id] ?? [],
                                onAbort: { onAbortSubagent?(subagent.id) },
                                onTap: { onSubagentTap?(subagent.id) }
                            )
                                .frame(maxWidth: 520, alignment: .leading)
                                .padding(.leading, 36)
                                .id("subagent-\(subagent.id)")
                                .transition(.opacity)
                        }
                    }

                    ForEach(orphanSubagents) { subagent in
                        SubagentThreadView(
                            subagent: subagent,
                            events: subagentDetailStore.eventsBySubagent[subagent.id] ?? [],
                            onAbort: { onAbortSubagent?(subagent.id) },
                            onTap: { onSubagentTap?(subagent.id) }
                        )
                            .frame(maxWidth: 520, alignment: .leading)
                            .padding(.leading, 36)
                            .id("subagent-\(subagent.id)")
                            .transition(.opacity.combined(with: .move(edge: .bottom)))
                    }

                    let lastVisible = displayMessages.last
                    let hasPendingConfirmation = lastVisible?.confirmation?.state == .pending
                    let currentTurnMessages: ArraySlice<ChatMessage> = {
                        if isSending, let last = displayMessages.last, last.role == .user {
                            let lastNonUser = displayMessages.last(where: {
                                $0.role != .user
                            })
                            let isActivelyProcessing = lastNonUser?.isStreaming == true
                                || lastNonUser?.confirmation?.state == .pending
                            if !isActivelyProcessing {
                                return displayMessages[displayMessages.endIndex...]
                            }
                        }
                        let lastTurnStart = displayMessages.indices.reversed().first(where: { idx in
                            displayMessages[idx].role == .user
                                && displayMessages.index(after: idx) < displayMessages.endIndex
                                && displayMessages[displayMessages.index(after: idx)].role != .user
                        })
                        if let idx = lastTurnStart {
                            return displayMessages[displayMessages.index(after: idx)...]
                        }
                        return displayMessages[displayMessages.startIndex...]
                    }()
                    let hasActiveToolCall = currentTurnMessages.contains(where: {
                        $0.toolCalls.contains(where: { !$0.isComplete })
                    })
                    if isSending && !(lastVisible?.isStreaming == true) && !hasPendingConfirmation && !hasActiveToolCall {
                        HStack(alignment: .top, spacing: VSpacing.sm) {
                            Image(nsImage: appearance.chatAvatarImage)
                                .interpolation(.none)
                                .resizable()
                                .aspectRatio(contentMode: .fill)
                                .frame(width: 28, height: 28)
                                .clipShape(Circle())
                                .padding(.top, 2)

                            RunningIndicator(
                                label: !hasEverSentMessage && displayMessages.contains(where: { $0.role == .user })
                                    ? "Waking up..."
                                    : "Thinking",
                                showIcon: false
                            )
                        }
                        .frame(maxWidth: 520, alignment: .leading)
                        .id("thinking-indicator")
                        .transition(.opacity.combined(with: .move(edge: .bottom)))
                    }

                    Color.clear.frame(height: 1)
                        .id("scroll-bottom-anchor")
                        .onAppear {
                            isNearBottom = true
                        }
                }
                .padding(.horizontal, VSpacing.xl)
                .padding(.top, VSpacing.md)
                .padding(.bottom, VSpacing.md)
                .frame(maxWidth: 700)
                .frame(maxWidth: .infinity)
            }
            .scrollContentBackground(.hidden)
            .scrollDisabled(messages.isEmpty && !isSending)
            .background {
                ScrollWheelDetector(
                    onScrollUp: { isNearBottom = false },
                    onScrollToBottom: { isNearBottom = true }
                )
            }
            .overlay(alignment: .bottom) {
                if !isNearBottom {
                    Button(action: {
                        isNearBottom = true
                        withAnimation(VAnimation.fast) {
                            proxy.scrollTo("scroll-bottom-anchor", anchor: .bottom)
                        }
                    }) {
                        HStack(spacing: VSpacing.xs) {
                            Image(systemName: "arrow.down")
                                .font(.system(size: 10, weight: .semibold))
                            Text("Scroll to latest")
                                .font(VFont.monoSmall)
                        }
                        .padding(.horizontal, VSpacing.md)
                        .padding(.vertical, VSpacing.sm)
                        .background(.ultraThinMaterial)
                        .clipShape(Capsule())
                        .shadow(color: .black.opacity(0.15), radius: 4, y: 2)
                    }
                    .buttonStyle(.plain)
                    .background { ScrollWheelPassthrough() }
                    .padding(.bottom, VSpacing.lg)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .onAppear {
                proxy.scrollTo("scroll-bottom-anchor", anchor: .bottom)
            }
            .onChange(of: isSending) {
                if isSending {
                    isNearBottom = true
                    withAnimation(VAnimation.standard) {
                        proxy.scrollTo("scroll-bottom-anchor", anchor: .bottom)
                    }
                }
            }
            .onChange(of: isThinking) {
                if !isThinking {
                    if !hasEverSentMessage && messages.contains(where: { $0.role == .user }) {
                        hasEverSentMessage = true
                    }
                }
            }
            .onChange(of: streamingScrollTrigger) {
                if isNearBottom {
                    // Throttle pattern: fire immediately then suppress for 200ms.
                    // Unlike debounce (cancel+recreate), this guarantees scrolls
                    // execute during active streaming, not only after the last token.
                    if scrollDebounceTask == nil {
                        scrollDebounceTask = Task {
                            // Re-check after the sleep — user may have scrolled away.
                            guard isNearBottom else {
                                scrollDebounceTask = nil
                                return
                            }
                            withAnimation(VAnimation.fast) {
                                proxy.scrollTo("scroll-bottom-anchor", anchor: .bottom)
                            }
                            try? await Task.sleep(nanoseconds: 200_000_000)
                            scrollDebounceTask = nil
                            // Trailing edge: content may have changed during cooldown.
                            if isNearBottom {
                                withAnimation(VAnimation.fast) {
                                    proxy.scrollTo("scroll-bottom-anchor", anchor: .bottom)
                                }
                            }
                        }
                    }
                }
            }
            .onChange(of: messages.count) {
                if isNearBottom {
                    withAnimation(VAnimation.fast) {
                        proxy.scrollTo("scroll-bottom-anchor", anchor: .bottom)
                    }
                }
            }
            .onChange(of: conversationZoomScale) {
                if isNearBottom {
                    proxy.scrollTo("scroll-bottom-anchor", anchor: .bottom)
                }
                // When mid-scroll, do nothing — let SwiftUI handle the text reflow naturally.
            }
            .onReceive(TaskProgressOverlayManager.shared.$activeSurfaceId) { newId in
                activeSurfaceId = newId
            }
        }
        .id(threadId)
    }
}
