import SwiftUI
import VellumAssistantShared
import UniformTypeIdentifiers

struct ChatView: View {
    let messages: [ChatMessage]
    @Binding var inputText: String
    let hasAPIKey: Bool
    let isThinking: Bool
    let isCompacting: Bool
    let isSending: Bool
    let suggestion: String?
    let pendingAttachments: [ChatAttachment]
    var isLoadingAttachment: Bool = false
    let isRecording: Bool
    let onSend: () -> Void
    let onStop: () -> Void
    let onAcceptSuggestion: () -> Void
    let onAttach: () -> Void
    let onRemoveAttachment: (String) -> Void
    let onDropFiles: ([URL]) -> Void
    let onDropImageData: (Data, String?) -> Void
    let onPaste: () -> Void
    let onMicrophoneToggle: () -> Void
    var selectedModel: String = ""
    var configuredProviders: Set<String> = []
    var providerCatalog: [ProviderCatalogEntry] = []
    let assistantActivityPhase: String
    let assistantActivityAnchor: String
    let assistantActivityReason: String?
    let assistantStatusText: String?
    let onConfirmationAllow: (String) -> Void
    let onConfirmationDeny: (String) -> Void
    let onAlwaysAllow: (String, String, String, String) -> Void
    /// Called when a temporary approval option is selected: (requestId, decision).
    var onTemporaryAllow: ((String, String) -> Void)?
    var onGuardianAction: ((String, String) -> Void)?
    let onSurfaceAction: (String, String, [String: AnyCodable]?) -> Void
    let watchSession: WatchSession?
    let onStopWatch: () -> Void
    var onReportMessage: ((String?) -> Void)?
    var showInspectButton: Bool = false
    var onInspectMessage: ((String?) -> Void)?
    var mediaEmbedSettings: MediaEmbedResolverSettings?
    var isTemporaryChat: Bool = false
    var activeSubagents: [SubagentInfo] = []
    var onAbortSubagent: ((String) -> Void)?
    var onSubagentTap: ((String) -> Void)?
    /// Called to rehydrate truncated message content on demand.
    var onRehydrateMessage: ((UUID) -> Void)?
    /// Called when a stripped surface scrolls into view and needs its data re-fetched.
    var onSurfaceRefetch: ((String, String) -> Void)?
    /// Called when the user taps "Retry" on a per-message send failure.
    var onRetryFailedMessage: ((UUID) -> Void)?
    /// Called when the user taps "Retry" on an inline conversation error.
    /// Receives the error message's ID so the handler can validate the retry target.
    var onRetryConversationError: ((UUID) -> Void)?
    var subagentDetailStore: SubagentDetailStore
    /// Resolves the daemon HTTP port at call time so lazy-loaded video
    /// attachments always use the latest port after daemon restarts.
    var resolveHttpPort: (() -> Int?) = { nil }
    var isHistoryLoaded: Bool = true
    var dismissedDocumentSurfaceIds: Set<String> = []
    var onDismissDocumentWidget: ((String) -> Void)?
    var voiceModeManager: VoiceModeManager? = nil
    var voiceService: OpenAIVoiceService? = nil
    var onEndVoiceMode: (() -> Void)? = nil
    var recordingAmplitude: Float = 0
    var onDictateToggle: (() -> Void)? = nil
    var onVoiceModeToggle: (() -> Void)? = nil
    var conversationId: UUID?
    var daemonGreeting: String? = nil
    var onRequestGreeting: (() -> Void)? = nil
    var conversationStarters: [ConversationStarter] = []
    var conversationStartersLoading: Bool = false
    var onSelectStarter: ((ConversationStarter) -> Void)? = nil
    var onFetchConversationStarters: (() -> Void)? = nil
    var isInteractionEnabled: Bool = true
    /// When set, scroll to this message ID and clear the binding.
    @Binding var anchorMessageId: UUID?
    /// Message ID to visually highlight after an anchor scroll completes.
    @Binding var highlightedMessageId: UUID?

    // MARK: - BTW Side-Chain

    /// The accumulated response text from a /btw side-chain query, or nil when inactive.
    var btwResponse: String? = nil
    /// True while a /btw request is in flight.
    var btwLoading: Bool = false
    /// Called to dismiss the btw overlay.
    var onDismissBtw: (() -> Void)?

    // MARK: - Credits Exhausted (inline banner)

    /// Non-nil when the conversation ended due to credits exhaustion.
    var creditsExhaustedError: ConversationError? = nil
    /// Opens the billing / add-funds flow.
    var onAddFunds: (() -> Void)? = nil
    /// Dismisses the credits-exhausted banner.
    var onDismissCreditsExhausted: (() -> Void)? = nil

    // MARK: - Pagination

    var displayedMessageCount: Int = .max
    var hasMoreMessages: Bool = false
    var isLoadingMoreMessages: Bool = false
    var loadPreviousMessagePage: (() async -> Bool)?

    /// When true, suppresses `ChatEmptyStateView` during first-launch bootstrap
    /// and shows a loading panel instead.
    var isBootstrapping: Bool = false

    /// When true during bootstrap, the daemon failed to connect within the
    /// timeout window. Shows a failure screen instead of the loading skeleton.
    var isBootstrapTimedOut: Bool = false

    /// Called when the user taps "Send Logs to Vellum" on the bootstrap
    /// timeout view.
    var onBootstrapSendLogs: (() -> Void)?

    @State private var isNearBottom = true
    @State private var isDropTargeted = false
    @State private var containerWidth: CGFloat = 0

    // MARK: - In-Chat Search (Cmd+F)
    @State private var isSearchActive = false
    @State private var searchText = ""
    @State private var currentMatchIndex = 0
    @State private var showSkeleton = false
    @State private var skeletonDebounceTask: Task<Void, Never>? = nil

    private var isEmptyState: Bool {
        messages.isEmpty && isHistoryLoaded
    }

    private var shouldShowSkeleton: Bool {
        messages.isEmpty && !isHistoryLoaded
    }

    /// Message IDs whose text contains the search query, ordered chronologically.
    private var searchMatches: [UUID] {
        guard !searchText.isEmpty else { return [] }
        let query = searchText.lowercased()
        return messages.filter { $0.text.lowercased().contains(query) }.map(\.id)
    }

    var body: some View {
        ZStack {
            VStack(spacing: 0) {
                if showSkeleton {
                    ChatLoadingSkeleton()
                        .padding(VSpacing.lg)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel("Loading chat history")
                } else if isEmptyState && isBootstrapping {
                    if isBootstrapTimedOut {
                        ChatBootstrapTimeoutView(onSendLogs: onBootstrapSendLogs)
                    } else {
                        ChatBootstrapLoadingView()
                    }
                } else if isEmptyState {
                    if isTemporaryChat {
                        ChatTemporaryChatEmptyStateView(
                            inputText: $inputText,
                            hasAPIKey: hasAPIKey,
                            isSending: isSending,
                            isRecording: isRecording,
                            suggestion: suggestion,
                            pendingAttachments: pendingAttachments,
                            isLoadingAttachment: isLoadingAttachment,
                            onSend: onSend,
                            onStop: onStop,
                            onAcceptSuggestion: onAcceptSuggestion,
                            onAttach: onAttach,
                            onRemoveAttachment: onRemoveAttachment,
                            onPaste: onPaste,
                            onFileDrop: onDropFiles,
                            onDropImageData: onDropImageData,
                            onMicrophoneToggle: onMicrophoneToggle,
                            recordingAmplitude: recordingAmplitude,
                            onDictateToggle: onDictateToggle,
                            onVoiceModeToggle: onVoiceModeToggle,
                            conversationId: conversationId
                        )
                    } else {
                        ChatEmptyStateView(
                            inputText: $inputText,
                            hasAPIKey: hasAPIKey,
                            isSending: isSending,
                            isRecording: isRecording,
                            suggestion: suggestion,
                            pendingAttachments: pendingAttachments,
                            isLoadingAttachment: isLoadingAttachment,
                            onSend: onSend,
                            onStop: onStop,
                            onAcceptSuggestion: onAcceptSuggestion,
                            onAttach: onAttach,
                            onRemoveAttachment: onRemoveAttachment,
                            onPaste: onPaste,
                            onFileDrop: onDropFiles,
                            onDropImageData: onDropImageData,
                            onMicrophoneToggle: onMicrophoneToggle,
                            recordingAmplitude: recordingAmplitude,
                            onDictateToggle: onDictateToggle,
                            onVoiceModeToggle: onVoiceModeToggle,
                            conversationId: conversationId,
                            daemonGreeting: daemonGreeting,
                            onRequestGreeting: onRequestGreeting,
                            conversationStarters: conversationStarters,
                            conversationStartersLoading: conversationStartersLoading,
                            onSelectStarter: onSelectStarter,
                            onFetchConversationStarters: onFetchConversationStarters
                        )
                    }
                } else {
                    VStack(spacing: 0) {
                        MessageListView(
                            messages: messages,
                            isSending: isSending,
                            isThinking: isThinking,
                            isCompacting: isCompacting,
                            assistantActivityPhase: assistantActivityPhase,
                            assistantActivityAnchor: assistantActivityAnchor,
                            assistantActivityReason: assistantActivityReason,
                            assistantStatusText: assistantStatusText,
                            selectedModel: selectedModel,
                            configuredProviders: configuredProviders,
                            providerCatalog: providerCatalog,
                            activeSubagents: activeSubagents,
                            dismissedDocumentSurfaceIds: dismissedDocumentSurfaceIds,
                            onConfirmationAllow: onConfirmationAllow,
                            onConfirmationDeny: onConfirmationDeny,
                            onAlwaysAllow: onAlwaysAllow,
                            onTemporaryAllow: onTemporaryAllow,
                            onSurfaceAction: onSurfaceAction,
                            onGuardianAction: onGuardianAction,
                            onDismissDocumentWidget: onDismissDocumentWidget,
                            onReportMessage: onReportMessage,
                            showInspectButton: showInspectButton,
                            onInspectMessage: onInspectMessage,
                            mediaEmbedSettings: mediaEmbedSettings,
                            resolveHttpPort: resolveHttpPort,
                            onAbortSubagent: onAbortSubagent,
                            onSubagentTap: onSubagentTap,
                            onRehydrateMessage: onRehydrateMessage,
                            onSurfaceRefetch: onSurfaceRefetch,
                            onRetryFailedMessage: onRetryFailedMessage,
                            onRetryConversationError: onRetryConversationError,
                            subagentDetailStore: subagentDetailStore,
                            creditsExhaustedError: creditsExhaustedError,
                            onAddFunds: onAddFunds,
                            onDismissCreditsExhausted: onDismissCreditsExhausted,
                            displayedMessageCount: displayedMessageCount,
                            hasMoreMessages: hasMoreMessages,
                            isLoadingMoreMessages: isLoadingMoreMessages,
                            loadPreviousMessagePage: loadPreviousMessagePage,
                            conversationId: conversationId,
                            anchorMessageId: $anchorMessageId,
                            highlightedMessageId: $highlightedMessageId,
                            isNearBottom: $isNearBottom,
                            containerWidth: containerWidth
                        )

                        let composerMessages: [ChatMessage] = {
                            let all = messages.filter { !$0.isSubagentNotification }
                            guard displayedMessageCount < all.count else { return all }
                            return Array(all.suffix(displayedMessageCount))
                        }()

                        ComposerSection(
                            inputText: $inputText,
                            hasAPIKey: hasAPIKey,
                            isSending: isSending,
                            hasPendingConfirmation: PendingConfirmationFocusSelector.activeRequestId(from: composerMessages) != nil,
                            onAllowPendingConfirmation: {
                                if let requestId = PendingConfirmationFocusSelector.activeRequestId(from: composerMessages) {
                                    onConfirmationAllow(requestId)
                                }
                            },
                            isRecording: isRecording,
                            suggestion: suggestion,
                            pendingAttachments: pendingAttachments,
                            isLoadingAttachment: isLoadingAttachment,
                            onSend: onSend,
                            onStop: onStop,
                            onAcceptSuggestion: onAcceptSuggestion,
                            onAttach: onAttach,
                            onRemoveAttachment: onRemoveAttachment,
                            onPaste: onPaste,
                            onFileDrop: onDropFiles,
                            onDropImageData: onDropImageData,
                            onMicrophoneToggle: onMicrophoneToggle,
                            watchSession: watchSession,
                            onStopWatch: onStopWatch,
                            voiceModeManager: voiceModeManager,
                            voiceService: voiceService,
                            onEndVoiceMode: onEndVoiceMode,
                            recordingAmplitude: recordingAmplitude,
                            onDictateToggle: onDictateToggle,
                            onVoiceModeToggle: onVoiceModeToggle,
                            conversationId: conversationId,
                            isInteractionEnabled: isInteractionEnabled
                        )
                    }
                }
            }
            .background(alignment: .bottom) {
                chatBackground
            }
            .background(VColor.surfaceBase)
            .background(
                GeometryReader { geo in
                    Color.clear.preference(key: ChatContainerWidthKey.self, value: geo.size.width)
                }
            )
            .onPreferenceChange(ChatContainerWidthKey.self) { containerWidth = $0 }
            .disabled(!isInteractionEnabled)
            .overlay(alignment: .bottom) {
                btwOverlay
            }
            .animation(VAnimation.fast, value: btwResponse != nil)

            // Drop target overlay
            if isDropTargeted {
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .stroke(VColor.primaryBase, style: StrokeStyle(lineWidth: 2, dash: [8, 4]))
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.lg)
                            .fill(VColor.primaryBase.opacity(0.08))
                    )
                    .overlay {
                        VStack(spacing: VSpacing.sm) {
                            VIconView(.arrowDownToLine, size: 28)
                                .foregroundColor(VColor.primaryBase)
                            Text("Drop files here")
                                .font(VFont.bodyMedium)
                                .foregroundColor(VColor.primaryBase)
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
        .onKeyPress(.escape) {
            if isSearchActive {
                dismissSearch()
                return .handled
            }
            if btwResponse != nil {
                onDismissBtw?()
                return .handled
            }
            return .ignored
        }
        .onKeyPress("f", phases: .down) { press in
            guard press.modifiers == .command else { return .ignored }
            activateSearch()
            return .handled
        }
        .overlay(alignment: .topTrailing) {
            if isSearchActive {
                ChatSearchBar(
                    searchText: $searchText,
                    matchCount: searchMatches.count,
                    currentMatchIndex: currentMatchIndex,
                    onPrevious: { navigateMatch(delta: -1) },
                    onNext: { navigateMatch(delta: 1) },
                    onDismiss: { dismissSearch() }
                )
                .padding(.trailing, VSpacing.xl)
                .padding(.top, VSpacing.sm)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .animation(VAnimation.fast, value: isSearchActive)
        .onChange(of: searchText) {
            // Reset to first match when query changes
            currentMatchIndex = 0
            scrollToCurrentMatch()
        }
        .onChange(of: searchMatches.count) {
            // Clamp currentMatchIndex when matches change (e.g. streaming, deletion)
            // to avoid "4 of 2" display or broken navigation.
            let count = searchMatches.count
            if currentMatchIndex >= count {
                currentMatchIndex = max(count - 1, 0)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .activateChatSearch)) { notification in
            // Scope to the active conversation so only the visible ChatView activates.
            if let targetId = notification.object as? UUID, targetId != conversationId {
                return
            }
            activateSearch()
        }
        .onChange(of: shouldShowSkeleton, initial: true) { _, shouldShow in
            skeletonDebounceTask?.cancel()
            if shouldShow {
                skeletonDebounceTask = Task {
                    try? await Task.sleep(nanoseconds: 200_000_000) // 200ms
                    guard !Task.isCancelled else { return }
                    showSkeleton = true
                }
            } else {
                showSkeleton = false
            }
        }
    }

    @Environment(\.colorScheme) private var colorScheme

    @ViewBuilder
    private var chatBackground: some View {
        EmptyView()
    }

    @ViewBuilder
    private var btwOverlay: some View {
        if let btwText = btwResponse {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                HStack {
                    Text("/btw")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                    Spacer()
                    Button(action: { onDismissBtw?() }) {
                        VIconView(.x, size: 12)
                            .foregroundColor(VColor.contentTertiary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Dismiss btw response")
                }

                if btwLoading && btwText.isEmpty {
                    Text("Thinking...")
                        .font(VFont.body)
                        .foregroundColor(VColor.contentTertiary)
                } else if !btwLoading && btwText.isEmpty {
                    Text("No response received.")
                        .font(VFont.body)
                        .foregroundColor(VColor.contentTertiary)
                } else {
                    Text(btwText)
                        .font(VFont.body)
                        .foregroundColor(VColor.contentDefault)
                        .textSelection(.enabled)
                }

                if !btwLoading {
                    Text("Press Escape to dismiss")
                        .font(VFont.small)
                        .foregroundColor(VColor.contentTertiary)
                }
            }
            .padding(VSpacing.md)
            .background(VColor.surfaceBase)
            .cornerRadius(VRadius.md)
            .vShadow(VShadow.sm)
            .padding(.horizontal, VSpacing.lg)
            .padding(.bottom, VSpacing.xxxl + VSpacing.xxl)
            .transition(.opacity.combined(with: .move(edge: .bottom)))
        }
    }

    /// Handle dropped items — supports both file URLs and raw image data.
    /// File URLs are preferred (preserves original filenames); raw image data
    /// is used as a fallback for providers without a backing file (e.g. screenshot
    /// thumbnails or images dragged from certain apps).
    private func handleDrop(providers: [NSItemProvider]) -> Bool {
        // Reset overlay immediately — SwiftUI's isTargeted binding may not
        // reset reliably when AppKit's NSDraggingDestination (e.g. the
        // NSTextView inside the composer) intercepts the drag session.
        isDropTargeted = false

        var urls: [URL] = []
        var imageDataItems: [NSItemProvider] = []
        let group = DispatchGroup()

        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                let hasImageFallback = provider.hasItemConformingToTypeIdentifier(UTType.image.identifier)
                    || provider.hasItemConformingToTypeIdentifier(UTType.png.identifier)
                    || provider.hasItemConformingToTypeIdentifier(UTType.tiff.identifier)
                group.enter()
                _ = provider.loadObject(ofClass: URL.self) { url, error in
                    DispatchQueue.main.async {
                        if let url, FileManager.default.fileExists(atPath: url.path) {
                            urls.append(url)
                            group.leave()
                        } else if hasImageFallback {
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
                                    } else if let url, url.isFileURL {
                                        // Image data load failed — fall back to
                                        // the file URL (may be a file promise).
                                        urls.append(url)
                                    }
                                    group.leave()
                                }
                            }
                        } else if let url, url.isFileURL {
                            // File URL doesn't exist on disk yet (e.g. file
                            // promises from Music.app, Voice Memos) and no
                            // image data fallback is available. Try the URL
                            // anyway — the attachment loader will report an
                            // error if the file is truly inaccessible.
                            urls.append(url)
                            group.leave()
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

    // MARK: - Search Helpers

    private func activateSearch() {
        isSearchActive = true
    }

    private func dismissSearch() {
        isSearchActive = false
        searchText = ""
        currentMatchIndex = 0
    }

    private func navigateMatch(delta: Int) {
        let matches = searchMatches
        guard !matches.isEmpty else { return }
        currentMatchIndex = (currentMatchIndex + delta + matches.count) % matches.count
        scrollToCurrentMatch()
    }

    private func scrollToCurrentMatch() {
        let matches = searchMatches
        guard !matches.isEmpty, currentMatchIndex < matches.count else { return }
        anchorMessageId = matches[currentMatchIndex]
    }
}

// MARK: - Bootstrap Loading View

/// Minimal loading panel shown during first-launch bootstrap while the
/// assistant's first reply is pending. Replaces `ChatEmptyStateView` so
/// the user sees a calm loading state instead of the usual empty chat.
private struct ChatBootstrapLoadingView: View {
    @State private var visible = false

    var body: some View {
        ChatLoadingSkeleton()
            .padding(VSpacing.lg)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Getting ready")
            .opacity(visible ? 1 : 0)
            .onAppear {
                withAnimation(VAnimation.standard) {
                    visible = true
                }
            }
    }
}

/// Shown during first-launch bootstrap when the daemon fails to connect
/// within the timeout window. Mirrors the hatch-failure pattern from
/// onboarding: a centered error message with an option to send logs.
private struct ChatBootstrapTimeoutView: View {
    var onSendLogs: (() -> Void)?

    @State private var visible = false

    var body: some View {
        VStack(spacing: VSpacing.lg) {
            Spacer()

            VIconView(.triangleAlert, size: 28)
                .foregroundColor(VColor.systemNegativeHover)

            VStack(spacing: VSpacing.sm) {
                Text("Something went wrong")
                    .font(.system(size: 24, weight: .regular, design: .serif))
                    .foregroundColor(VColor.contentDefault)
                Text("Your assistant didn\u{2019}t connect in time. Please quit and reopen the app.")
                    .font(.system(size: 14))
                    .foregroundColor(VColor.contentSecondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 320)
                    .textSelection(.enabled)
            }

            if let onSendLogs {
                VButton(label: "Send Logs to Vellum", leftIcon: VIcon.send.rawValue, style: .primary) {
                    onSendLogs()
                }
            }

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .opacity(visible ? 1 : 0)
        .onAppear {
            withAnimation(VAnimation.standard) {
                visible = true
            }
        }
    }
}

// MARK: - Scroll Wheel Detection

/// Detects user-initiated scroll events scoped to the chat scroll view.
/// Fires `onScrollUp` when the user scrolls toward older content (untethers auto-scroll),
/// and `onScrollToBottom` when the user manually scrolls back to the bottom (re-tethers).
struct ScrollWheelDetector: NSViewRepresentable {
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
                // Direct user scroll up (toward older content) — untether immediately.
                // Momentum events are excluded so a flick doesn't accidentally untether.
                // Called synchronously so isNearBottom is cleared before any competing
                // layout pass can trigger an auto-scroll-to-bottom.
                // Guard: only untether if content is actually scrollable (prevents false
                // untethers on short conversations that can't scroll).
                if let scrollView = coordinator.findEnclosingScrollView() {
                    let clipHeight = scrollView.contentView.bounds.height
                    let docHeight = scrollView.documentView?.frame.height ?? 0
                    if docHeight > clipHeight {
                        coordinator.onScrollUp?()
                    }
                } else {
                    coordinator.onScrollUp?()
                }
            } else if event.scrollingDeltaY < -1 {
                // Scrolling down (direct or momentum) — re-tether if at bottom.
                // Deferred to next run-loop tick so clipBounds reflects the post-scroll position;
                // reading it synchronously in the event monitor sees the pre-scroll state.
                DispatchQueue.main.async {
                    if let scrollView = coordinator.findEnclosingScrollView() {
                        let clipBounds = scrollView.contentView.bounds
                        let docHeight = scrollView.documentView?.frame.height ?? 0
                        if docHeight - clipBounds.maxY < 20 {
                            coordinator.onScrollToBottom?()
                        }
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

        /// Resolves the chat's vertical NSScrollView.
        /// The detector sits in a `.background` modifier (sibling of the scroll view),
        /// so walking up the superview chain may miss it or find a wrong parent.
        /// The hit-test fallback searches for a *vertical* scroll view to avoid
        /// resolving to nested horizontal scrollers (e.g. markdown code blocks).
        func findEnclosingScrollView() -> NSScrollView? {
            // Fast path: walk up the superview chain.
            if let sv = view?.enclosingScrollView, sv.hasVerticalScroller { return sv }
            var current = view?.superview
            while let v = current {
                if let sv = v as? NSScrollView, sv.hasVerticalScroller { return sv }
                current = v.superview
            }
            // Fallback: hit-test from the window root for a vertical scroll view.
            guard let window = view?.window, let contentView = window.contentView else { return nil }
            let probe = view?.convert(
                NSPoint(x: view?.bounds.midX ?? 0, y: view?.bounds.midY ?? 0),
                to: nil
            ) ?? .zero
            return Self.verticalScrollView(in: contentView, containing: probe)
        }

        /// Finds the outermost vertical NSScrollView containing `windowPoint`.
        /// Stops at the first vertical match so nested horizontal scrollers
        /// (e.g. code-block scroll views) are not returned.
        private static func verticalScrollView(in view: NSView, containing windowPoint: NSPoint) -> NSScrollView? {
            let localPoint = view.convert(windowPoint, from: nil)
            guard view.bounds.contains(localPoint) else { return nil }
            // If this is a vertical scroll view, return it immediately — don't
            // recurse into children which may contain nested horizontal scrollers.
            if let sv = view as? NSScrollView, sv.hasVerticalScroller {
                return sv
            }
            for sub in view.subviews.reversed() {
                if let sv = verticalScrollView(in: sub, containing: windowPoint) {
                    return sv
                }
            }
            return nil
        }
    }
}

// MARK: - Scroll Wheel Passthrough

/// Forwards scroll-wheel events to the chat's NSScrollView so that overlaid
/// controls (like the "Scroll to latest" pill) don't swallow trackpad/mouse-wheel input.
struct ScrollWheelPassthrough: NSViewRepresentable {
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
        /// Cached scroll view reference to avoid O(n) view hierarchy traversal
        /// on every scroll event. Weak so it self-clears if the scroll view is
        /// deallocated (e.g. window close).
        weak var cachedScrollView: NSScrollView?
        var monitor: Any?

        /// Finds the deepest NSScrollView whose frame contains the event point.
        /// This ensures we forward to the chat scroll view, not the sidebar.
        /// Caches the result after first lookup since the scroll view doesn't
        /// change during the lifetime of this coordinator.
        func findScrollView(for event: NSEvent) -> NSScrollView? {
            if let cached = cachedScrollView, cached.window != nil { return cached }
            guard let contentView = view?.window?.contentView else { return nil }
            let found = Self.deepestScrollView(in: contentView, containing: event.locationInWindow)
            cachedScrollView = found
            return found
        }

        private static func deepestScrollView(in view: NSView, containing windowPoint: NSPoint) -> NSScrollView? {
            let localPoint = view.convert(windowPoint, from: nil)
            guard view.bounds.contains(localPoint) else { return nil }

            for sub in view.subviews.reversed() {
                if let sv = deepestScrollView(in: sub, containing: windowPoint) {
                    return sv
                }
            }

            if let sv = view as? NSScrollView, sv.hasVerticalScroller { return sv }
            return nil
        }
    }
}

/// Propagates the chat container's measured width up to ChatView so it can
/// forward it to MessageListView for resize-aware scroll stabilization.
private struct ChatContainerWidthKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}
