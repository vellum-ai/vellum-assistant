import SwiftUI
import VellumAssistantShared
import UniformTypeIdentifiers

struct ChatView: View {
    let messages: [ChatMessage]
    @Binding var inputText: String
    let hasAPIKey: Bool
    let isThinking: Bool
    let isSending: Bool
    let errorText: String?
    let pendingQueuedCount: Int
    let suggestion: String?
    let pendingAttachments: [ChatAttachment]
    let isRecording: Bool
    let onOpenSettings: () -> Void
    let onSend: () -> Void
    let onStop: () -> Void
    let onDismissError: () -> Void
    let isRetryableError: Bool
    let onRetryError: () -> Void
    let isConnectionError: Bool
    let onOpenDoctor: () -> Void
    let isSecretBlockError: Bool
    let onSendAnyway: () -> Void
    let onAcceptSuggestion: () -> Void
    let onAttach: () -> Void
    let onRemoveAttachment: (String) -> Void
    let onDropFiles: ([URL]) -> Void
    let onDropImageData: (Data, String?) -> Void
    let onPaste: () -> Void
    let onMicrophoneToggle: () -> Void
    var onModelPickerSelect: ((UUID, String) -> Void)?
    var selectedModel: String = ""
    var configuredProviders: Set<String> = []
    let onConfirmationAllow: (String) -> Void
    let onConfirmationDeny: (String) -> Void
    let onAlwaysAllow: (String, String, String, String) -> Void
    let onSurfaceAction: (String, String, [String: AnyCodable]?) -> Void
    let sessionError: SessionError?
    let onRetry: () -> Void
    let onDismissSessionError: () -> Void
    let onCopyDebugInfo: () -> Void
    let watchSession: WatchSession?
    let onStopWatch: () -> Void
    var onReportMessage: ((String?) -> Void)?
    var mediaEmbedSettings: MediaEmbedResolverSettings?
    var isTemporaryChat: Bool = false
    var activeSubagents: [SubagentInfo] = []
    var onAbortSubagent: ((String) -> Void)?
    var onSubagentTap: ((String) -> Void)?
    var subagentDetailStore: SubagentDetailStore?
    var daemonHttpPort: Int?
    var isHistoryLoaded: Bool = true
    var dismissedDocumentSurfaceIds: Set<String> = []
    var onDismissDocumentWidget: ((String) -> Void)?

    /// Triggers auto-scroll when the last message's text length changes (e.g. during streaming).
    /// Sums utf8.count over each segment (O(1) per contiguous segment) instead of joining first,
    /// which would allocate a new String and re-scan O(n) bytes every delta.
    /// Uses total message text length (monotonically increasing) rather than the last segment's
    /// length, which resets when a new text segment starts after a tool call.
    private var streamingScrollTrigger: Int {
        // Use last non-queued message so streaming deltas still trigger
        // auto-scroll even when queued user messages sit at the array tail.
        let last = messages.last(where: { if case .queued = $0.status { return false }; return true })
        let textLen = last?.textSegments.reduce(0) { $0 + $1.utf8.count } ?? 0
        return textLen + (last?.toolCalls.count ?? 0) + (last?.inlineSurfaces.count ?? 0)
    }

    @State private var isNearBottom = true
    @State private var isDropTargeted = false
    @State private var editorContentHeight: CGFloat = 20
    @State private var isComposerExpanded = false
    @State private var identity: IdentityInfo? = IdentityInfo.load()
    @State private var appearance = AvatarAppearanceManager.shared
    @AppStorage("hasEverSentMessage") private var hasEverSentMessage: Bool = false
    @AppStorage("completedConversationCount") private var completedConversationCount: Int = 0

    private var isEmptyState: Bool {
        messages.isEmpty && isHistoryLoaded
    }

    private let composerMinHeight: CGFloat = 34

    var body: some View {
        ZStack {
            VStack(spacing: 0) {
                apiKeyBanner
                if messages.isEmpty && !isHistoryLoaded {
                    Spacer()
                    HStack {
                        Spacer()
                        ProgressView()
                            .controlSize(.small)
                        Spacer()
                    }
                    Spacer()
                } else if isEmptyState {
                    if isTemporaryChat {
                        ChatTemporaryChatEmptyStateView(
                            inputText: $inputText,
                            hasAPIKey: hasAPIKey,
                            isSending: isSending,
                            isRecording: isRecording,
                            suggestion: suggestion,
                            pendingAttachments: pendingAttachments,
                            errorText: errorText,
                            onSend: onSend,
                            onStop: onStop,
                            onAcceptSuggestion: onAcceptSuggestion,
                            onAttach: onAttach,
                            onRemoveAttachment: onRemoveAttachment,
                            onPaste: onPaste,
                            onMicrophoneToggle: onMicrophoneToggle,
                            onDismissError: onDismissError,
                            editorContentHeight: $editorContentHeight,
                            isComposerExpanded: $isComposerExpanded
                        )
                    } else {
                        ChatEmptyStateView(
                            inputText: $inputText,
                            hasAPIKey: hasAPIKey,
                            isSending: isSending,
                            isRecording: isRecording,
                            suggestion: suggestion,
                            pendingAttachments: pendingAttachments,
                            errorText: errorText,
                            onSend: onSend,
                            onStop: onStop,
                            onAcceptSuggestion: onAcceptSuggestion,
                            onAttach: onAttach,
                            onRemoveAttachment: onRemoveAttachment,
                            onPaste: onPaste,
                            onMicrophoneToggle: onMicrophoneToggle,
                            onDismissError: onDismissError,
                            editorContentHeight: $editorContentHeight,
                            isComposerExpanded: $isComposerExpanded
                        )
                    }
                } else {
                    ZStack(alignment: .bottom) {
                        messageList
                            .safeAreaInset(edge: .bottom) {
                                Color.clear.frame(height: composerReservedHeight)
                                    .animation(VAnimation.fast, value: editorContentHeight)
                            }

                        composerOverlay
                    }
                }
            }
            .background(alignment: .bottom) {
                chatBackground
            }
            .background(VColor.chatBackground)

            // Drop target overlay
            if isDropTargeted {
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .stroke(VColor.accent, style: StrokeStyle(lineWidth: 2, dash: [8, 4]))
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.lg)
                            .fill(VColor.accent.opacity(0.08))
                    )
                    .overlay {
                        VStack(spacing: VSpacing.sm) {
                            Image(systemName: "arrow.down.doc.fill")
                                .font(.system(size: 28, weight: .medium))
                                .foregroundColor(VColor.accent)
                            Text("Drop files here")
                                .font(VFont.bodyMedium)
                                .foregroundColor(VColor.accent)
                        }
                    }
                    .padding(VSpacing.lg)
                    .allowsHitTesting(false)
                    .transition(.opacity)
            }
        }
        .onDrop(of: [.fileURL, .image, .png, .tiff], isTargeted: $isDropTargeted) { providers in
            handleDrop(providers: providers)
        }
        .onChange(of: inputText) {
            // Reset composer height when input is cleared
            if inputText.isEmpty {
                editorContentHeight = composerMinHeight
            }
        }
    }

    /// Height reserved at the bottom of the scroll view so the last message isn't hidden behind the composer.
    private var composerReservedHeight: CGFloat {
        let editorClamped = min(max(editorContentHeight, 34), 200)
        let contentHeight = max(editorClamped, 34)
        let expanded = isComposerExpanded
        let topPad: CGFloat = expanded ? VSpacing.md : VSpacing.sm
        let bottomPad: CGFloat = expanded ? VSpacing.sm : VSpacing.sm
        let buttonRow: CGFloat = expanded ? 34 + VSpacing.xs : 0
        let base: CGFloat = VSpacing.sm + topPad + bottomPad + contentHeight + buttonRow
        let attachments: CGFloat = pendingAttachments.isEmpty ? 0 : 48
        let error: CGFloat = (sessionError == nil && errorText != nil) ? 36 : 0
        return base + attachments + error
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

    @MainActor private var composerOverlay: some View {
        VStack(spacing: 0) {
            if let watchSession, watchSession.state == .capturing {
                WatchProgressView(session: watchSession, onStop: onStopWatch)
                    .padding(.horizontal, VSpacing.lg)
                    .padding(.bottom, VSpacing.sm)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            if let errorText, sessionError == nil {
                ChatErrorBanner(
                    text: errorText,
                    isSecretBlockError: isSecretBlockError,
                    onSendAnyway: onSendAnyway,
                    isRetryableError: isRetryableError,
                    onRetryError: onRetryError,
                    isConnectionError: isConnectionError,
                    onOpenDoctor: onOpenDoctor,
                    onDismissError: onDismissError
                )
            }
            ComposerView(
                inputText: $inputText,
                hasAPIKey: hasAPIKey,
                isSending: isSending,
                isRecording: isRecording,
                suggestion: suggestion,
                pendingAttachments: pendingAttachments,
                onSend: onSend,
                onStop: onStop,
                onAcceptSuggestion: onAcceptSuggestion,
                onAttach: onAttach,
                onRemoveAttachment: onRemoveAttachment,
                onPaste: onPaste,
                onMicrophoneToggle: onMicrophoneToggle,
                placeholderText: "What would you like to do?",
                editorContentHeight: $editorContentHeight,
                isComposerExpanded: $isComposerExpanded
            )
        }
        .background(
            // Gentle fade that never becomes fully opaque — background stays visible
            LinearGradient(
                stops: [
                    .init(color: VColor.chatBackground.opacity(0), location: 0),
                    .init(color: VColor.chatBackground.opacity(0.5), location: 0.5),
                    .init(color: VColor.chatBackground.opacity(0.65), location: 1.0)
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            .allowsHitTesting(false)
        )
    }

    @Environment(\.colorScheme) private var colorScheme

    @ViewBuilder
    private var chatBackground: some View {
        EmptyView()
    }

    /// Handle dropped items — supports both file URLs and raw image data.
    /// File URLs are preferred (preserves original filenames); raw image data
    /// is used as a fallback for providers without a backing file (e.g. screenshot
    /// thumbnails or images dragged from certain apps).
    private func handleDrop(providers: [NSItemProvider]) -> Bool {
        var urls: [URL] = []
        var imageDataItems: [NSItemProvider] = []
        let group = DispatchGroup()

        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                let hasImageFallback = provider.hasItemConformingToTypeIdentifier(UTType.image.identifier)
                    || provider.hasItemConformingToTypeIdentifier(UTType.png.identifier)
                    || provider.hasItemConformingToTypeIdentifier(UTType.tiff.identifier)
                group.enter()
                _ = provider.loadObject(ofClass: URL.self) { url, _ in
                    DispatchQueue.main.async {
                        if let url, FileManager.default.fileExists(atPath: url.path) {
                            urls.append(url)
                            group.leave()
                        } else if hasImageFallback {
                            // File URL failed (e.g. screenshot not saved yet) — load raw image data instead
                            let typeIdentifier: String
                            if provider.hasItemConformingToTypeIdentifier(UTType.png.identifier) {
                                typeIdentifier = UTType.png.identifier
                            } else if provider.hasItemConformingToTypeIdentifier(UTType.tiff.identifier) {
                                typeIdentifier = UTType.tiff.identifier
                            } else {
                                typeIdentifier = UTType.image.identifier
                            }
                            let suggestedName = provider.suggestedName
                            provider.loadDataRepresentation(forTypeIdentifier: typeIdentifier) { data, _ in
                                DispatchQueue.main.async {
                                    if let data {
                                        onDropImageData(data, suggestedName)
                                    }
                                    group.leave()
                                }
                            }
                        } else {
                            group.leave()
                        }
                    }
                }
            } else if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier)
                        || provider.hasItemConformingToTypeIdentifier(UTType.png.identifier)
                        || provider.hasItemConformingToTypeIdentifier(UTType.tiff.identifier) {
                imageDataItems.append(provider)
            }
        }

        for provider in imageDataItems {
            let typeIdentifier: String
            if provider.hasItemConformingToTypeIdentifier(UTType.png.identifier) {
                typeIdentifier = UTType.png.identifier
            } else if provider.hasItemConformingToTypeIdentifier(UTType.tiff.identifier) {
                typeIdentifier = UTType.tiff.identifier
            } else {
                typeIdentifier = UTType.image.identifier
            }

            let suggestedName = provider.suggestedName
            group.enter()
            provider.loadDataRepresentation(forTypeIdentifier: typeIdentifier) { data, _ in
                DispatchQueue.main.async {
                    if let data {
                        onDropImageData(data, suggestedName)
                    }
                    group.leave()
                }
            }
        }

        group.notify(queue: .main) {
            if !urls.isEmpty { onDropFiles(urls) }
        }
        return true
    }

    // MARK: - Message List

    private func shouldShowTimestamp(at index: Int, in list: [ChatMessage]) -> Bool {
        if index == 0 { return true }
        let current = list[index].timestamp
        let previous = list[index - 1].timestamp
        // Always show a divider when crossing a calendar-day boundary (in local timezone)
        var calendar = Calendar.current
        calendar.timeZone = ChatTimestampTimeZone.resolve()
        if !calendar.isDate(current, inSameDayAs: previous) { return true }
        let gap = current.timeIntervalSince(previous)
        return gap > 300
    }

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: VSpacing.md) {
                    // Render all chat messages inline except subagent notification placeholders.
                    let displayMessages = messages.filter { msg in
                        if msg.isSubagentNotification { return false }
                        return true
                    }
                    let activePendingRequestId = PendingConfirmationFocusSelector.activeRequestId(from: displayMessages)
                    ForEach(Array(displayMessages.enumerated()), id: \.element.id) { index, message in
                        if shouldShowTimestamp(at: index, in: displayMessages) {
                            TimestampDivider(date: message.timestamp)
                        }

                        if let confirmation = message.confirmation {
                            if confirmation.state == .pending {
                                // Show pending confirmations as inline buttons
                                ToolConfirmationBubble(
                                    confirmation: confirmation,
                                    isKeyboardActive: confirmation.requestId == activePendingRequestId,
                                    onAllow: { onConfirmationAllow(confirmation.requestId) },
                                    onDeny: { onConfirmationDeny(confirmation.requestId) },
                                    onAlwaysAllow: onAlwaysAllow
                                )
                                .id(message.id)
                                .transition(.opacity.combined(with: .move(edge: .bottom)))
                            }
                            // Decided confirmations are normally rendered as compact chips
                            // on the preceding assistant message's ChatBubble. But if there
                            // is no preceding assistant message, render them inline so they
                            // don't disappear entirely.
                            else {
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
                                    .transition(.opacity.combined(with: .move(edge: .bottom)))
                                }
                                // When there IS a preceding assistant message, the decided
                                // confirmation is rendered as a chip on that bubble — skip here.
                            }
                        } else if message.modelPicker != nil {
                            modelPickerView(for: message)
                                .id(message.id)
                                .transition(.opacity.combined(with: .move(edge: .bottom)))
                        } else if message.modelList != nil {
                            modelListView(for: message)
                                .id(message.id)
                                .transition(.opacity.combined(with: .move(edge: .bottom)))
                        } else if message.commandList != nil {
                            CommandListBubble()
                                .id(message.id)
                                .transition(.opacity.combined(with: .move(edge: .bottom)))
                        } else {
                            // Hide tool call chips when the next message is a pending
                            // confirmation — the tool hasn't been approved yet.
                            let nextIsPendingConfirmation = index + 1 < displayMessages.count
                                && displayMessages[index + 1].confirmation?.state == .pending

                            // Pass decided confirmation from the next message so it
                            // renders as a compact chip at the bottom of this bubble.
                            let nextDecidedConfirmation: ToolConfirmationData? = {
                                guard index + 1 < displayMessages.count,
                                      let conf = displayMessages[index + 1].confirmation,
                                      conf.state != .pending else { return nil }
                                return conf
                            }()

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
                                mediaEmbedSettings: mediaEmbedSettings,
                                daemonHttpPort: daemonHttpPort,
                                isLatestAssistantMessage: message.role == .assistant && displayMessages.last(where: { $0.role == .assistant })?.id == message.id
                            )
                                .id(message.id)
                                .transition(.opacity.combined(with: .move(edge: .bottom)))
                        }

                        // Subagent thread indicators anchored to the message that spawned them
                        // Indent to align with message text (past the 28pt avatar + 8pt spacing)
                        ForEach(activeSubagents.filter { $0.parentMessageId == message.id }) { subagent in
                            SubagentThreadView(
                                subagent: subagent,
                                events: subagentDetailStore?.eventsBySubagent[subagent.id] ?? [],
                                onAbort: { onAbortSubagent?(subagent.id) },
                                onTap: { onSubagentTap?(subagent.id) }
                            )
                                .frame(maxWidth: 520, alignment: .leading)
                                .padding(.leading, 36)
                                .id("subagent-\(subagent.id)")
                                .transition(.opacity.combined(with: .move(edge: .bottom)))
                        }
                    }

                    // Subagents with no parent message (e.g. from history load)
                    ForEach(activeSubagents.filter { $0.parentMessageId == nil }) { subagent in
                        SubagentThreadView(
                            subagent: subagent,
                            events: subagentDetailStore?.eventsBySubagent[subagent.id] ?? [],
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
                    // Check the current assistant turn for active tool calls.
                    // We scope to messages after the last user message that
                    // started an assistant turn so that stale incomplete tool
                    // calls from earlier turns (e.g. after daemon errors) don't
                    // permanently suppress the thinking indicator. When the
                    // last message is .user while isSending and the assistant
                    // isn't actively processing (not streaming and no pending
                    // confirmation), we return an empty slice so stale tool
                    // calls don't suppress the indicator. When the user queued
                    // a follow-up while the assistant is still streaming or
                    // awaiting confirmation, we fall through so active tool
                    // calls remain visible. We still scan beyond lastVisible
                    // because confirmation messages are inserted after the
                    // assistant message that owns the tool call.
                    let currentTurnMessages: ArraySlice<ChatMessage> = {
                        // When the very last message is from the user and we're
                        // still sending, check whether the assistant is actively
                        // responding in the current turn. Skip past trailing
                        // user messages (queued follow-ups) and examine the
                        // last non-user message. Only fall through to
                        // lastTurnStart (preserving active tool-call detection)
                        // if that message is still streaming or has a pending
                        // confirmation — both indicate the assistant is
                        // genuinely in-flight. A finalized (non-streaming)
                        // assistant message with incomplete tool calls but no
                        // pending confirmation is stale (daemon errored or
                        // completed), so we return an empty slice to prevent
                        // those stale tool calls from suppressing the thinking
                        // indicator.
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
                        // Find the boundary of the current assistant turn by
                        // locating the last user message that is followed by at
                        // least one non-user message. This ignores queued user
                        // messages appended at the tail during isSending.
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
                                    : completedConversationCount <= 5 && identity?.name != nil
                                        ? "\(identity!.name) is thinking"
                                        : "Thinking",
                                showIcon: false
                            )
                        }
                        .frame(maxWidth: 520, alignment: .leading)
                        .id("thinking-indicator")
                        .transition(.opacity.combined(with: .move(edge: .bottom)))
                    }

                    // Invisible anchor at the very bottom of all content
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
                // Scroll to bottom on initial load
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
                    // Thinking finished — mark flag so next message shows "Thinking"
                    if !hasEverSentMessage && messages.contains(where: { $0.role == .user }) {
                        hasEverSentMessage = true
                    }
                }
            }
            .onChange(of: streamingScrollTrigger) {
                if isNearBottom {
                    withAnimation(VAnimation.fast) {
                        proxy.scrollTo("scroll-bottom-anchor", anchor: .bottom)
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
        }
    }

    @ViewBuilder
    private var apiKeyBanner: some View {
        if !hasAPIKey {
            HStack(spacing: VSpacing.sm) {
                Image(systemName: "key.fill")
                    .font(VFont.caption)
                Text("API key not set. Add one in Settings to start chatting.")
                    .font(VFont.caption)
                    .lineLimit(2)
                Spacer()
                Button("Open Settings", action: onOpenSettings)
                    .buttonStyle(.borderedProminent)
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.sm)
            .foregroundColor(.white)
            .background(VColor.warning)
        }
    }
}

// MARK: - Scroll Wheel Detection

/// Detects user-initiated scroll events scoped to the chat scroll view.
/// Fires `onScrollUp` when the user scrolls toward older content (untethers auto-scroll),
/// and `onScrollToBottom` when the user manually scrolls back to the bottom (re-tethers).
private struct ScrollWheelDetector: NSViewRepresentable {
    let onScrollUp: () -> Void
    let onScrollToBottom: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        let coordinator = context.coordinator
        coordinator.view = view
        coordinator.onScrollUp = onScrollUp
        coordinator.onScrollToBottom = onScrollToBottom
        coordinator.monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { event in
            // Only process events within this view's bounds (scoped to the chat scroll area)
            guard let view = coordinator.view,
                  let window = view.window,
                  event.window == window else { return event }
            let locationInView = view.convert(event.locationInWindow, from: nil)
            guard view.bounds.width > 0, view.bounds.contains(locationInView) else { return event }

            if event.scrollingDeltaY > 3 && event.momentumPhase.isEmpty {
                // Direct user scroll up (toward older content) — untether,
                // but only if actually scrolled away from the bottom.
                // Momentum events are excluded so a flick doesn't accidentally untether.
                if let scrollView = coordinator.findEnclosingScrollView() {
                    let clipBounds = scrollView.contentView.bounds
                    let docHeight = scrollView.documentView?.frame.height ?? 0
                    if docHeight - clipBounds.maxY >= 50 {
                        coordinator.onScrollUp?()
                    }
                } else {
                    coordinator.onScrollUp?()
                }
            } else if event.scrollingDeltaY < -1 {
                // Scrolling down (direct or momentum) — re-tether if at bottom.
                // Scrolling down — check if the underlying NSScrollView is at the bottom
                if let scrollView = coordinator.findEnclosingScrollView() {
                    let clipBounds = scrollView.contentView.bounds
                    let docHeight = scrollView.documentView?.frame.height ?? 0
                    if docHeight - clipBounds.maxY < 50 {
                        coordinator.onScrollToBottom?()
                    }
                }
            }
            return event
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        context.coordinator.onScrollUp = onScrollUp
        context.coordinator.onScrollToBottom = onScrollToBottom
    }

    static func dismantleNSView(_ nsView: NSView, coordinator: Coordinator) {
        if let monitor = coordinator.monitor {
            NSEvent.removeMonitor(monitor)
        }
    }

    class Coordinator {
        weak var view: NSView?
        var onScrollUp: (() -> Void)?
        var onScrollToBottom: (() -> Void)?
        var monitor: Any?

        func findEnclosingScrollView() -> NSScrollView? {
            var current = view?.superview
            while let v = current {
                if let sv = v as? NSScrollView { return sv }
                current = v.superview
            }
            return nil
        }
    }
}

// MARK: - Scroll Wheel Passthrough

/// Forwards scroll-wheel events to the chat's NSScrollView so that overlaid
/// controls (like the "Scroll to latest" pill) don't swallow trackpad/mouse-wheel input.
private struct ScrollWheelPassthrough: NSViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        let coordinator = context.coordinator
        coordinator.view = view
        coordinator.monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { event in
            guard let v = coordinator.view,
                  let window = v.window,
                  event.window == window else { return event }
            let location = v.convert(event.locationInWindow, from: nil)
            guard v.bounds.width > 0, v.bounds.contains(location) else { return event }

            if let scrollView = coordinator.findScrollView(for: event) {
                scrollView.scrollWheel(with: event)
                return nil // consume — we already forwarded it; prevents double-delivery
            }
            return event
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {}

    static func dismantleNSView(_ nsView: NSView, coordinator: Coordinator) {
        if let monitor = coordinator.monitor {
            NSEvent.removeMonitor(monitor)
        }
    }

    class Coordinator {
        weak var view: NSView?
        var monitor: Any?

        /// Finds the deepest NSScrollView whose frame contains the event point.
        /// This ensures we forward to the chat scroll view, not the sidebar.
        func findScrollView(for event: NSEvent) -> NSScrollView? {
            guard let contentView = view?.window?.contentView else { return nil }
            return Self.deepestScrollView(in: contentView, containing: event.locationInWindow)
        }

        private static func deepestScrollView(in view: NSView, containing windowPoint: NSPoint) -> NSScrollView? {
            let localPoint = view.convert(windowPoint, from: nil)
            guard view.bounds.contains(localPoint) else { return nil }

            for sub in view.subviews.reversed() {
                if let sv = deepestScrollView(in: sub, containing: windowPoint) {
                    return sv
                }
            }

            if let sv = view as? NSScrollView { return sv }
            return nil
        }
    }
}

// MARK: - Preview

#if DEBUG
struct ChatView_Preview: PreviewProvider {
    static var previews: some View {
        ChatViewPreviewWrapper()
            .frame(width: 600, height: 500)
            .previewDisplayName("ChatView")
    }
}

private struct ChatViewPreviewWrapper: View {
    @State private var text = ""

    private let sampleMessages: [ChatMessage] = [
        ChatMessage(role: .assistant, text: "Hello! How can I help you today?"),
        ChatMessage(role: .user, text: "Can you tell me about SwiftUI?"),
        ChatMessage(
            role: .assistant,
            text: "SwiftUI is a declarative framework for building user interfaces across Apple platforms. It uses a reactive data-binding model and composable view hierarchy."
        ),
        ChatMessage(role: .user, text: "That sounds great, thanks!"),
    ]

    var body: some View {
        ZStack {
            VColor.background.ignoresSafeArea()
            ChatView(
                messages: sampleMessages,
                inputText: $text,
                hasAPIKey: true,
                isThinking: true,
                isSending: false,
                errorText: nil,
                pendingQueuedCount: 0,
                suggestion: "That sounds great, thanks!",
                pendingAttachments: [],
                isRecording: false,
                onOpenSettings: {},
                onSend: {},
                onStop: {},
                onDismissError: {},
                isRetryableError: false,
                onRetryError: {},
                isConnectionError: false,
                onOpenDoctor: {},
                isSecretBlockError: false,
                onSendAnyway: {},
                onAcceptSuggestion: {},
                onAttach: {},
                onRemoveAttachment: { _ in },
                onDropFiles: { _ in },
                onDropImageData: { _, _ in },
                onPaste: {},
                onMicrophoneToggle: {},
                onConfirmationAllow: { _ in },
                onConfirmationDeny: { _ in },
                onAlwaysAllow: { _, _, _, _ in },
                onSurfaceAction: { _, _, _ in },
                sessionError: nil,
                onRetry: {},
                onDismissSessionError: {},
                onCopyDebugInfo: {},
                watchSession: nil,
                onStopWatch: {}
            )
        }
    }
}
#endif
