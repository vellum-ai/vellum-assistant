import os
import os.signpost
import SwiftUI
import VellumAssistantShared
import UniformTypeIdentifiers

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ChatView")

// MARK: - Performance Baseline Success Criteria
//
// The os_signpost instrumentation in ChatView, MessageListView, and ChatBubble
// establishes a performance baseline for the @Observable migration. Measure
// these metrics during a 50-message streaming session using Instruments (Points
// of Interest template) BEFORE and AFTER the migration:
//
//   1. ≥50% reduction in ChatBubble body evaluations per streaming burst
//   2. < 500ms total hitch time during 50-message streaming session
//   3. ≥30% reduction in mean graph update duration during streaming

struct ChatView: View {
    // MARK: - ViewModel

    /// The chat view model. With @Observable + @Bindable, SwiftUI tracks only
    /// the specific properties read in this view's body — passing the model
    /// directly does NOT subscribe parent views to any changes.
    /// See: https://developer.apple.com/documentation/swiftui/migrating-from-the-observable-object-protocol-to-the-observable-macro
    @Bindable var viewModel: ChatViewModel

    // MARK: - Settings (from SettingsStore, not viewModel)

    var selectedModel: String = ""
    var configuredProviders: Set<String> = []
    var providerCatalog: [ProviderCatalogEntry] = []
    var mediaEmbedSettings: MediaEmbedResolverSettings?

    // MARK: - Parent Callbacks (capture parent state)

    let onMicrophoneToggle: () -> Void
    var onForkFromMessage: ((String) -> Void)? = nil
    var onInspectMessage: ((String?) -> Void)?
    var onSubagentTap: ((String) -> Void)?
    var onAddFunds: (() -> Void)? = nil
    var onOpenModelsAndServices: (() -> Void)? = nil
    var onBootstrapSendLogs: (() -> Void)?

    // MARK: - Recovery Mode (managed assistants only)

    /// Non-nil when the connected managed assistant is in recovery mode.
    /// When set and `enabled == true`, a `RecoveryModeBanner` is rendered
    /// between the message list and the composer.
    var recoveryMode: PlatformAssistantRecoveryMode? = nil

    /// `true` while an exit-recovery-mode request is in flight.
    var isRecoveryModeExiting: Bool = false

    /// Invoked when the user taps "Resume Assistant" in the maintenance banner.
    var onResumeAssistant: (() -> Void)? = nil

    /// Invoked when the user taps "Open SSH Settings" in the maintenance banner.
    var onOpenSSHSettings: (() -> Void)? = nil

    // MARK: - Parent Bindings

    /// When set, scroll to this message ID and clear the binding.
    @Binding var anchorMessageId: UUID?
    /// Message ID to visually highlight after an anchor scroll completes.
    @Binding var highlightedMessageId: UUID?

    // MARK: - Parent State / Config

    var conversationId: UUID?
    var isInteractionEnabled: Bool = true
    var isReadonly: Bool = false
    var isBootstrapping: Bool = false
    var isBootstrapTimedOut: Bool = false
    var showInspectButton: Bool = false
    var isTTSEnabled: Bool = false
    var isTemporaryChat: Bool = false
    var conversationStartersEnabled: Bool = false

    // MARK: - Voice Mode (from parent)

    var voiceModeManager: VoiceModeManager? = nil
    var voiceService: OpenAIVoiceService? = nil
    var onEndVoiceMode: (() -> Void)? = nil
    var onDictateToggle: (() -> Void)? = nil
    var onVoiceModeToggle: (() -> Void)? = nil

    // MARK: - External State

    var watchSession: WatchSession?

    @State private var isDropTargeted = false
    @State private var isDraggingInternalImage = false
    @State private var dragEndLocalMonitor: Any?
    @State private var dragEndGlobalMonitor: Any?

    // MARK: - In-Chat Search (Cmd+F)
    @State private var isSearchActive = false
    @State private var searchText = ""
    @State private var currentMatchIndex = 0
    @State private var showSkeleton = false
    @State private var skeletonDebounceTask: Task<Void, Never>? = nil
    @State private var containerWidth: CGFloat = 0

    private var isEmptyState: Bool {
        viewModel.paginatedVisibleMessages.isEmpty && viewModel.isHistoryLoaded
    }

    private var shouldShowSkeleton: Bool {
        viewModel.paginatedVisibleMessages.isEmpty && !viewModel.isHistoryLoaded
    }

    /// Message IDs whose text contains the search query, ordered chronologically.
    private var searchMatches: [UUID] {
        guard isSearchActive, !searchText.isEmpty else { return [] }
        let query = searchText.lowercased()
        return viewModel.messages.filter { $0.text.lowercased().contains(query) }.map(\.id)
    }

    var body: some View {
        #if DEBUG
        let _ = os_signpost(.event, log: PerfSignposts.log, name: "ChatView.body")
        #endif
        ZStack {
            mainContentStack(containerWidth: containerWidth)
                .background(alignment: .bottom) {
                    chatBackground
                }
                .background(VColor.surfaceBase)
                .overlay(alignment: .bottom) {
                    btwOverlay
                }
                .animation(VAnimation.fast, value: viewModel.btwResponse != nil)

            dropTargetOverlay
        }
        .onGeometryChange(for: CGFloat.self) { proxy in
            proxy.size.width
        } action: { newWidth in
            containerWidth = newWidth
        }
        .environment(\.dropActions, currentDropActions)
        .onDrop(of: [.fileURL, .image, .png, .tiff], isTargeted: $isDropTargeted) { providers in
            handleDrop(providers: providers)
        }
        .onKeyPress(.escape) {
            guard isInteractionEnabled else { return .ignored }
            if isSearchActive {
                dismissSearch()
                return .handled
            }
            if viewModel.btwResponse != nil {
                viewModel.dismissBtw()
                return .handled
            }
            return .ignored
        }
        .onKeyPress("f", phases: .down) { press in
            guard isInteractionEnabled, press.modifiers == .command else { return .ignored }
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
            currentMatchIndex = 0
            scrollToCurrentMatch()
        }
        .onChange(of: searchMatches.count) {
            let count = searchMatches.count
            if currentMatchIndex >= count {
                currentMatchIndex = max(count - 1, 0)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .activateChatSearch)) { notification in
            if let targetId = notification.object as? UUID, targetId != conversationId {
                return
            }
            activateSearch()
        }
        .onReceive(NotificationCenter.default.publisher(for: .internalImageDragStarted)) { _ in
            isDraggingInternalImage = true
            installDragEndMonitors()
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
        .onDisappear {
            removeDragEndMonitors()
        }
    }

    // MARK: - Body Subviews (extracted to help the Swift type checker)

    @ViewBuilder
    private func mainContentStack(containerWidth: CGFloat) -> some View {
        VStack(spacing: 0) {
            if showSkeleton {
                ChatLoadingSkeleton(containerWidth: containerWidth)
                    .padding(VSpacing.lg)
                    .frame(
                        width: containerWidth > 0 ? containerWidth : nil,
                        maxHeight: .infinity,
                        alignment: .top
                    )
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
                        inputText: $viewModel.inputText,
                        isSending: viewModel.isSending,
                        isAssistantBusy: viewModel.isAssistantBusy,
                        isRecording: viewModel.isRecording,
                        suggestion: viewModel.suggestion,
                        pendingAttachments: viewModel.pendingAttachments,
                        isLoadingAttachment: viewModel.isLoadingAttachment,
                        onSend: { sendMessage() },
                        onStop: { viewModel.stopGenerating() },
                        onAcceptSuggestion: { viewModel.acceptSuggestion() },
                        onAttach: { presentFilePicker() },
                        onRemoveAttachment: { viewModel.removeAttachment(id: $0) },
                        onPaste: { viewModel.addAttachmentFromPasteboard() },
                        onMicrophoneToggle: onMicrophoneToggle,
                        recordingAmplitude: viewModel.recordingAmplitude,
                        onDictateToggle: onDictateToggle,
                        onVoiceModeToggle: onVoiceModeToggle,
                        conversationId: conversationId
                    )
                } else {
                    ChatEmptyStateView(
                        inputText: $viewModel.inputText,
                        isSending: viewModel.isSending,
                        isAssistantBusy: viewModel.isAssistantBusy,
                        isRecording: viewModel.isRecording,
                        suggestion: viewModel.suggestion,
                        pendingAttachments: viewModel.pendingAttachments,
                        isLoadingAttachment: viewModel.isLoadingAttachment,
                        onSend: { sendMessage() },
                        onStop: { viewModel.stopGenerating() },
                        onAcceptSuggestion: { viewModel.acceptSuggestion() },
                        onAttach: { presentFilePicker() },
                        onRemoveAttachment: { viewModel.removeAttachment(id: $0) },
                        onPaste: { viewModel.addAttachmentFromPasteboard() },
                        onMicrophoneToggle: onMicrophoneToggle,
                        recordingAmplitude: viewModel.recordingAmplitude,
                        onDictateToggle: onDictateToggle,
                        onVoiceModeToggle: onVoiceModeToggle,
                        conversationId: conversationId,
                        daemonGreeting: viewModel.emptyStateGreeting,
                        onRequestGreeting: { viewModel.generateGreeting() },
                        conversationStarters: conversationStartersEnabled ? viewModel.conversationStarters : [],
                        conversationStartersLoading: conversationStartersEnabled && viewModel.conversationStartersLoading,
                        onSelectStarter: { starter in viewModel.inputText = starter.prompt },
                        onFetchConversationStarters: { viewModel.fetchConversationStarters() }
                    )
                    .id(conversationId)
                }
            } else {
                activeConversationContent(containerWidth: containerWidth)
            }
        }
    }

    /// Active conversation content stack.
    ///
    /// Data flow is narrowed to the three stabilized subsystems:
    /// - **TranscriptProjector** — `MessageListView` calls `TranscriptProjector.project()`
    ///   to produce an immutable `TranscriptRenderModel` from the raw messages.
    /// - **ComposerController** — popup state (slash/emoji) and focus intents flow
    ///   through the controller's event-driven state machine, not raw bindings.
    /// - **ScrollCoordinator** — scroll policy decisions (follow-bottom, anchor jumps,
    ///   stabilization) flow through the coordinator's `handle(_:)` method and are
    ///   translated into concrete `ScrollPosition` mutations by the view layer.
    ///
    /// The raw viewModel properties passed here (`messages`, `isSending`, etc.)
    /// are the projector's inputs — `MessageListView` does not observe them
    /// individually; it feeds them into the projector and renders the resulting
    /// `TranscriptRenderModel` via `MessageListContentView`.
    @ViewBuilder
    private func activeConversationContent(containerWidth: CGFloat) -> some View {
        VStack(spacing: 0) {
            MessageListView(
                // -- TranscriptProjector inputs --
                messages: viewModel.messages,
                isSending: viewModel.isSending,
                isThinking: viewModel.isThinking,
                isCompacting: viewModel.isCompacting,
                assistantActivityPhase: viewModel.assistantActivityPhase,
                assistantActivityAnchor: viewModel.assistantActivityAnchor,
                assistantActivityReason: viewModel.assistantActivityReason,
                assistantStatusText: viewModel.assistantStatusText,
                selectedModel: selectedModel,
                configuredProviders: configuredProviders,
                providerCatalog: providerCatalog,
                activeSubagents: viewModel.activeSubagents,
                dismissedDocumentSurfaceIds: viewModel.dismissedDocumentSurfaceIds,
                // -- Interaction callbacks --
                onConfirmationAllow: isReadonly ? nil : { requestId in viewModel.respondToConfirmation(requestId: requestId, decision: "allow") },
                onConfirmationDeny: isReadonly ? nil : { requestId in viewModel.respondToConfirmation(requestId: requestId, decision: "deny") },
                onAlwaysAllow: isReadonly ? nil : { requestId, selectedPattern, selectedScope, decision in
                    viewModel.respondToAlwaysAllow(requestId: requestId, selectedPattern: selectedPattern, selectedScope: selectedScope, decision: decision)
                },
                onTemporaryAllow: isReadonly ? nil : { requestId, decision in viewModel.respondToConfirmation(requestId: requestId, decision: decision) },
                onSurfaceAction: isReadonly ? nil : { surfaceId, actionId, data in viewModel.sendSurfaceAction(surfaceId: surfaceId, actionId: actionId, data: data) },
                onGuardianAction: isReadonly ? nil : { requestId, action in viewModel.submitGuardianDecision(requestId: requestId, action: action) },
                onDismissDocumentWidget: { viewModel.dismissDocumentSurface(id: $0) },
                onForkFromMessage: onForkFromMessage,
                showInspectButton: showInspectButton,
                isTTSEnabled: isTTSEnabled,
                onInspectMessage: onInspectMessage,
                mediaEmbedSettings: mediaEmbedSettings,
                onAbortSubagent: { subagentId in
                    Task { await SubagentClient().abort(subagentId: subagentId, conversationId: viewModel.conversationId) }
                },
                onSubagentTap: onSubagentTap,
                onRehydrateMessage: { messageId in viewModel.rehydrateMessage(id: messageId) },
                onSurfaceRefetch: { surfaceId, conversationId in viewModel.refetchStrippedSurface(surfaceId: surfaceId, conversationId: conversationId) },
                onRetryFailedMessage: isReadonly ? nil : { messageId in viewModel.retryFailedMessage(id: messageId) },
                onRetryConversationError: isReadonly ? nil : { messageId in viewModel.retryAfterConversationError(messageId: messageId) },
                subagentDetailStore: viewModel.subagentDetailStore,
                // -- Projector-resolved state --
                activePendingRequestId: viewModel.activePendingRequestId,
                // -- Pagination --
                paginatedVisibleMessages: viewModel.paginatedVisibleMessages,
                displayedMessageCount: viewModel.displayedMessageCount,
                hasMoreMessages: viewModel.hasMoreMessages,
                isLoadingMoreMessages: viewModel.isLoadingMoreMessages,
                loadPreviousMessagePage: { await viewModel.loadPreviousMessagePage() },
                // -- ScrollCoordinator inputs --
                conversationId: conversationId,
                anchorMessageId: $anchorMessageId,
                highlightedMessageId: $highlightedMessageId,
                isInteractionEnabled: isInteractionEnabled,
                containerWidth: containerWidth
            )

            if let error = viewModel.errorManager.conversationError, error.isCreditsExhausted {
                CreditsExhaustedBanner(
                    onAddFunds: { onAddFunds?() }
                )
                // .frame(width:) creates _FrameLayout — no alignment queries.
                // The old .frame(maxWidth:).frame(maxWidth: .infinity) created
                // _FlexFrameLayout which cascaded explicitAlignment through the
                // sibling LazyVStack. VStack default .center alignment centers
                // the fixed-width child automatically.
                .frame(width: containerWidth > 0
                    ? min(containerWidth, VSpacing.chatColumnMaxWidth - 2 * VSpacing.xl)
                    : VSpacing.chatColumnMaxWidth - 2 * VSpacing.xl)
                .padding(.bottom, -VSpacing.sm)
            }

            if let error = viewModel.errorManager.conversationError, error.isProviderNotConfigured {
                MissingApiKeyBanner(
                    onOpenSettings: { onOpenModelsAndServices?() },
                    onDismiss: { viewModel.dismissConversationError() }
                )
                .frame(width: containerWidth > 0
                    ? min(containerWidth, VSpacing.chatColumnMaxWidth - 2 * VSpacing.xl)
                    : VSpacing.chatColumnMaxWidth - 2 * VSpacing.xl)
                .padding(.bottom, -VSpacing.sm)
            }

            if let mode = recoveryMode, mode.enabled {
                RecoveryModeBanner(
                    recoveryMode: mode,
                    onResumeAssistant: { onResumeAssistant?() },
                    onOpenSSHSettings: { onOpenSSHSettings?() },
                    isExiting: isRecoveryModeExiting
                )
                .frame(width: containerWidth > 0
                    ? min(containerWidth, VSpacing.chatColumnMaxWidth - 2 * VSpacing.xl)
                    : VSpacing.chatColumnMaxWidth - 2 * VSpacing.xl)
                .padding(.bottom, -VSpacing.sm)
            }

            if isReadonly {
                HStack(spacing: VSpacing.xs) {
                    Spacer(minLength: 0)
                    VIconView(.eye, size: 14)
                    Text("Read-only conversation")
                        .font(VFont.bodySmallDefault)
                    Spacer(minLength: 0)
                }
                .foregroundStyle(VColor.contentTertiary)
                .padding(.vertical, VSpacing.md)
            } else {
                ComposerSection(
                    inputText: $viewModel.inputText,
                    isSending: viewModel.isSending,
                    isAssistantBusy: viewModel.isAssistantBusy,
                    hasPendingConfirmation: viewModel.activePendingRequestId != nil,
                    onAllowPendingConfirmation: {
                        if let requestId = viewModel.activePendingRequestId {
                            viewModel.respondToConfirmation(requestId: requestId, decision: "allow")
                        }
                    },
                    isRecording: viewModel.isRecording,
                    suggestion: viewModel.suggestion,
                    pendingAttachments: viewModel.pendingAttachments,
                    isLoadingAttachment: viewModel.isLoadingAttachment,
                    onSend: { sendMessage() },
                    onStop: { viewModel.stopGenerating() },
                    onAcceptSuggestion: { viewModel.acceptSuggestion() },
                    onAttach: { presentFilePicker() },
                    onRemoveAttachment: { viewModel.removeAttachment(id: $0) },
                    onPaste: { viewModel.addAttachmentFromPasteboard() },
                    onMicrophoneToggle: onMicrophoneToggle,
                    watchSession: watchSession,
                    onStopWatch: { viewModel.stopWatchSession() },
                    voiceModeManager: voiceModeManager,
                    voiceService: voiceService,
                    onEndVoiceMode: onEndVoiceMode,
                    recordingAmplitude: viewModel.recordingAmplitude,
                    onDictateToggle: onDictateToggle,
                    onVoiceModeToggle: onVoiceModeToggle,
                    conversationId: conversationId,
                    isInteractionEnabled: isInteractionEnabled,
                    contextWindowFillRatio: viewModel.contextWindowFillRatio,
                    contextWindowTokens: viewModel.contextWindowTokens,
                    contextWindowMaxTokens: viewModel.contextWindowMaxTokens,
                    containerWidth: containerWidth
                )
            }
        }
    }

    @ViewBuilder
    private var dropTargetOverlay: some View {
        if isDropTargeted && !isDraggingInternalImage {
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(VColor.primaryBase, style: StrokeStyle(lineWidth: 2, dash: [8, 4]))
                .background(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .fill(VColor.primaryBase.opacity(0.08))
                )
                .overlay {
                    VStack(spacing: VSpacing.sm) {
                        VIconView(.arrowDownToLine, size: 28)
                            .foregroundStyle(VColor.primaryBase)
                        Text("Drop files here")
                            .font(VFont.bodyMediumDefault)
                            .foregroundStyle(VColor.primaryBase)
                    }
                }
                .padding(VSpacing.lg)
                .allowsHitTesting(false)
                .transition(.opacity)
        }
    }

    @Environment(\.colorScheme) private var colorScheme

    @ViewBuilder
    private var chatBackground: some View {
        EmptyView()
    }

    @ViewBuilder
    private var btwOverlay: some View {
        if let btwText = viewModel.btwResponse {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                HStack {
                    Text("/btw")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                    Spacer()
                    Button(action: { viewModel.dismissBtw() }) {
                        VIconView(.x, size: 12)
                            .foregroundStyle(VColor.contentTertiary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Dismiss btw response")
                }

                if viewModel.btwLoading && btwText.isEmpty {
                    Text("Thinking...")
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentTertiary)
                } else if !viewModel.btwLoading && btwText.isEmpty {
                    Text("No response received.")
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentTertiary)
                } else {
                    Text(btwText)
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentDefault)
                        .textSelection(.enabled)
                }

                if !viewModel.btwLoading {
                    Text("Press Escape to dismiss")
                        .font(VFont.labelSmall)
                        .foregroundStyle(VColor.contentTertiary)
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

    // MARK: - Internal Drag Detection

    /// Installs one-shot global + local mouse-up monitors to detect drag-end.
    /// Global monitor catches drops on external apps (Finder, Desktop).
    /// Local monitor catches in-app mouse-up (post-cancel click, etc.).
    /// Both are removed after firing once.
    private func installDragEndMonitors() {
        removeDragEndMonitors()

        dragEndGlobalMonitor = NSEvent.addGlobalMonitorForEvents(matching: .leftMouseUp) { [self] _ in
            isDraggingInternalImage = false
            removeDragEndMonitors()
        }

        dragEndLocalMonitor = NSEvent.addLocalMonitorForEvents(matching: .leftMouseUp) { [self] event in
            isDraggingInternalImage = false
            removeDragEndMonitors()
            return event
        }
    }

    /// Removes both drag-end monitors if installed.
    private func removeDragEndMonitors() {
        if let monitor = dragEndGlobalMonitor {
            NSEvent.removeMonitor(monitor)
            dragEndGlobalMonitor = nil
        }
        if let monitor = dragEndLocalMonitor {
            NSEvent.removeMonitor(monitor)
            dragEndLocalMonitor = nil
        }
    }

    /// DropActions instance built from ChatView's existing callbacks and state,
    /// reused by both the `.onDrop()` on ChatView and the environment injection
    /// so ComposerView's inner `.onDrop()` shares the same handler.
    private var currentDropActions: DropActions {
        DropActions(
            onDropFiles: { urls in urls.forEach { viewModel.addAttachment(url: $0) } },
            onDropImageData: { data, name in
                let filename: String
                if let name {
                    let basename = (name as NSString).lastPathComponent
                    let base = (basename as NSString).deletingPathExtension
                    filename = base.isEmpty ? "Dropped Image.png" : "\(base).png"
                } else {
                    filename = "Dropped Image.png"
                }
                viewModel.addAttachment(imageData: data, filename: filename)
            },
            onDropStarted: { viewModel.attachmentManager.beginExternalLoad() },
            onDropEnded: { viewModel.attachmentManager.endExternalLoad() },
            isDropTargeted: $isDropTargeted,
            isDraggingInternalImage: $isDraggingInternalImage,
            onInternalDragRejected: { self.removeDragEndMonitors() }
        )
    }

    /// Handle dropped items by delegating to the shared ComposerDropHandler.
    /// Kept as a thin wrapper so the `.onDrop()` on ChatView (the outer/fallback
    /// drop target for the message list area) continues to work.
    private func handleDrop(providers: [NSItemProvider]) -> Bool {
        ComposerDropHandler.handleDrop(providers: providers, actions: currentDropActions)
    }

    // MARK: - Actions

    /// Stops recording (if active) and sends the current message.
    private func sendMessage() {
        if viewModel.isRecording { onMicrophoneToggle() }
        viewModel.sendMessage()
    }

    /// Presents an NSOpenPanel as a window-attached sheet for attaching files.
    private func presentFilePicker() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [
            .png, .jpeg, .gif, .webP, .heic, .heif, .pdf, .plainText, .commaSeparatedText,
            UTType("net.daringfireball.markdown") ?? .plainText,
            .movie, .mpeg4Movie, .quickTimeMovie, .avi,
            .mp3, .wav, .aiff, .audio,
        ]
        guard let window = NSApp.keyWindow ?? NSApp.mainWindow else {
            guard panel.runModal() == .OK else { return }
            for url in panel.urls {
                viewModel.addAttachment(url: url)
            }
            return
        }
        panel.beginSheetModal(for: window) { response in
            guard response == .OK else { return }
            for url in panel.urls {
                viewModel.addAttachment(url: url)
            }
        }
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
/// onboarding: a centered error message with an option to report to Vellum.
private struct ChatBootstrapTimeoutView: View {
    var onSendLogs: (() -> Void)?

    @State private var visible = false

    var body: some View {
        VStack(spacing: VSpacing.lg) {
            Spacer()

            VIconView(.triangleAlert, size: 28)
                .foregroundStyle(VColor.systemNegativeHover)

            VStack(spacing: VSpacing.sm) {
                Text("Something went wrong")
                    .font(.system(size: 24, weight: .regular, design: .serif))
                    .foregroundStyle(VColor.contentDefault)
                Text("Your assistant didn\u{2019}t connect in time. Please quit and reopen the app.")
                    .font(.system(size: 14))
                    .foregroundStyle(VColor.contentSecondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 320)
                    .textSelection(.enabled)
            }

            if let onSendLogs {
                VButton(label: "Report to Vellum", leftIcon: VIcon.send.rawValue, style: .primary) {
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
