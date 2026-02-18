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
    let onOpenActivity: (UUID) -> Void
    let isActivityPanelOpen: Bool
    var onReportMessage: ((String?) -> Void)?
    var mediaEmbedSettings: MediaEmbedResolverSettings?
    var isTemporaryChat: Bool = false

    /// Triggers auto-scroll when the last message's text length changes (e.g. during streaming).
    private var streamingScrollTrigger: Int {
        let last = messages.last
        return (last?.text.count ?? 0) + (last?.toolCalls.count ?? 0) + (last?.inlineSurfaces.count ?? 0)
    }

    @State private var isDropTargeted = false
    @State private var editorContentHeight: CGFloat = 20
    @State private var isComposerExpanded = false
    @State private var emptyStateTitle: String = emptyStateTitles.randomElement()!
    @State private var emptyStatePlaceholder: String = placeholderTexts.randomElement()!
    @State private var emptyStateVisible = false
    @State private var identity: IdentityInfo? = IdentityInfo.load()
    private let appearance = AvatarAppearanceManager.shared
    @AppStorage("hasEverSentMessage") private var hasEverSentMessage: Bool = false

    private static let defaultGreetings = [
        "What are we working on?",
        "I'm here whenever you need me.",
        "What's on your mind?",
        "Let's make something happen.",
        "Ready when you are.",
    ]

    private static var emptyStateTitles: [String] {
        let custom = IdentityInfo.loadGreetings()
        return custom.isEmpty ? defaultGreetings : custom
    }

    private static let placeholderTexts = [
        "Ask me anything...",
        "Tell me what you need...",
        "Say the word...",
        "Go ahead, I'm listening...",
        "Type or hold Fn to talk...",
    ]

    private var isEmptyState: Bool {
        messages.isEmpty && !isThinking
    }

    private let composerMinHeight: CGFloat = 34

    var body: some View {
        ZStack {
            VStack(spacing: 0) {
                apiKeyBanner
                if isEmptyState {
                    if isTemporaryChat {
                        temporaryChatEmptyStateView
                    } else {
                        emptyStateView
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
        .onChange(of: messages.isEmpty) {
            if messages.isEmpty {
                emptyStateTitle = Self.emptyStateTitles.randomElement()!
                emptyStatePlaceholder = Self.placeholderTexts.randomElement()!
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

    private var emptyStateView: some View {
        VStack(spacing: 0) {
            Spacer()
            Spacer()

            DinoFaceView(seed: identity?.name ?? "default", palette: appearance.palette, outfit: appearance.outfit)
                .frame(width: 80, height: 80)
                .allowsHitTesting(false)
                .opacity(emptyStateVisible ? 1 : 0)
                .scaleEffect(emptyStateVisible ? 1 : 0.8)
                .padding(.bottom, VSpacing.lg)

            Text(emptyStateTitle)
                .font(.system(size: 28, weight: .medium))
                .foregroundColor(VColor.textSecondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 500)
                .opacity(emptyStateVisible ? 1 : 0)
                .offset(y: emptyStateVisible ? 0 : 8)
                .padding(.horizontal, VSpacing.xl)
                .padding(.bottom, VSpacing.xl)

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
                placeholderText: emptyStatePlaceholder,
                editorContentHeight: $editorContentHeight,
                isComposerExpanded: $isComposerExpanded
            )
            .opacity(emptyStateVisible ? 1 : 0)
            .offset(y: emptyStateVisible ? 0 : 10)

            Spacer()
            Spacer()
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(
            RadialGradient(
                gradient: Gradient(colors: [
                    VColor.accent.opacity(0.07),
                    VColor.accent.opacity(0.02),
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

    private var temporaryChatEmptyStateView: some View {
        VStack(spacing: 0) {
            Spacer()
            Spacer()

            DinoFaceView(seed: identity?.name ?? "default", palette: appearance.palette, outfit: appearance.outfit)
                .frame(width: 80, height: 80)
                .allowsHitTesting(false)
                .padding(.bottom, VSpacing.lg)

            Text("Temporary Chat")
                .font(.system(size: 28, weight: .medium))
                .foregroundColor(VColor.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.bottom, VSpacing.sm)

            Text("Memory is disabled for this chat, and it won\u{2019}t appear in your history.")
                .font(VFont.body)
                .foregroundColor(VColor.textMuted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 400)
                .padding(.horizontal, VSpacing.xl)
                .padding(.bottom, VSpacing.xxl)

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
                placeholderText: "Ask anything...",
                editorContentHeight: $editorContentHeight,
                isComposerExpanded: $isComposerExpanded
            )

            Spacer()
            Spacer()
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(
            RadialGradient(
                gradient: Gradient(colors: [
                    VColor.accent.opacity(0.07),
                    VColor.accent.opacity(0.02),
                    Color.clear,
                ]),
                center: .center,
                startRadius: 20,
                endRadius: 350
            )
            .offset(y: -40)
        )
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
        let error: CGFloat = sessionError != nil ? 60 : (errorText != nil ? 36 : 0)
        let queue: CGFloat = pendingQueuedCount > 0 ? 24 : 0
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

            if let sessionError {
                sessionErrorToast(sessionError)
            } else if let errorText {
                errorBanner(errorText)
            }
            queueSummary
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
        if let url = ResourceBundle.bundle.url(forResource: "background", withExtension: "png"),
           let nsImage = NSImage(contentsOf: url) {
            Image(nsImage: nsImage)
                .resizable()
                .scaledToFit()
                .opacity(colorScheme == .light ? 0 : 1.0)
                .allowsHitTesting(false)
        }
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

    private func shouldShowTimestamp(at index: Int) -> Bool {
        if index == 0 { return true }
        let current = messages[index].timestamp
        let previous = messages[index - 1].timestamp
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
                    ForEach(Array(messages.enumerated()), id: \.element.id) { index, message in
                        if shouldShowTimestamp(at: index) {
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
                                    return messages[index - 1].role == .assistant
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
                        } else {
                            // Hide tool call chips when the next message is a pending
                            // confirmation — the tool hasn't been approved yet.
                            let nextIsPendingConfirmation = index + 1 < messages.count
                                && messages[index + 1].confirmation?.state == .pending

                            // Pass decided confirmation from the next message so it
                            // renders as a compact chip at the bottom of this bubble.
                            let nextDecidedConfirmation: ToolConfirmationData? = {
                                guard index + 1 < messages.count,
                                      let conf = messages[index + 1].confirmation,
                                      conf.state != .pending else { return nil }
                                return conf
                            }()

                            let isLastAssistant = message.role == .assistant
                                && !message.isStreaming
                                && (index == messages.count - 1
                                    || (index == messages.count - 2
                                        && messages[messages.count - 1].confirmation != nil && messages[messages.count - 1].confirmation?.state != .pending))
                                && !isSending
                                && !isThinking

                            ChatBubble(
                                message: message,
                                hideToolCalls: nextIsPendingConfirmation,
                                decidedConfirmation: nextDecidedConfirmation,
                                showRegenerate: isLastAssistant,
                                onRegenerate: onRegenerate,
                                onSurfaceAction: onSurfaceAction,
                                onOpenActivity: onOpenActivity,
                                isActivityPanelOpen: isActivityPanelOpen,
                                onReportMessage: onReportMessage,
                                mediaEmbedSettings: mediaEmbedSettings
                            )
                                .id(message.id)
                                .transition(.opacity.combined(with: .move(edge: .bottom)))
                        }
                    }

                    if isThinking && !(messages.last?.isStreaming == true) {
                        RunningIndicator(
                            label: !hasEverSentMessage && messages.contains(where: { $0.role == .user }) ? "Waking up..." : "Thinking",
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
            .scrollDisabled(messages.isEmpty && !isThinking)
            .onAppear {
                // Scroll to bottom on initial load
                proxy.scrollTo("scroll-bottom-anchor", anchor: .bottom)
            }
            .onChange(of: isThinking) {
                if isThinking {
                    withAnimation(VAnimation.standard) {
                        proxy.scrollTo("scroll-bottom-anchor", anchor: .bottom)
                    }
                } else {
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
            .onChange(of: isActivityPanelOpen) {
                if !isActivityPanelOpen {
                    withAnimation(VAnimation.standard) {
                        proxy.scrollTo("scroll-bottom-anchor", anchor: .bottom)
                    }
                }
            }
        }
    }

    // MARK: - Error Banner

    private func errorBanner(_ text: String) -> some View {
        HStack(spacing: VSpacing.sm) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(VFont.caption)

            Text(text)
                .font(VFont.caption)
                .lineLimit(4)

            Spacer()

            if isSecretBlockError {
                Button(action: onSendAnyway) {
                    Text("Send Anyway")
                        .font(VFont.captionMedium)
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.xs)
                        .background(Color.white.opacity(0.2))
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Send message anyway")
            } else if isRetryableError {
                Button(action: onRetryError) {
                    Text("Retry")
                        .font(VFont.captionMedium)
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.xs)
                        .background(Color.white.opacity(0.2))
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Retry sending message")
            }

            Button {
                onDismissError()
            } label: {
                Image(systemName: "xmark")
                    .font(VFont.caption)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss error")
        }
        .foregroundColor(.white)
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
        .background(VColor.error)
    }

    // MARK: - Session Error Toast

    private func sessionErrorToast(_ error: SessionError) -> some View {
        HStack(spacing: VSpacing.sm) {
            Image(systemName: sessionErrorIcon(error.category))
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(sessionErrorAccent(error.category))

            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text(error.message)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textPrimary)
                    .lineLimit(2)

                Text(error.recoverySuggestion)
                    .font(VFont.small)
                    .foregroundColor(VColor.textSecondary)
                    .lineLimit(1)
            }

            Spacer()

            if error.isRetryable {
                Button(action: onRetry) {
                    Text(sessionErrorActionLabel(error.category))
                        .font(VFont.captionMedium)
                        .foregroundColor(.white)
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.xs)
                        .background(sessionErrorAccent(error.category))
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(sessionErrorActionLabel(error.category))
            }

            if error.debugDetails != nil {
                Button(action: onCopyDebugInfo) {
                    Image(systemName: "doc.on.clipboard")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(VColor.textSecondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Copy debug info")
            }

            Button {
                onDismissSessionError()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(VColor.textMuted)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss error")
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

    /// SF Symbol icon appropriate for each error category.
    private func sessionErrorIcon(_ category: SessionErrorCategory) -> String {
        switch category {
        case .providerNetwork:
            return "wifi.exclamationmark"
        case .rateLimit:
            return "clock.badge.exclamationmark"
        case .providerApi:
            return "exclamationmark.icloud.fill"
        case .contextTooLarge:
            return "text.badge.xmark"
        case .queueFull:
            return "tray.full.fill"
        case .sessionAborted:
            return "stop.circle.fill"
        case .processingFailed, .regenerateFailed:
            return "arrow.triangle.2.circlepath"
        case .unknown:
            return "exclamationmark.triangle.fill"
        }
    }

    /// Accent color for each error category -- warm for transient/retryable,
    /// red for hard failures.
    private func sessionErrorAccent(_ category: SessionErrorCategory) -> Color {
        switch category {
        case .rateLimit, .queueFull:
            return VColor.warning
        case .providerNetwork:
            return Amber._500
        case .sessionAborted:
            return VColor.textSecondary
        case .contextTooLarge:
            return VColor.warning
        default:
            return VColor.error
        }
    }

    /// Action button label tailored to the error category.
    private func sessionErrorActionLabel(_ category: SessionErrorCategory) -> String {
        switch category {
        case .rateLimit:
            return "Retry"
        case .regenerateFailed:
            return "Retry"
        case .providerNetwork:
            return "Retry"
        default:
            return "Retry"
        }
    }

    // MARK: - Queue Summary

    @ViewBuilder
    private var queueSummary: some View {
        if pendingQueuedCount > 0 {
            HStack(spacing: VSpacing.xs) {
                Image(systemName: "text.line.first.and.arrowtriangle.forward")
                    .font(VFont.caption)
                Text(pendingQueuedCount == 1
                     ? "1 message queued, sending automatically"
                     : "\(pendingQueuedCount) messages queued, sending automatically")
                    .font(VFont.caption)
            }
            .foregroundColor(VColor.textSecondary)
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.xs)
            .transition(.opacity)
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
    let onOpenActivity: (UUID) -> Void
    let isActivityPanelOpen: Bool
    var onReportMessage: ((String?) -> Void)?
    var mediaEmbedSettings: MediaEmbedResolverSettings?

    @State private var isHovered = false
    @State private var isRegenerateHovered = false
    @State private var mediaEmbedIntents: [MediaEmbedIntent] = []

    private var isUser: Bool { message.role == .user }
    private var canReportMessage: Bool {
        !isUser && onReportMessage != nil
    }

    /// Composite identity for the `.task` modifier so it re-runs when either
    /// the message text or the embed settings change.
    private var mediaEmbedTaskID: String {
        let s = mediaEmbedSettings
        return "\(message.text)|\(s?.enabled ?? false)|\(s?.enabledSince?.timeIntervalSince1970 ?? 0)|\(s?.allowedDomains ?? [])"
    }

    private var statusLabel: String? {
        switch message.status {
        case .queued(let position):
            return position > 0 ? "Queued (\(ordinal(position)) in line)" : "Queued"
        case .processing:
            return "Sending\u{2026}"
        case .sent:
            return nil
        }
    }

    private var bubbleOpacity: Double {
        switch message.status {
        case .queued: return 0.7
        case .processing: return 0.85
        case .sent: return 1.0
        }
    }

    private var bubbleFill: AnyShapeStyle {
        if isUser {
            AnyShapeStyle(VColor.userBubble)
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
        HStack(spacing: VSpacing.sm) {
            if isUser { Spacer(minLength: 0) }

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

                if let label = statusLabel {
                    Text(label)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
            }
            // Prevent LazyVStack from compressing the bubble height, which causes the
            // trailing tool-chip to overlap long text content.
            .fixedSize(horizontal: false, vertical: true)

            if canReportMessage {
                VStack {
                    Menu {
                        if let onReportMessage {
                            Button("Export response for diagnostics") {
                                onReportMessage(message.daemonMessageId)
                            }
                        }
                    } label: {
                        Image(systemName: "ellipsis")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundColor(VColor.textSecondary)
                            .rotationEffect(.degrees(90))
                            .frame(width: 24, height: 24)
                            .contentShape(Rectangle())
                    }
                    .menuStyle(.borderlessButton)
                    .menuIndicator(.hidden)
                    .frame(width: 24, height: 24)
                    .opacity(isHovered ? 1 : 0)
                    .allowsHitTesting(isHovered)
                    .accessibilityLabel("Message actions")
                    .animation(VAnimation.fast, value: isHovered)

                    Spacer(minLength: 0)
                }
                .frame(width: 24)
            }

            if !isUser { Spacer(minLength: 0) }
        }
        .contentShape(Rectangle())
        .onHover { hovering in
            if canReportMessage {
                isHovered = hovering
            } else if isHovered {
                isHovered = false
            }
        }
        .task(id: mediaEmbedTaskID) {
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
        .overlay(alignment: .top) {
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
                    .offset(y: -28)
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
            let displayName = rawName.replacingOccurrences(of: "_", with: " ")
            let activeBuildingStatus = message.toolCalls.last(where: { !$0.isComplete })?.buildingStatus
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                RunningIndicator(
                    label: Self.friendlyRunningLabel(displayName, buildingStatus: activeBuildingStatus),
                    onTap: { onOpenActivity(message.id) }
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
                onTap: { onOpenActivity(message.id) }
            )
                .frame(maxWidth: 520, alignment: .leading)
        } else if toolsCompleteButStillStreaming && !permissionWasDenied {
            // All tools done but model is still working (generating next tool call)
            RunningIndicator(
                label: "Thinking",
                progressiveLabels: ["Thinking", "Figuring out next steps", "Almost ready"],
                labelInterval: 8,
                onTap: { onOpenActivity(message.id) }
            )
                .frame(maxWidth: 520, alignment: .leading)
        } else if hasCompletedTools || hasPermission || showRegenerate || (hasInProgressTools && permissionWasDenied) {
            // All done (or denied) — show chips + regenerate on one line
            let onlyPermissionTools = message.toolCalls.allSatisfy { $0.toolName.lowercased() == "request system permission" }
            HStack(spacing: VSpacing.sm) {
                if hasCompletedTools && !(onlyPermissionTools && decidedConfirmation != nil) {
                    compactToolChip
                } else if hasInProgressTools && permissionWasDenied {
                    compactFailedToolChip
                }
                if let confirmation = decidedConfirmation {
                    compactPermissionChip(confirmation)
                }
                if showRegenerate {
                    regenerateButton
                }
                Spacer()
            }
            .padding(.top, VSpacing.xxs)
        }
    }

    /// Maps tool names to user-friendly past-tense labels.
    /// When `inputSummary` is provided, produces contextual labels like "Read config.json".
    private static func friendlyToolLabel(_ toolName: String, inputSummary: String = "") -> String {
        ToolDisplayHelpers.friendlyToolLabel(toolName, inputSummary: inputSummary)
    }

    /// Plural past-tense labels for multiple tool calls of the same type.
    private static func friendlyToolLabelPlural(_ toolName: String, count: Int) -> String {
        ToolDisplayHelpers.friendlyToolLabelPlural(toolName, count: count)
    }

    /// Maps tool names to user-friendly present-tense labels for the running state.
    private static func friendlyRunningLabel(_ toolName: String, inputSummary: String? = nil, buildingStatus: String? = nil) -> String {
        ToolDisplayHelpers.friendlyRunningLabel(toolName, inputSummary: inputSummary, buildingStatus: buildingStatus)
    }

    /// Progressive labels for long-running tools. Cycles through these over time.
    private static func progressiveLabels(for toolName: String) -> [String] {
        ToolDisplayHelpers.progressiveLabels(for: toolName)
    }

    /// Icon for a tool category.
    private static func friendlyToolIcon(_ toolName: String) -> String {
        ToolDisplayHelpers.friendlyToolIcon(toolName)
    }

    /// Convert raw permission_type (e.g. "full_disk_access") to a user-facing label.
    private static func permissionFriendlyName(from rawType: String) -> String {
        ToolDisplayHelpers.permissionFriendlyName(from: rawType)
    }

    private var compactToolChip: some View {
        Button {
            onOpenActivity(message.id)
        } label: {
            HStack(spacing: VSpacing.xs) {
                let uniqueNames = Array(Set(message.toolCalls.map(\.toolName))).sorted()
                let primary = uniqueNames.first ?? "Tool"

                Image(systemName: Self.friendlyToolIcon(primary))
                    .font(.system(size: 12))
                    .foregroundColor(VColor.textMuted)

                let label: String = {
                    if uniqueNames.count == 1 {
                        if message.toolCalls.count == 1, let first = message.toolCalls.first {
                            // Single tool: contextual label with details
                            return Self.friendlyToolLabel(primary, inputSummary: first.inputSummary)
                        }
                        // Multiple of the same tool: count-based
                        return Self.friendlyToolLabelPlural(primary, count: message.toolCalls.count)
                    }
                    return "Used \(message.toolCalls.count) tools"
                }()

                Text(label)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)

                Image(systemName: "chevron.right")
                    .font(.system(size: 8, weight: .semibold))
                    .foregroundColor(VColor.textMuted)
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
        .buttonStyle(.plain)
        .onHover { hovering in
            if hovering {
                NSCursor.pointingHand.push()
            } else {
                NSCursor.pop()
            }
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
        let segments = parseMarkdownSegments(segmentText)
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
                            .frame(maxWidth: 280, maxHeight: 280)
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

    /// Partitions attachments into decoded images and non-image files in a single pass,
    /// avoiding redundant base64 decoding and NSImage construction across render calls.
    private var partitionedAttachments: (images: [(ChatAttachment, NSImage)], files: [ChatAttachment]) {
        var images: [(ChatAttachment, NSImage)] = []
        var files: [ChatAttachment] = []
        for attachment in message.attachments {
            if attachment.mimeType.hasPrefix("image/"), let img = nsImage(for: attachment) {
                images.append((attachment, img))
            } else {
                files.append(attachment)
            }
        }
        return (images, files)
    }

    private var bubbleContent: some View {
        let partitioned = partitionedAttachments
        return VStack(alignment: .leading, spacing: VSpacing.sm) {
            if let skillInvocation = message.skillInvocation {
                SkillInvocationChip(data: skillInvocation)
            }

            if hasText {
                let segments = parseMarkdownSegments(message.text)
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
                                    .frame(maxWidth: 280, maxHeight: 280)
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
        .padding(.horizontal, isUser ? VSpacing.lg : 0)
        .padding(.vertical, isUser ? VSpacing.md : 0)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .fill(bubbleFill)
        )
        .frame(maxWidth: 520, alignment: isUser ? .trailing : .leading)
        .opacity(bubbleOpacity)
    }

    @ViewBuilder
    private func documentWidget(for toolCall: ToolCallData) -> some View {
        // Extract document title from the tool call input summary or result
        let documentTitle = parseDocumentTitle(from: toolCall)

        DocumentReopenWidget(
            documentTitle: documentTitle,
            onReopen: {
                // TODO: Re-open the document by sending document_editor_show
                print("Reopen document: \(documentTitle)")
            },
            onDismiss: {
                // TODO: Hide this widget (would need state management)
                print("Dismiss document widget")
            }
        )
        .padding(.top, VSpacing.sm)
    }

    private func parseDocumentTitle(from toolCall: ToolCallData) -> String {
        // Try to extract title from the input summary
        // Format is typically something like "Create document: <title>"
        let summary = toolCall.inputSummary
        if let colonIndex = summary.firstIndex(of: ":") {
            let afterColon = summary[summary.index(after: colonIndex)...].trimmingCharacters(in: .whitespaces)
            if !afterColon.isEmpty {
                return String(afterColon)
            }
        }
        return "Untitled Document"
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
        let fileURL = tempDir.appendingPathComponent(attachment.filename)
        do {
            try data.write(to: fileURL)
            NSWorkspace.shared.open(fileURL)
        } catch {
            // Silently fail — not critical
        }
    }

    private func fileIcon(for mimeType: String) -> String {
        FileDisplayHelpers.fileIcon(for: mimeType)
    }

    private func formattedFileSize(base64Length: Int) -> String {
        FileDisplayHelpers.formattedFileSize(base64Length: base64Length)
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
            parsed[attrStart..<attrEnd].foregroundColor = VColor.accent
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

    private func ordinal(_ n: Int) -> String {
        let suffix: String
        let ones = n % 10
        let tens = (n / 10) % 10
        if tens == 1 {
            suffix = "th"
        } else {
            switch ones {
            case 1: suffix = "st"
            case 2: suffix = "nd"
            case 3: suffix = "rd"
            default: suffix = "th"
            }
        }
        return "\(n)\(suffix)"
    }
}

// MARK: - Markdown Table Support

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
                onStopWatch: {},
                onOpenActivity: { _ in },
                isActivityPanelOpen: false
            )
        }
    }
}
#endif
