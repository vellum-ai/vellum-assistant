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
    let onAddTrustRule: (String, String, String, String) -> Bool
    let onSurfaceAction: (String, String, [String: AnyCodable]?) -> Void
    let onRegenerate: () -> Void
    let sessionError: SessionError?
    let onRetry: () -> Void
    let onDismissSessionError: () -> Void
    let onCopyDebugInfo: () -> Void
    let watchSession: WatchSession?
    let onStopWatch: () -> Void
    var onReportMessage: ((String?) -> Void)?
    var onDeleteQueuedMessage: ((UUID) -> Void)?
    var mediaEmbedSettings: MediaEmbedResolverSettings?
    var isTemporaryChat: Bool = false
    var activeSubagents: [SubagentInfo] = []
    var daemonHttpPort: Int?
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

    @State private var isDropTargeted = false
    @State private var editorContentHeight: CGFloat = 20
    @State private var isComposerExpanded = false
    @State private var isQueueExpanded = true
    @State private var identity: IdentityInfo? = IdentityInfo.load()
    @State private var appearance = AvatarAppearanceManager.shared
    @AppStorage("hasEverSentMessage") private var hasEverSentMessage: Bool = false

    private var isEmptyState: Bool {
        messages.isEmpty && !isSending
    }

    private let composerMinHeight: CGFloat = 34

    var body: some View {
        ZStack {
            VStack(spacing: 0) {
                apiKeyBanner
                if isEmptyState {
                    if isTemporaryChat {
                        ChatTemporaryChatEmptyStateView(
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
                            onSend: onSend,
                            onStop: onStop,
                            onAcceptSuggestion: onAcceptSuggestion,
                            onAttach: onAttach,
                            onRemoveAttachment: onRemoveAttachment,
                            onPaste: onPaste,
                            onMicrophoneToggle: onMicrophoneToggle,
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
        let topPad: CGFloat = expanded ? VSpacing.md : VSpacing.xs
        let bottomPad: CGFloat = expanded ? VSpacing.sm : VSpacing.xs
        let buttonRow: CGFloat = expanded ? 34 + VSpacing.xs : 0
        let base: CGFloat = VSpacing.sm + VSpacing.md + topPad + bottomPad + contentHeight + buttonRow
        let attachments: CGFloat = pendingAttachments.isEmpty ? 0 : 48
        let error: CGFloat = (sessionError == nil && errorText != nil) ? 36 : 0
        let queueCount = CGFloat(queuedMessages.count)
        let queue: CGFloat = queueCount > 0 ? (28 + (isQueueExpanded ? queueCount * 24 : 0) + VSpacing.xs) : 0
        return base + attachments + error + queue
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
                    onDismissError: onDismissError
                )
            }
            ChatQueueSummaryView(
                queuedMessages: queuedMessages,
                onDeleteQueuedMessage: onDeleteQueuedMessage,
                isExpanded: $isQueueExpanded
            )
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
                LazyVStack(alignment: .leading, spacing: VSpacing.lg) {
                    // Filter out queued messages — they're shown above the composer instead
                    let displayMessages = messages.filter { msg in
                        if case .queued = msg.status { return false }
                        return true
                    }
                    ForEach(Array(displayMessages.enumerated()), id: \.element.id) { index, message in
                        if shouldShowTimestamp(at: index, in: displayMessages) {
                            TimestampDivider(date: message.timestamp)
                        }

                        if let confirmation = message.confirmation {
                            if confirmation.state == .pending {
                                // Show pending confirmations as inline buttons
                                ToolConfirmationBubble(
                                    confirmation: confirmation,
                                    onAllow: { onConfirmationAllow(confirmation.requestId) },
                                    onDeny: { onConfirmationDeny(confirmation.requestId) },
                                    onAddTrustRule: onAddTrustRule
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
                                        onAddTrustRule: onAddTrustRule
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

                            let isLastAssistant = message.role == .assistant
                                && !message.isStreaming
                                && (index == displayMessages.count - 1
                                    || (index == displayMessages.count - 2
                                        && displayMessages[displayMessages.count - 1].confirmation != nil && displayMessages[displayMessages.count - 1].confirmation?.state != .pending))
                                && !isSending
                                && !isThinking

                            ChatBubble(
                                message: message,
                                hideToolCalls: nextIsPendingConfirmation,
                                decidedConfirmation: nextDecidedConfirmation,
                                showRegenerate: isLastAssistant,
                                onRegenerate: onRegenerate,
                                onSurfaceAction: onSurfaceAction,
                                onDismissDocumentWidget: { surfaceId in
                                    onDismissDocumentWidget?(surfaceId)
                                },
                                dismissedDocumentSurfaceIds: dismissedDocumentSurfaceIds,
                                onReportMessage: onReportMessage,
                                mediaEmbedSettings: mediaEmbedSettings,
                                daemonHttpPort: daemonHttpPort
                            )
                                .id(message.id)
                                .transition(.opacity.combined(with: .move(edge: .bottom)))
                        }

                        // Subagent chips anchored to the message that spawned them
                        ForEach(activeSubagents.filter { $0.parentMessageId == message.id }) { subagent in
                            SubagentStatusChip(subagent: subagent)
                                .frame(maxWidth: 520, alignment: .leading)
                                .id("subagent-\(subagent.id)")
                                .transition(.opacity.combined(with: .move(edge: .bottom)))
                        }
                    }

                    // Subagents with no parent message (e.g. from history load)
                    ForEach(activeSubagents.filter { $0.parentMessageId == nil }) { subagent in
                        SubagentStatusChip(subagent: subagent)
                            .frame(maxWidth: 520, alignment: .leading)
                            .id("subagent-\(subagent.id)")
                            .transition(.opacity.combined(with: .move(edge: .bottom)))
                    }

                    let lastVisible = displayMessages.last
                    let hasPendingConfirmation = lastVisible?.confirmation?.state == .pending
                    let hasActiveToolCall = lastVisible?.toolCalls.contains(where: { !$0.isComplete }) == true
                    if isSending && !(lastVisible?.isStreaming == true) && !hasPendingConfirmation && !hasActiveToolCall {
                        RunningIndicator(
                            label: !hasEverSentMessage && displayMessages.contains(where: { $0.role == .user }) ? "Waking up..." : "Thinking",
                            showIcon: false
                        )
                        .frame(maxWidth: 520, alignment: .leading)
                        .id("thinking-indicator")
                        .transition(.opacity.combined(with: .move(edge: .bottom)))
                    }

                    // Invisible anchor at the very bottom of all content
                    Color.clear.frame(height: 1)
                        .id("scroll-bottom-anchor")
                }
                .padding(.horizontal, VSpacing.xl)
                .padding(.top, VSpacing.md)
                .padding(.bottom, VSpacing.md)
                .frame(maxWidth: 700)
                .frame(maxWidth: .infinity)
            }
            .scrollContentBackground(.hidden)
            .scrollDisabled(messages.isEmpty && !isSending)
            .onAppear {
                // Scroll to bottom on initial load
                proxy.scrollTo("scroll-bottom-anchor", anchor: .bottom)
            }
            .onChange(of: isSending) {
                if isSending {
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
                withAnimation(VAnimation.fast) {
                    proxy.scrollTo("scroll-bottom-anchor", anchor: .bottom)
                }
            }
            .onChange(of: messages.count) {
                withAnimation(VAnimation.fast) {
                    proxy.scrollTo("scroll-bottom-anchor", anchor: .bottom)
                }
            }
        }
    }

    // MARK: - Queued Messages (above composer)

    /// Messages waiting in the queue, shown stacked above the input field
    /// so they don't break chronological order in the chat feed.
    private var queuedMessages: [ChatMessage] {
        messages.filter { msg in
            if case .queued = msg.status { return true }
            return false
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

// MARK: - Chat Bubble

private struct ChatBubble: View {
    let message: ChatMessage
    /// When true, tool call chips are suppressed because a nearby message has inline surfaces.
    let hideToolCalls: Bool
    /// Decided confirmation from the next message, rendered as a compact chip at the bottom.
    let decidedConfirmation: ToolConfirmationData?
    /// Whether to show the regenerate button on this message.
    let showRegenerate: Bool
    let onRegenerate: () -> Void
    let onSurfaceAction: (String, String, [String: AnyCodable]?) -> Void
    let onDismissDocumentWidget: (String) -> Void
    let dismissedDocumentSurfaceIds: Set<String>
    var onReportMessage: ((String?) -> Void)?
    var mediaEmbedSettings: MediaEmbedResolverSettings?
    var daemonHttpPort: Int?

    @State private var appearance = AvatarAppearanceManager.shared
    @State private var isHovered = false
    @State private var isRegenerateHovered = false
    @State private var isCopyHovered = false

    @State private var showCopyConfirmation = false
    @State private var copyConfirmationTimer: DispatchWorkItem?
    @State private var mediaEmbedIntents: [MediaEmbedIntent] = []
    @State private var stepsExpanded = false

    private var isUser: Bool { message.role == .user }
    private var canReportMessage: Bool {
        !isUser && onReportMessage != nil
    }

    /// Composite identity for the `.task` modifier so it re-runs when either
    /// the message text or the embed settings change.
    /// Returns a stable value while the message is streaming to avoid
    /// cancelling and relaunching the async media embed resolution
    /// (NSDataDetector + regex + HTTP HEAD probes) on every token delta.
    private var mediaEmbedTaskID: String {
        if message.isStreaming { return "streaming-\(message.id)" }
        let s = mediaEmbedSettings
        return "\(message.text)|\(s?.enabled ?? false)|\(s?.enabledSince?.timeIntervalSince1970 ?? 0)|\(s?.allowedDomains ?? [])"
    }

    private var bubbleFill: AnyShapeStyle {
        if isUser {
            AnyShapeStyle(VColor.userBubble)
        } else if message.isError {
            AnyShapeStyle(VColor.error.opacity(0.1))
        } else {
            AnyShapeStyle(Color.clear)
        }
    }

    private var formattedTimestamp: String {
        let tz = ChatTimestampTimeZone.resolve()
        var calendar = Calendar.current
        calendar.timeZone = tz
        let formatter = DateFormatter()
        formatter.timeZone = tz
        formatter.dateFormat = "H:mm"
        let timeString = formatter.string(from: message.timestamp)
        if calendar.isDateInToday(message.timestamp) {
            return "Today, \(timeString)"
        } else {
            let dayFormatter = DateFormatter()
            dayFormatter.timeZone = tz
            dayFormatter.dateFormat = "MMM d"
            return "\(dayFormatter.string(from: message.timestamp)), \(timeString)"
        }
    }

    /// Whether the text/attachment bubble should be rendered.
    /// Tool calls for assistant messages render outside the bubble as separate chips,
    /// so only show the bubble when there's actual text or attachment content.
    ///
    /// NOTE: When inline surfaces are present, the bubble is intentionally hidden
    /// even if the message also contains text. This is by design — the assistant's
    /// text in these cases is typically a preamble (e.g. "Here's what I built:")
    /// that should not appear above the rendered dynamic UI surface.
    private var shouldShowBubble: Bool {
        if isUser { return true }
        if !message.inlineSurfaces.isEmpty {
            // Show bubble text when all surfaces are completed (collapsed to chips)
            let allCompleted = message.inlineSurfaces.allSatisfy { $0.completionState != nil }
            if !allCompleted { return false }
        }
        return hasText || !message.attachments.isEmpty
    }

    var body: some View {
        HStack(alignment: .top, spacing: VSpacing.sm) {
            if isUser { Spacer(minLength: 0) }

            if !isUser {
                Image(nsImage: appearance.chatAvatarImage)
                    .interpolation(.none)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .frame(width: 28, height: 28)
                    .clipShape(Circle())
                    .padding(.top, 2)
            }

            VStack(alignment: isUser ? .trailing : .leading, spacing: VSpacing.sm) {
                if !isUser && hasInterleavedContent {
                    interleavedContent
                } else {
                    if shouldShowBubble {
                        bubbleContent
                    }

                    // Inline surfaces render below the bubble as full-width cards
                    if !message.inlineSurfaces.isEmpty {
                        ForEach(message.inlineSurfaces) { surface in
                            InlineSurfaceRouter(surface: surface, onAction: onSurfaceAction)
                        }
                    }

                    // Document widget for document_create tool calls
                    if let documentToolCall = message.toolCalls.first(where: { $0.toolName == "document_create" && $0.isComplete }) {
                        documentWidget(for: documentToolCall)
                    }
                }

                // Media embeds rendered below the text, preserving source order
                ForEach(mediaEmbedIntents.indices, id: \.self) { idx in
                    switch mediaEmbedIntents[idx] {
                    case .image(let url):
                        InlineImageEmbedView(url: url)
                    case .video(let provider, let videoID, let embedURL):
                        InlineVideoEmbedCard(provider: provider, videoID: videoID, embedURL: embedURL)
                    }
                }

                // Single unified status area at the bottom of the message:
                // - In-progress: shows "Running a terminal command ..."
                // - Complete: shows compact chips ("Ran a terminal command" + "Permission granted")
                if !isUser {
                    trailingStatus
                }

                HStack(spacing: VSpacing.xs) {
                    if !message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        copyButton
                    }

                    if showRegenerate {
                        regenerateButton
                    }

                    if canReportMessage {
                        // Use ZStack + conditional rendering so the NSPopUpButton is only
                        // in the view hierarchy while hovered — avoiding per-message SF
                        // Symbol and accessibility-string lookups on every scroll frame
                        // that cause the scroll crash (see #4809).
                        ZStack {
                            Color.clear.frame(width: 24, height: 24)
                            if isHovered {
                                Menu {
                                    if let onReportMessage {
                                        Button("Export response for diagnostics") {
                                            onReportMessage(message.daemonMessageId)
                                        }
                                    }
                                } label: {
                                    Image(systemName: "ellipsis")
                                        .font(.system(size: 11, weight: .medium))
                                        .foregroundColor(VColor.textMuted)
                                        .frame(width: 24, height: 24)
                                        .contentShape(Rectangle())
                                }
                                .menuStyle(.borderlessButton)
                                .menuIndicator(.hidden)
                                .tint(VColor.textMuted)
                                .frame(width: 24, height: 24)
                                .accessibilityLabel("Message actions")
                                .transition(.opacity.animation(VAnimation.fast))
                            }
                        }
                    }
                }
            }
            // Prevent LazyVStack from compressing the bubble height, which causes the
            // trailing tool-chip to overlap long text content.
            .fixedSize(horizontal: false, vertical: true)
            .contextMenu {}

            if !isUser { Spacer(minLength: 0) }
        }
        .contentShape(Rectangle())
        .onHover { hovering in
            isHovered = hovering
        }
        .task(id: mediaEmbedTaskID) {
            guard !message.isStreaming else { return }
            guard let settings = mediaEmbedSettings else {
                mediaEmbedIntents = []
                return
            }
            let resolved = await MediaEmbedResolver.resolve(message: message, settings: settings)
            guard !Task.isCancelled else { return }
            mediaEmbedIntents = resolved
        }
    }

    // MARK: - Compact trailing chips (tool calls + permission)

    /// Whether all tool calls are complete and the message is done streaming.
    private var allToolCallsComplete: Bool {
        !message.toolCalls.isEmpty && message.toolCalls.allSatisfy { $0.isComplete } && !message.isStreaming
    }

    private var copyButton: some View {
        Button {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(message.text, forType: .string)
            copyConfirmationTimer?.cancel()
            showCopyConfirmation = true
            let timer = DispatchWorkItem { showCopyConfirmation = false }
            copyConfirmationTimer = timer
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: timer)
        } label: {
            Image(systemName: showCopyConfirmation ? "checkmark" : "doc.on.doc")
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(showCopyConfirmation ? VColor.success : VColor.textMuted)
                .frame(width: 24, height: 24)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Copy message")
        .onHover { hovering in
            isCopyHovered = hovering
            if hovering {
                NSCursor.pointingHand.set()
            } else {
                NSCursor.arrow.set()
            }
        }
        .overlay(alignment: .bottom) {
            if isCopyHovered && !showCopyConfirmation {
                Text("Copy")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textPrimary)
                    .padding(.horizontal, VSpacing.sm)
                    .padding(.vertical, VSpacing.xs)
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.sm)
                            .fill(VColor.surface)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.sm)
                            .stroke(VColor.surfaceBorder, lineWidth: 1)
                    )
                    .vShadow(VShadow.sm)
                    .fixedSize()
                    .offset(y: 28)
                    .transition(.opacity)
                    .allowsHitTesting(false)
            }
        }
        .opacity(isUser ? (isHovered ? 1 : 0) : 1)
        .allowsHitTesting(isUser ? isHovered : true)
        .animation(VAnimation.fast, value: isHovered)
    }

    private var regenerateButton: some View {
        Button(action: onRegenerate) {
            Image(systemName: "arrow.trianglehead.counterclockwise")
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(VColor.textMuted)
                .frame(width: 24, height: 24)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Try again")
        .onHover { isRegenerateHovered = $0 }
        .overlay(alignment: .bottom) {
            if isRegenerateHovered {
                Text("Try again")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textPrimary)
                    .padding(.horizontal, VSpacing.sm)
                    .padding(.vertical, VSpacing.xs)
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.sm)
                            .fill(VColor.surface)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.sm)
                            .stroke(VColor.surfaceBorder, lineWidth: 1)
                    )
                    .vShadow(VShadow.sm)
                    .fixedSize()
                    .offset(y: 28)
                    .transition(.opacity)
                    .allowsHitTesting(false)
            }
        }
        .animation(VAnimation.fast, value: isRegenerateHovered)
    }

    /// Whether the permission was denied, meaning incomplete tools were blocked (not running).
    private var permissionWasDenied: Bool {
        decidedConfirmation?.state == .denied || decidedConfirmation?.state == .timedOut
    }

    @ViewBuilder
    private var trailingStatus: some View {
        let hasCompletedTools = allToolCallsComplete && !hideToolCalls && !message.toolCalls.isEmpty
        /// True when there is at least one tool call that hasn't finished yet.
        let hasActuallyRunningTool = !hideToolCalls && message.toolCalls.contains(where: { !$0.isComplete })
        /// All individual tool calls done but message still streaming (model generating next tool call).
        let toolsCompleteButStillStreaming = !hideToolCalls && !message.toolCalls.isEmpty
            && message.toolCalls.allSatisfy({ $0.isComplete }) && message.isStreaming
        let hasInProgressTools = !message.toolCalls.isEmpty && !hideToolCalls && !allToolCallsComplete
        let hasPermission = decidedConfirmation != nil
        let hasStreamingCode = message.isStreaming && message.streamingCodePreview != nil && !(message.streamingCodePreview?.isEmpty ?? true)

        if hasStreamingCode {
            let rawName = message.streamingCodeToolName ?? ""
            let activeBuildingStatus = message.toolCalls.last(where: { !$0.isComplete })?.buildingStatus
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                RunningIndicator(
                    label: Self.friendlyRunningLabel(rawName, buildingStatus: activeBuildingStatus),
                    onTap: nil
                )
                CodePreviewView(code: message.streamingCodePreview!)
            }
            .frame(maxWidth: 520, alignment: .leading)
        } else if hasActuallyRunningTool && !permissionWasDenied {
            // In progress — show single running indicator for the active tool
            let current = message.toolCalls.first(where: { !$0.isComplete })!
            let progressive = current.buildingStatus != nil ? [] : Self.progressiveLabels(for: current.toolName)
            RunningIndicator(
                label: Self.friendlyRunningLabel(current.toolName, inputSummary: current.inputSummary, buildingStatus: current.buildingStatus),
                progressiveLabels: progressive,
                labelInterval: progressive.isEmpty ? 6 : 15,
                onTap: nil
            )
                .frame(maxWidth: 520, alignment: .leading)
        } else if toolsCompleteButStillStreaming && !permissionWasDenied {
            // All tools done but model is still working (generating next tool call)
            RunningIndicator(
                label: "Thinking",
                progressiveLabels: ["Thinking", "Figuring out next steps", "Almost ready"],
                labelInterval: 8,
                onTap: nil
            )
                .frame(maxWidth: 520, alignment: .leading)
        } else if hasCompletedTools || hasPermission || (hasInProgressTools && permissionWasDenied) {
            // All done (or denied) — steps pill + permission chip on one row,
            // with the expanded steps list in the row below.
            let onlyPermissionTools = message.toolCalls.allSatisfy { $0.toolName == "request_system_permission" }
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .center, spacing: VSpacing.sm) {
                    if hasCompletedTools && !(onlyPermissionTools && decidedConfirmation != nil) {
                        UsedToolsList(toolCalls: message.toolCalls, isExpanded: $stepsExpanded)
                    } else if hasInProgressTools && permissionWasDenied {
                        compactFailedToolChip
                    }
                    if let confirmation = decidedConfirmation {
                        compactPermissionChip(confirmation)
                    }
                    Spacer()
                }

                if stepsExpanded && hasCompletedTools {
                    StepsSection(toolCalls: message.toolCalls)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
            .animation(VAnimation.fast, value: stepsExpanded)
            .padding(.top, VSpacing.xxs)
        }
    }

    /// Maps tool names to user-friendly past-tense labels.
    /// When `inputSummary` is provided, produces contextual labels like "Read config.json".
    private static func friendlyToolLabel(_ toolName: String, inputSummary: String = "") -> String {
        let name = toolName.lowercased()
        let summary = inputSummary
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)

        // Extract just the filename from a file path.
        let fileName: String? = {
            guard !summary.isEmpty else { return nil }
            let last = (summary as NSString).lastPathComponent
            guard !last.isEmpty, last != "." else { return nil }
            return last
        }()

        switch name {
        case "run command":
            if !summary.isEmpty {
                let display = summary.count > 30 ? String(summary.prefix(27)) + "..." : summary
                return "Ran `\(display)`"
            }
            return "Ran a command"
        case "read file":
            if let f = fileName { return "Read \(f)" }
            return "Read a file"
        case "write file":
            if let f = fileName { return "Wrote \(f)" }
            return "Wrote a file"
        case "edit file":
            if let f = fileName { return "Edited \(f)" }
            return "Edited a file"
        case "search files":
            if !summary.isEmpty {
                let display = summary.count > 25 ? String(summary.prefix(22)) + "..." : summary
                return "Searched for '\(display)'"
            }
            return "Searched files"
        case "find files":
            if !summary.isEmpty {
                let display = summary.count > 25 ? String(summary.prefix(22)) + "..." : summary
                return "Searched for \(display)"
            }
            return "Found files"
        case "web search":
            if !summary.isEmpty {
                let display = summary.count > 25 ? String(summary.prefix(22)) + "..." : summary
                return "Searched '\(display)'"
            }
            return "Searched the web"
        case "fetch url":              return "Fetched a webpage"
        case "browser navigate":       return "Opened a page"
        case "browser click":          return "Clicked on the page"
        case "browser screenshot":     return "Took a screenshot"
        case "request system permission":
            return "\(Self.permissionFriendlyName(from: summary)) granted"
        default:                       return "Used \(toolName)"
        }
    }

    /// Plural past-tense labels for multiple tool calls of the same type.
    private static func friendlyToolLabelPlural(_ toolName: String, count: Int) -> String {
        switch toolName.lowercased() {
        case "run command":        return "Ran \(count) commands"
        case "read file":          return "Read \(count) files"
        case "write file":         return "Wrote \(count) files"
        case "edit file":          return "Edited \(count) files"
        case "search files":       return "Ran \(count) searches"
        case "find files":         return "Ran \(count) searches"
        case "web search":         return "Searched the web \(count) times"
        case "fetch url":          return "Fetched \(count) webpages"
        case "browser navigate":   return "Opened \(count) pages"
        case "browser click":      return "Clicked \(count) times"
        case "browser screenshot":  return "Took \(count) screenshots"
        default:                   return "Used \(toolName) \(count) times"
        }
    }

    /// Maps tool names to user-friendly present-tense labels for the running state.
    private static func friendlyRunningLabel(_ toolName: String, inputSummary: String? = nil, buildingStatus: String? = nil) -> String {
        // For app file tools, prefer the descriptive building status from tool input
        if let status = buildingStatus {
            if toolName == "app_file_edit" || toolName == "app_file_write" || toolName == "app_create" || toolName == "app_update" {
                return status
            }
        }
        switch toolName {
        case "bash", "host_bash":               return "Running a command"
        case "file_read", "host_file_read":     return "Reading a file"
        case "file_write", "host_file_write":   return "Writing a file"
        case "file_edit", "host_file_edit":     return "Editing a file"
        case "grep":                            return "Searching files"
        case "glob":                            return "Finding files"
        case "web_search":                      return "Searching the web"
        case "web_fetch":                       return "Fetching a webpage"
        case "browser_navigate":                return "Opening a page"
        case "browser_click":                   return "Clicking on the page"
        case "browser_screenshot":              return "Taking a screenshot"
        case "app_create":                      return "Building your app"
        case "app_update":                      return "Updating your app"
        case "skill_load":
            if let name = inputSummary, !name.isEmpty {
                let display = name.replacingOccurrences(of: "-", with: " ").replacingOccurrences(of: "_", with: " ")
                return "Loading \(display)"
            }
            return "Loading a skill"
        default:
            // Convert raw snake_case name to a readable fallback
            let display = toolName.replacingOccurrences(of: "_", with: " ")
            return "Running \(display)"
        }
    }

    /// Progressive labels for long-running tools. Cycles through these over time.
    private static func progressiveLabels(for toolName: String) -> [String] {
        switch toolName {
        case "app_create":
            return [
                "Choosing a visual direction",
                "Designing the layout",
                "Writing the interface",
                "Adding styles and colors",
                "Wiring up interactions",
                "Polishing the details",
                "Almost there",
            ]
        case "app_update":
            return [
                "Reviewing your app",
                "Applying changes",
                "Updating the interface",
                "Polishing the details",
            ]
        default:
            return []
        }
    }

    /// Icon for a tool category.
    private static func friendlyToolIcon(_ toolName: String) -> String {
        switch toolName {
        case "bash", "host_bash":                               return "terminal"
        case "file_read", "host_file_read":                     return "doc.text"
        case "file_write", "host_file_write":                   return "doc.badge.plus"
        case "file_edit", "host_file_edit":                     return "pencil"
        case "grep", "glob", "web_search":                      return "magnifyingglass"
        case "web_fetch":                                       return "globe"
        case "browser_navigate", "browser_click":               return "safari"
        case "browser_screenshot":                              return "camera"
        case "request_system_permission":                       return "lock.shield"
        default:                                                return "gearshape"
        }
    }

    /// Convert raw permission_type (e.g. "full_disk_access") to a user-facing label.
    private static func permissionFriendlyName(from rawType: String) -> String {
        switch rawType {
        case "full_disk_access": return "Full Disk Access"
        case "accessibility": return "Accessibility"
        case "screen_recording": return "Screen Recording"
        case "calendar": return "Calendar"
        case "contacts": return "Contacts"
        case "photos": return "Photos"
        case "location": return "Location Services"
        case "microphone": return "Microphone"
        case "camera": return "Camera"
        default:
            if rawType.isEmpty { return "Permission" }
            return rawType.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    /// Failed/denied tool chip — shown when the user denied permission.
    private var compactFailedToolChip: some View {
        let uniqueNames = Array(Set(message.toolCalls.map(\.toolName))).sorted()
        let primary = uniqueNames.first ?? "Tool"
        let label = Self.friendlyRunningLabel(primary) + " failed"

        return HStack(spacing: VSpacing.xs) {
            Image(systemName: "xmark.circle.fill")
                .font(.system(size: 12))
                .foregroundColor(VColor.error)

            Text(label)
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
        }
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.xs)
        .background(
            Capsule().fill(VColor.surface)
        )
        .overlay(
            Capsule().stroke(VColor.surfaceBorder, lineWidth: 0.5)
        )
    }

    private func compactPermissionChip(_ confirmation: ToolConfirmationData) -> some View {
        let isApproved = confirmation.state == .approved
        return HStack(spacing: VSpacing.xs) {
            Group {
                switch confirmation.state {
                case .approved:
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(VColor.success)
                case .denied:
                    Image(systemName: "xmark.circle.fill")
                        .foregroundColor(VColor.error)
                case .timedOut:
                    Image(systemName: "clock.fill")
                        .foregroundColor(VColor.textMuted)
                default:
                    EmptyView()
                }
            }
            .font(.system(size: 12))

            Text(isApproved ? "\(confirmation.toolCategory) allowed" :
                 confirmation.state == .denied ? "\(confirmation.toolCategory) denied" : "Timed out")
                .font(VFont.caption)
                .foregroundColor(isApproved ? VColor.success : VColor.textSecondary)
        }
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.xs)
        .background(
            Capsule().fill(isApproved ? VColor.success.opacity(0.1) : VColor.surface)
        )
        .overlay(
            Capsule().stroke(isApproved ? VColor.success.opacity(0.3) : VColor.surfaceBorder, lineWidth: 0.5)
        )
    }

    /// Whether this message has meaningful interleaved content (multiple block types).
    private var hasInterleavedContent: Bool {
        // Use interleaved path when contentOrder has more than one distinct block type
        guard message.contentOrder.count > 1 else { return false }
        var hasText = false
        var hasNonText = false
        for ref in message.contentOrder {
            switch ref {
            case .text: hasText = true
            case .toolCall, .surface: hasNonText = true
            }
            if hasText && hasNonText { return true }
        }
        return false
    }

    /// Groups consecutive tool call refs for rendering.
    private enum ContentGroup {
        case text(Int)
        case toolCalls([Int])
        case surface(Int)
    }

    private func groupContentBlocks() -> [ContentGroup] {
        var groups: [ContentGroup] = []
        for ref in message.contentOrder {
            switch ref {
            case .text(let i):
                groups.append(.text(i))
            case .toolCall(let i):
                if case .toolCalls(let indices) = groups.last {
                    groups[groups.count - 1] = .toolCalls(indices + [i])
                } else {
                    groups.append(.toolCalls([i]))
                }
            case .surface(let i):
                groups.append(.surface(i))
            }
        }
        return groups
    }

    @ViewBuilder
    private var interleavedContent: some View {
        let groups = groupContentBlocks()

        // Render all content groups in order: text, tool calls, and surfaces
        ForEach(Array(groups.enumerated()), id: \.offset) { _, group in
            switch group {
            case .text(let i):
                if i < message.textSegments.count {
                    let segmentText = message.textSegments[i].trimmingCharacters(in: .whitespacesAndNewlines)
                    if !segmentText.isEmpty {
                        textBubble(for: segmentText)
                    }
                }
            case .toolCalls:
                // Tool calls are rendered by trailingStatus below the message
                EmptyView()
            case .surface(let i):
                if i < message.inlineSurfaces.count {
                    InlineSurfaceRouter(surface: message.inlineSurfaces[i], onAction: onSurfaceAction)
                }
            }
        }

        // Attachments are not part of contentOrder but must still be rendered
        let partitioned = partitionedAttachments
        if !partitioned.images.isEmpty {
            attachmentImageGrid(partitioned.images)
        }
        if !partitioned.videos.isEmpty {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                ForEach(partitioned.videos) { attachment in
                    InlineVideoAttachmentView(attachment: attachment, daemonHttpPort: daemonHttpPort)
                }
            }
        }
        if !partitioned.files.isEmpty {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                ForEach(partitioned.files) { attachment in
                    fileAttachmentChip(attachment)
                }
            }
        }
    }

    /// Render a single text segment as a styled bubble, with table and image support.
    @ViewBuilder
    private func textBubble(for segmentText: String) -> some View {
        let segments = Self.cachedSegments(for: segmentText)
        let hasRichContent = segments.contains(where: {
            switch $0 {
            case .table, .image, .heading, .codeBlock, .horizontalRule, .list: return true
            case .text: return false
            }
        })

        if hasRichContent {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                    switch segment {
                    case .text(let text):
                        let options = AttributedString.MarkdownParsingOptions(
                            interpretedSyntax: .inlineOnlyPreservingWhitespace
                        )
                        let attributed = (try? AttributedString(markdown: text, options: options))
                            ?? AttributedString(text)
                        Text(attributed)
                            .font(.system(size: 13))
                            .foregroundColor(VColor.textPrimary)
                            .tint(VColor.accent)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: 520, alignment: .leading)
                    case .table(let headers, let rows):
                        MarkdownTableView(headers: headers, rows: rows)
                    case .image(let alt, let url):
                        AnimatedImageView(urlString: url)
                            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                            .accessibilityLabel(alt.isEmpty ? "Image" : alt)

                    case .heading(let level, let headingText):
                        let font: Font = switch level {
                        case 1: .system(size: 20, weight: .bold)
                        case 2: .system(size: 17, weight: .semibold)
                        case 3: .system(size: 14, weight: .semibold)
                        default: .system(size: 13, weight: .semibold)
                        }
                        Text(headingText)
                            .font(font)
                            .foregroundColor(VColor.textPrimary)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: 520, alignment: .leading)
                            .padding(.top, level == 1 ? VSpacing.xs : 0)

                    case .codeBlock(let language, let code):
                        VStack(alignment: .leading, spacing: 0) {
                            if let language, !language.isEmpty {
                                Text(language)
                                    .font(.system(size: 11, weight: .medium))
                                    .foregroundColor(VColor.textMuted)
                                    .padding(.horizontal, VSpacing.sm)
                                    .padding(.top, VSpacing.xs)
                            }
                            ScrollView(.horizontal, showsIndicators: false) {
                                Text(code)
                                    .font(VFont.mono)
                                    .foregroundColor(VColor.textPrimary)
                                    .textSelection(.enabled)
                                    .fixedSize(horizontal: true, vertical: true)
                                    .padding(VSpacing.sm)
                            }
                        }
                        .frame(maxWidth: 520, alignment: .leading)
                        .background(VColor.backgroundSubtle)
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))

                    case .horizontalRule:
                        Rectangle()
                            .fill(VColor.surfaceBorder)
                            .frame(height: 1)
                            .frame(maxWidth: 520)
                            .padding(.vertical, VSpacing.xs)

                    case .list(let items):
                        VStack(alignment: .leading, spacing: VSpacing.xxs) {
                            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                                let prefix = item.ordered ? "\(item.number). " : "\u{2022} "
                                let indentLevel = item.indent / 2
                                HStack(alignment: .top, spacing: 0) {
                                    Text(prefix)
                                        .font(.system(size: 13))
                                        .foregroundColor(VColor.textSecondary)
                                    let options = AttributedString.MarkdownParsingOptions(
                                        interpretedSyntax: .inlineOnlyPreservingWhitespace
                                    )
                                    let attributed = (try? AttributedString(markdown: item.text, options: options))
                                        ?? AttributedString(item.text)
                                    Text(attributed)
                                        .font(.system(size: 13))
                                        .foregroundColor(VColor.textPrimary)
                                        .tint(VColor.accent)
                                        .textSelection(.enabled)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                                .padding(.leading, CGFloat(indentLevel) * 16)
                            }
                        }
                        .frame(maxWidth: 520, alignment: .leading)
                    }
                }
            }
        } else {
            let options = AttributedString.MarkdownParsingOptions(
                interpretedSyntax: .inlineOnlyPreservingWhitespace
            )
            let attributed = (try? AttributedString(markdown: segmentText, options: options))
                ?? AttributedString(segmentText)
            Text(attributed)
                .font(.system(size: 13))
                .foregroundColor(VColor.textPrimary)
                .tint(VColor.accent)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: 520, alignment: .leading)
        }
    }

    /// Current step indicator rendered outside the bubble.
    /// Shows only when there are actual tool calls.
    // Tool call status is rendered via trailingStatus at the bottom of the message.

    private var hasText: Bool {
        !message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var attachmentSummary: String {
        let count = message.attachments.count
        if count == 1 {
            return "Sent \(message.attachments[0].filename)"
        }
        return "Sent \(count) attachments"
    }

    /// Partitions attachments into decoded images, videos, and non-media files in a single pass,
    /// avoiding redundant base64 decoding and NSImage construction across render calls.
    private var partitionedAttachments: (images: [(ChatAttachment, NSImage)], videos: [ChatAttachment], files: [ChatAttachment]) {
        var images: [(ChatAttachment, NSImage)] = []
        var videos: [ChatAttachment] = []
        var files: [ChatAttachment] = []
        for attachment in message.attachments {
            if attachment.mimeType.hasPrefix("image/"), let img = nsImage(for: attachment) {
                images.append((attachment, img))
            } else if attachment.mimeType.hasPrefix("video/") {
                videos.append(attachment)
            } else {
                files.append(attachment)
            }
        }
        return (images, videos, files)
    }

    private var bubbleContent: some View {
        let partitioned = partitionedAttachments
        return VStack(alignment: .leading, spacing: VSpacing.sm) {
            if let skillInvocation = message.skillInvocation {
                SkillInvocationChip(data: skillInvocation)
            }

            if message.isError && hasText {
                HStack(alignment: .top, spacing: VSpacing.sm) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(VColor.error)
                        .padding(.top, 1)
                    Text(message.text)
                        .font(.system(size: 13))
                        .foregroundColor(VColor.textPrimary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else if hasText {
                let segments = Self.cachedSegments(for: message.text)
                let hasRichContent = segments.contains(where: {
                    switch $0 {
                    case .table, .image, .heading, .codeBlock, .horizontalRule, .list: return true
                    case .text: return false
                    }
                })
                VStack(alignment: .leading, spacing: hasRichContent ? VSpacing.lg : VSpacing.xs) {

                    if hasRichContent {
                        ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                            switch segment {
                            case .text(let text):
                                let options = AttributedString.MarkdownParsingOptions(
                                    interpretedSyntax: .inlineOnlyPreservingWhitespace
                                )
                                let attributed = (try? AttributedString(markdown: text, options: options))
                                    ?? AttributedString(text)
                                Text(attributed)
                                    .font(.system(size: 13))
                                    .foregroundColor(isUser ? VColor.userBubbleText : VColor.textPrimary)
                                    .tint(isUser ? VColor.userBubbleText : VColor.accent)
                                    .textSelection(.enabled)
                                    .fixedSize(horizontal: false, vertical: true)
                            case .table(let headers, let rows):
                                MarkdownTableView(headers: headers, rows: rows)
                            case .image(let alt, let url):
                                AnimatedImageView(urlString: url)
                                    .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                                    .accessibilityLabel(alt.isEmpty ? "Image" : alt)
                            case .heading(let level, let headingText):
                                let font: Font = switch level {
                                case 1: .system(size: 20, weight: .bold)
                                case 2: .system(size: 17, weight: .semibold)
                                case 3: .system(size: 14, weight: .semibold)
                                default: .system(size: 13, weight: .semibold)
                                }
                                Text(headingText)
                                    .font(font)
                                    .foregroundColor(isUser ? VColor.userBubbleText : VColor.textPrimary)
                                    .textSelection(.enabled)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .padding(.top, level == 1 ? VSpacing.xs : 0)

                            case .codeBlock(let language, let code):
                                VStack(alignment: .leading, spacing: 0) {
                                    if let language, !language.isEmpty {
                                        Text(language)
                                            .font(.system(size: 11, weight: .medium))
                                            .foregroundColor(isUser ? VColor.userBubbleTextSecondary : VColor.textMuted)
                                            .padding(.horizontal, VSpacing.sm)
                                            .padding(.top, VSpacing.xs)
                                    }
                                    ScrollView(.horizontal, showsIndicators: false) {
                                        Text(code)
                                            .font(VFont.mono)
                                            .foregroundColor(isUser ? VColor.userBubbleText : VColor.textPrimary)
                                            .textSelection(.enabled)
                                            .fixedSize(horizontal: true, vertical: true)
                                            .padding(VSpacing.sm)
                                    }
                                }
                                .background(isUser ? VColor.userBubbleText.opacity(0.1) : VColor.backgroundSubtle)
                                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))

                            case .horizontalRule:
                                Rectangle()
                                    .fill(isUser ? VColor.userBubbleText.opacity(0.3) : VColor.surfaceBorder)
                                    .frame(height: 1)
                                    .padding(.vertical, VSpacing.xs)

                            case .list(let items):
                                VStack(alignment: .leading, spacing: VSpacing.xxs) {
                                    ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                                        let prefix = item.ordered ? "\(item.number). " : "\u{2022} "
                                        let indentLevel = item.indent / 2
                                        HStack(alignment: .top, spacing: 0) {
                                            Text(prefix)
                                                .font(.system(size: 13))
                                                .foregroundColor(isUser ? VColor.userBubbleTextSecondary : VColor.textSecondary)
                                            let options = AttributedString.MarkdownParsingOptions(
                                                interpretedSyntax: .inlineOnlyPreservingWhitespace
                                            )
                                            let attributed = (try? AttributedString(markdown: item.text, options: options))
                                                ?? AttributedString(item.text)
                                            Text(attributed)
                                                .font(.system(size: 13))
                                                .foregroundColor(isUser ? VColor.userBubbleText : VColor.textPrimary)
                                                .tint(isUser ? VColor.userBubbleText : VColor.accent)
                                                .textSelection(.enabled)
                                                .fixedSize(horizontal: false, vertical: true)
                                        }
                                        .padding(.leading, CGFloat(indentLevel) * 16)
                                    }
                                }
                            }
                        }
                    } else {
                        Text(markdownText)
                            .font(.system(size: 13))
                            .foregroundColor(isUser ? VColor.userBubbleText : VColor.textPrimary)
                            .tint(isUser ? VColor.userBubbleText : VColor.accent)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            } else if !message.attachments.isEmpty {
                Text(attachmentSummary)
                    .font(VFont.caption)
                    .foregroundColor(isUser ? VColor.userBubbleTextSecondary : VColor.textSecondary)
            }

            if !partitioned.images.isEmpty {
                attachmentImageGrid(partitioned.images)
            }

            if !partitioned.videos.isEmpty {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    ForEach(partitioned.videos) { attachment in
                        InlineVideoAttachmentView(attachment: attachment, daemonHttpPort: daemonHttpPort)
                    }
                }
            }

            if !partitioned.files.isEmpty {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    ForEach(partitioned.files) { attachment in
                        fileAttachmentChip(attachment)
                    }
                }
            }

            // User messages keep tool calls inside the bubble
            if isUser && !message.toolCalls.isEmpty {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    ForEach(message.toolCalls) { toolCall in
                        ToolCallChip(toolCall: toolCall)
                    }
                }
            }
        }
        .padding(.horizontal, isUser || message.isError ? VSpacing.lg : 0)
        .padding(.vertical, isUser || message.isError ? VSpacing.md : 0)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .fill(bubbleFill)
        )
        .overlay(
            message.isError
                ? RoundedRectangle(cornerRadius: VRadius.lg)
                    .strokeBorder(VColor.error.opacity(0.3), lineWidth: 1)
                : nil
        )
        .frame(maxWidth: 520, alignment: isUser ? .trailing : .leading)
    }

    @ViewBuilder
    private func documentWidget(for toolCall: ToolCallData) -> some View {
        let parsed = DocumentResultParser.parse(from: toolCall)

        if let surfaceId = parsed.surfaceId, !dismissedDocumentSurfaceIds.contains(surfaceId) {
            DocumentReopenWidget(
                documentTitle: parsed.title,
                onReopen: {
                    NotificationCenter.default.post(
                        name: .openDocumentEditor,
                        object: nil,
                        userInfo: ["documentSurfaceId": surfaceId]
                    )
                },
                onDismiss: {
                    onDismissDocumentWidget(surfaceId)
                }
            )
            .padding(.top, VSpacing.sm)
        }
    }

    private func attachmentImageGrid(_ images: [(ChatAttachment, NSImage)]) -> some View {
        HStack(alignment: .top, spacing: VSpacing.sm) {
            ForEach(images, id: \.0.id) { attachment, nsImage in
                Image(nsImage: nsImage)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(maxWidth: 280)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                    .onTapGesture {
                        openImageInPreview(attachment)
                    }
            }
        }
    }

    private func fileAttachmentChip(_ attachment: ChatAttachment) -> some View {
        HStack(spacing: VSpacing.xs) {
            Image(systemName: fileIcon(for: attachment.mimeType))
                .font(VFont.caption)
                .foregroundColor(isUser ? VColor.userBubbleTextSecondary : VColor.textSecondary)

            Text(attachment.filename)
                .font(VFont.caption)
                .foregroundColor(isUser ? VColor.userBubbleText : VColor.textPrimary)
                .lineLimit(1)

            Text(formattedFileSize(base64Length: attachment.dataLength))
                .font(VFont.small)
                .foregroundColor(isUser ? VColor.userBubbleTextSecondary : VColor.textMuted)
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.xs)
        .background(
            RoundedRectangle(cornerRadius: VRadius.sm)
                .fill(isUser ? VColor.userBubbleText.opacity(0.15) : VColor.surfaceBorder.opacity(0.5))
        )
    }

    private func nsImage(for attachment: ChatAttachment) -> NSImage? {
        // Use pre-decoded thumbnail image — avoids NSImage(data:) during layout, which
        // can trigger re-entrant AppKit constraint invalidation and crash on scroll.
        if let img = attachment.thumbnailImage {
            return img
        }
        if let thumbnailData = attachment.thumbnailData, let img = NSImage(data: thumbnailData) {
            return img
        }
        if let data = Data(base64Encoded: attachment.data), let img = NSImage(data: data) {
            return img
        }
        return nil
    }

    private func openImageInPreview(_ attachment: ChatAttachment) {
        guard let data = Data(base64Encoded: attachment.data) else { return }
        let tempDir = FileManager.default.temporaryDirectory
        let sanitized = (attachment.filename as NSString).lastPathComponent
        let fileURL = tempDir.appendingPathComponent(sanitized.isEmpty ? "image" : sanitized)
        do {
            try data.write(to: fileURL)
            NSWorkspace.shared.open(fileURL)
        } catch {
            // Silently fail — not critical
        }
    }

    private func fileIcon(for mimeType: String) -> String {
        if mimeType.hasPrefix("video/") { return "film" }
        if mimeType.hasPrefix("audio/") { return "waveform" }
        if mimeType.hasPrefix("text/") { return "doc.text.fill" }
        if mimeType == "application/pdf" { return "doc.fill" }
        if mimeType.contains("zip") || mimeType.contains("archive") { return "doc.zipper" }
        if mimeType.contains("json") || mimeType.contains("xml") { return "doc.text.fill" }
        return "doc.fill"
    }

    private func formattedFileSize(base64Length: Int) -> String {
        let bytes = base64Length * 3 / 4
        if bytes < 1024 { return "\(bytes) B" }
        let kb = Double(bytes) / 1024
        if kb < 1024 { return String(format: "%.1f KB", kb) }
        let mb = kb / 1024
        return String(format: "%.1f MB", mb)
    }

    /// Cached markdown segment parser to avoid re-parsing on every render.
    private static var segmentCache = [Int: [MarkdownSegment]]()

    private static func cachedSegments(for text: String) -> [MarkdownSegment] {
        let key = text.hashValue
        if let cached = segmentCache[key] { return cached }
        let result = parseMarkdownSegments(text)
        if segmentCache.count >= maxCacheSize {
            if let first = segmentCache.keys.first { segmentCache.removeValue(forKey: first) }
        }
        segmentCache[key] = result
        return result
    }

    /// Cached markdown parser to avoid re-parsing on every render.
    /// Uses the message text hash as the cache key.
    private static var markdownCache = [Int: AttributedString]()
    private static let maxCacheSize = 100

    private var markdownText: AttributedString {
        let textToRender = message.text
        let trimmed = textToRender.trimmingCharacters(in: .whitespacesAndNewlines)
        let cacheKey = trimmed.hashValue

        // Return cached value if available
        if let cached = Self.markdownCache[cacheKey] {
            return cached
        }

        // Parse markdown
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        var parsed = (try? AttributedString(markdown: trimmed, options: options))
            ?? AttributedString(trimmed)

        // Highlight slash command token (e.g. /model) in blue
        if let slashMatch = trimmed.range(of: #"^/\w+"#, options: .regularExpression) {
            let offset = trimmed.distance(from: trimmed.startIndex, to: slashMatch.lowerBound)
            let length = trimmed.distance(from: slashMatch.lowerBound, to: slashMatch.upperBound)
            let attrStart = parsed.index(parsed.startIndex, offsetByCharacters: offset)
            let attrEnd = parsed.index(attrStart, offsetByCharacters: length)
            parsed[attrStart..<attrEnd].foregroundColor = adaptiveColor(light: Sage._500, dark: Sage._300)
        }

        // Store in cache (with size limit to prevent unbounded growth)
        if Self.markdownCache.count >= Self.maxCacheSize {
            // Simple FIFO eviction - remove first entry
            if let firstKey = Self.markdownCache.keys.first {
                Self.markdownCache.removeValue(forKey: firstKey)
            }
        }
        Self.markdownCache[cacheKey] = parsed

        return parsed
    }

}

// MARK: - Markdown Table Support

/// A segment of message content — either plain text or a parsed table.
private struct ListItem {
    let indent: Int
    let ordered: Bool
    let number: Int      // meaningful only when ordered == true
    let text: String
}

private enum MarkdownSegment {
    case text(String)
    case table(headers: [String], rows: [[String]])
    case image(alt: String, url: String)
    case heading(level: Int, text: String)
    case codeBlock(language: String?, code: String)
    case horizontalRule
    case list(items: [ListItem])
}

/// Returns true if `line` is a markdown heading (1–6 `#` chars followed by a space).
private func isHeadingLine(_ line: String) -> (level: Int, text: String)? {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    let hashes = trimmed.prefix(while: { $0 == "#" })
    let level = hashes.count
    guard level >= 1, level <= 6 else { return nil }
    let rest = trimmed.dropFirst(level)
    guard rest.first == " " else { return nil }
    return (level, String(rest.dropFirst()).trimmingCharacters(in: .whitespaces))
}

/// Returns true if `line` is a horizontal rule (`---`, `***`, or `___` with 3+ chars).
private func isHorizontalRule(_ line: String) -> Bool {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    let stripped = trimmed.filter { !$0.isWhitespace }
    guard stripped.count >= 3 else { return false }
    guard let ch = stripped.first, (ch == "-" || ch == "*" || ch == "_") else { return false }
    return stripped.allSatisfy { $0 == ch }
}

/// Returns a `ListItem` if the line looks like a list entry, otherwise nil.
private func parseListLine(_ line: String) -> ListItem? {
    // Measure indent (count leading spaces, tabs count as 4)
    var indent = 0
    for ch in line {
        if ch == " " { indent += 1 }
        else if ch == "\t" { indent += 4 }
        else { break }
    }
    let trimmed = line.trimmingCharacters(in: .whitespaces)

    // Unordered: `- `, `* `, `+ `
    if (trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") || trimmed.hasPrefix("+ ")) {
        return ListItem(indent: indent, ordered: false, number: 0, text: String(trimmed.dropFirst(2)))
    }
    // Ordered: `1. `, `2. `, etc.
    let digits = trimmed.prefix(while: { $0.isNumber })
    if !digits.isEmpty {
        let rest = trimmed.dropFirst(digits.count)
        if rest.hasPrefix(". ") {
            return ListItem(indent: indent, ordered: true, number: Int(digits) ?? 1,
                            text: String(rest.dropFirst(2)))
        }
    }
    return nil
}

/// Parses message text into segments, extracting markdown tables, code blocks, headings, lists, and rules.
private func parseMarkdownSegments(_ text: String) -> [MarkdownSegment] {
    let lines = text.components(separatedBy: .newlines)
    var segments: [MarkdownSegment] = []
    var currentText: [String] = []
    var i = 0
    var fenceDelimiter: (character: Character, length: Int)? = nil
    var codeBlockLanguage: String? = nil
    var codeBlockLines: [String] = []

    func flushText() {
        let pending = currentText.joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if !pending.isEmpty {
            segments.append(.text(pending))
        }
        currentText = []
    }

    while i < lines.count {
        let trimmed = lines[i].trimmingCharacters(in: .whitespaces)

        // --- Inside a fenced code block ---
        if let fence = fenceDelimiter {
            let closeCount = trimmed.prefix(while: { $0 == fence.character }).count
            if closeCount >= fence.length && trimmed.drop(while: { $0 == fence.character }).allSatisfy(\.isWhitespace) {
                // Closing fence — emit code block
                fenceDelimiter = nil
                segments.append(.codeBlock(language: codeBlockLanguage, code: codeBlockLines.joined(separator: "\n")))
                codeBlockLines = []
                codeBlockLanguage = nil
            } else {
                codeBlockLines.append(lines[i])
            }
            i += 1
            continue
        }

        // --- Opening a new fence ---
        if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
            flushText()
            let fenceChar = trimmed.first!
            let fenceLen = trimmed.prefix(while: { $0 == fenceChar }).count
            fenceDelimiter = (fenceChar, fenceLen)
            let lang = trimmed.dropFirst(fenceLen).trimmingCharacters(in: .whitespaces)
            codeBlockLanguage = lang.isEmpty ? nil : lang
            i += 1
            continue
        }

        // --- Table detection ---
        if i + 2 < lines.count,
           isTableRow(lines[i]),
           isTableSeparator(lines[i + 1]),
           isTableRow(lines[i + 2]) {
            flushText()
            let headers = parseTableCells(lines[i])
            i += 2  // skip separator
            var rows: [[String]] = []
            while i < lines.count, isTableRow(lines[i]) {
                let cells = parseTableCells(lines[i])
                let padded = Array(cells.prefix(headers.count))
                    + Array(repeating: "", count: max(0, headers.count - cells.count))
                rows.append(padded)
                i += 1
            }
            segments.append(.table(headers: headers, rows: rows))
            continue
        }

        // --- Heading detection ---
        if let heading = isHeadingLine(lines[i]) {
            flushText()
            segments.append(.heading(level: heading.level, text: heading.text))
            i += 1
            continue
        }

        // --- Horizontal rule detection ---
        if isHorizontalRule(trimmed) {
            flushText()
            segments.append(.horizontalRule)
            i += 1
            continue
        }

        // --- List detection (consecutive list lines) ---
        if parseListLine(lines[i]) != nil {
            flushText()
            var items: [ListItem] = []
            while i < lines.count, let item = parseListLine(lines[i]) {
                items.append(item)
                i += 1
            }
            segments.append(.list(items: items))
            continue
        }

        // --- Plain text ---
        currentText.append(lines[i])
        i += 1
    }

    // If a fence was never closed, emit accumulated code block lines as text
    if fenceDelimiter != nil {
        let fenceChar = fenceDelimiter!.character
        let fenceLen = fenceDelimiter!.length
        let opener = String(repeating: String(fenceChar), count: fenceLen) + (codeBlockLanguage ?? "")
        currentText.append(opener)
        currentText.append(contentsOf: codeBlockLines)
    }

    flushText()

    // Post-process .text segments to extract inline images.
    return segments.flatMap { segment -> [MarkdownSegment] in
        if case .text(let content) = segment {
            return extractImageSegments(from: content)
        }
        return [segment]
    }
}

/// Splits text around `![alt](url)` matches, returning mixed `.text` / `.image` segments.
private func extractImageSegments(from text: String) -> [MarkdownSegment] {
    let pattern = #"!\[([^\]]*)\]\(([^)]+)\)"#
    guard let regex = try? NSRegularExpression(pattern: pattern) else {
        return [.text(text)]
    }

    let nsText = text as NSString
    let matches = regex.matches(in: text, range: NSRange(location: 0, length: nsText.length))

    if matches.isEmpty { return [.text(text)] }

    var segments: [MarkdownSegment] = []
    var lastEnd = 0

    for match in matches {
        // Text before the image
        if match.range.location > lastEnd {
            let before = nsText.substring(with: NSRange(location: lastEnd, length: match.range.location - lastEnd))
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !before.isEmpty {
                segments.append(.text(before))
            }
        }

        let alt = nsText.substring(with: match.range(at: 1))
        let url = nsText.substring(with: match.range(at: 2))
        segments.append(.image(alt: alt, url: url))

        lastEnd = match.range.location + match.range.length
    }

    // Text after the last image
    if lastEnd < nsText.length {
        let after = nsText.substring(from: lastEnd)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if !after.isEmpty {
            segments.append(.text(after))
        }
    }

    return segments
}

private func isTableRow(_ line: String) -> Bool {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    return trimmed.hasPrefix("|") && trimmed.hasSuffix("|")
        && trimmed.filter({ $0 == "|" }).count >= 2
}

private func isTableSeparator(_ line: String) -> Bool {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    guard trimmed.hasPrefix("|") && trimmed.hasSuffix("|") else { return false }
    let inner = trimmed.dropFirst().dropLast()
    // Each cell should be dashes (with optional colons for alignment)
    return inner.split(separator: "|").allSatisfy { cell in
        let c = cell.trimmingCharacters(in: .whitespaces)
        return !c.isEmpty && c.allSatisfy({ $0 == "-" || $0 == ":" })
    }
}

private func parseTableCells(_ line: String) -> [String] {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    let inner = String(trimmed.dropFirst().dropLast())  // strip outer pipes
    return inner.components(separatedBy: "|")
        .map { $0.trimmingCharacters(in: .whitespaces) }
}

/// Renders a parsed markdown table.
private struct MarkdownTableView: View {
    let headers: [String]
    let rows: [[String]]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header row
            HStack(spacing: 0) {
                ForEach(Array(headers.enumerated()), id: \.offset) { _, header in
                    Text(header)
                        .font(VFont.captionMedium)
                        .foregroundColor(VColor.textSecondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.xs)
                }
            }
            .background(VColor.backgroundSubtle)

            Divider().background(VColor.surfaceBorder)

            // Data rows
            ForEach(Array(rows.enumerated()), id: \.offset) { rowIdx, row in
                HStack(spacing: 0) {
                    ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                        inlineMarkdownCell(cell)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, VSpacing.sm)
                            .padding(.vertical, VSpacing.xs)
                    }
                }
                .background(rowIdx % 2 == 1 ? VColor.backgroundSubtle.opacity(0.5) : Color.clear)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.sm)
                .stroke(VColor.surfaceBorder, lineWidth: 0.5)
        )
        .frame(maxWidth: 520, alignment: .leading)
    }

    private func inlineMarkdownCell(_ text: String) -> some View {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        let attributed = (try? AttributedString(markdown: text, options: options))
            ?? AttributedString(text)
        return Text(attributed)
            .font(VFont.caption)
            .foregroundColor(VColor.textPrimary)
    }
}

// MARK: - Running Indicator

/// Minimal in-progress indicator for thinking and tool execution.
/// Supports progressive labels that cycle on a timer for long-running tools.
private struct RunningIndicator: View {
    var label: String = "Running"
    /// Whether to show the terminal icon (appropriate for tool execution states).
    var showIcon: Bool = true
    /// Optional sequence of labels to cycle through over time.
    var progressiveLabels: [String] = []
    /// Seconds between each label transition.
    var labelInterval: TimeInterval = 6
    /// Optional tap handler — when set, the indicator becomes a clickable button.
    var onTap: (() -> Void)?

    @State private var phase: Int = 0
    @State private var timer: Timer?
    @State private var currentLabelIndex: Int = 0
    @State private var labelTimer: Timer?
    @State private var isHovered: Bool = false

    private var displayLabel: String {
        if progressiveLabels.isEmpty { return label }
        return progressiveLabels[min(currentLabelIndex, progressiveLabels.count - 1)]
    }

    var body: some View {
        if let onTap {
            Button(action: onTap) {
                indicatorContent
            }
            .buttonStyle(.plain)
            .onHover { hovering in
                isHovered = hovering
            }
        } else {
            indicatorContent
        }
    }

    private var indicatorContent: some View {
        HStack(spacing: VSpacing.xs) {
            if showIcon {
                Image(systemName: "terminal")
                    .font(.system(size: 10))
                    .foregroundColor(VColor.textSecondary)
            }

            Text(displayLabel)
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
                .animation(.easeInOut(duration: 0.3), value: currentLabelIndex)

            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .fill(VColor.textSecondary)
                    .frame(width: 5, height: 5)
                    .opacity(dotOpacity(for: index))
            }

            if onTap != nil {
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundColor(VColor.textMuted)
            }

            Spacer()
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.xs)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .fill(isHovered ? VColor.backgroundSubtle.opacity(0.6) : Color.clear)
        )
        .contentShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .onAppear {
            startDotAnimation()
            startLabelCycling()
        }
        .onDisappear {
            timer?.invalidate()
            labelTimer?.invalidate()
        }
    }

    private func dotOpacity(for index: Int) -> Double {
        phase == index ? 1.0 : 0.4
    }

    private func startDotAnimation() {
        timer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { _ in
            withAnimation(.easeInOut(duration: 0.3)) {
                phase = (phase + 1) % 3
            }
        }
    }

    private func startLabelCycling() {
        guard !progressiveLabels.isEmpty else { return }
        labelTimer = Timer.scheduledTimer(withTimeInterval: labelInterval, repeats: true) { _ in
            if currentLabelIndex < progressiveLabels.count - 1 {
                currentLabelIndex += 1
            }
        }
    }
}

private struct CodePreviewView: View {
    let code: String

    var body: some View {
        ScrollView {
            Text(displayCode)
                .font(VFont.monoSmall)
                .foregroundColor(VColor.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(VSpacing.sm)
        }
        .frame(maxHeight: 120)
        .background(VColor.background.opacity(0.6))
        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.sm)
                .stroke(VColor.surfaceBorder, lineWidth: 0.5)
        )
    }

    private var displayCode: String {
        let lines = code.components(separatedBy: "\n")
        if lines.count > 30 {
            return lines.suffix(30).joined(separator: "\n")
        }
        return code
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
                onAddTrustRule: { _, _, _, _ in true },
                onSurfaceAction: { _, _, _ in },
                onRegenerate: {},
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
