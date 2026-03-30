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
    let messages: [ChatMessage]
    @Binding var inputText: String
    let isThinking: Bool
    let isCompacting: Bool
    let isSending: Bool
    let isAssistantBusy: Bool
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
    var onDropStarted: (() -> Void)?
    var onDropEnded: (() -> Void)?
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
    var onForkFromMessage: ((String) -> Void)? = nil
    var showInspectButton: Bool = false
    var isTTSEnabled: Bool = false
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
    var activePendingRequestId: String?
    var isInteractionEnabled: Bool = true
    var isReadonly: Bool = false
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

    // MARK: - Provider Not Configured (inline banner)

    /// Non-nil when the conversation ended because no provider is configured.
    var providerNotConfiguredError: ConversationError? = nil
    /// Opens the Models & Services settings tab.
    var onOpenModelsAndServices: (() -> Void)? = nil
    /// Dismisses the provider-not-configured banner.
    var onDismissProviderNotConfigured: (() -> Void)? = nil

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

    /// Called when the user taps "Report to Vellum" on the bootstrap
    /// timeout view.
    var onBootstrapSendLogs: (() -> Void)?

    @State private var isDropTargeted = false
    @State private var isDraggingInternalImage = false
    @State private var dragEndLocalMonitor: Any?
    @State private var dragEndGlobalMonitor: Any?
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
        guard isSearchActive, !searchText.isEmpty else { return [] }
        let query = searchText.lowercased()
        return messages.filter { $0.text.lowercased().contains(query) }.map(\.id)
    }

    var body: some View {
        #if DEBUG
        let _ = os_signpost(.event, log: PerfSignposts.log, name: "ChatView.body")
        #endif
        ZStack {
            mainContentStack
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
                .overlay(alignment: .bottom) {
                    btwOverlay
                }
                .animation(VAnimation.fast, value: btwResponse != nil)

            dropTargetOverlay
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
            if btwResponse != nil {
                onDismissBtw?()
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
    private var mainContentStack: some View {
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
                        isSending: isSending,
                        isAssistantBusy: isAssistantBusy,
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
                        onMicrophoneToggle: onMicrophoneToggle,
                        recordingAmplitude: recordingAmplitude,
                        onDictateToggle: onDictateToggle,
                        onVoiceModeToggle: onVoiceModeToggle,
                        conversationId: conversationId
                    )
                } else {
                    ChatEmptyStateView(
                        inputText: $inputText,
                        isSending: isSending,
                        isAssistantBusy: isAssistantBusy,
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
                activeConversationContent
            }
        }
    }

    @ViewBuilder
    private var activeConversationContent: some View {
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
                onForkFromMessage: onForkFromMessage,
                showInspectButton: showInspectButton,
                isTTSEnabled: isTTSEnabled,
                onInspectMessage: onInspectMessage,
                mediaEmbedSettings: mediaEmbedSettings,
                onAbortSubagent: onAbortSubagent,
                onSubagentTap: onSubagentTap,
                onRehydrateMessage: onRehydrateMessage,
                onSurfaceRefetch: onSurfaceRefetch,
                onRetryFailedMessage: onRetryFailedMessage,
                onRetryConversationError: onRetryConversationError,
                subagentDetailStore: subagentDetailStore,
                activePendingRequestId: activePendingRequestId,
                displayedMessageCount: displayedMessageCount,
                hasMoreMessages: hasMoreMessages,
                isLoadingMoreMessages: isLoadingMoreMessages,
                loadPreviousMessagePage: loadPreviousMessagePage,
                conversationId: conversationId,
                anchorMessageId: $anchorMessageId,
                highlightedMessageId: $highlightedMessageId,
                isInteractionEnabled: isInteractionEnabled,
                containerWidth: containerWidth
            )

            if let exhaustedError = creditsExhaustedError, exhaustedError.isCreditsExhausted {
                CreditsExhaustedBanner(
                    onAddFunds: { onAddFunds?() }
                )
                .frame(maxWidth: VSpacing.chatColumnMaxWidth - 2 * VSpacing.xl)
                .frame(maxWidth: .infinity)
                .padding(.bottom, -VSpacing.sm)
            }

            if let _ = providerNotConfiguredError {
                MissingApiKeyBanner(
                    onOpenSettings: { onOpenModelsAndServices?() },
                    onDismiss: { onDismissProviderNotConfigured?() }
                )
                .frame(maxWidth: VSpacing.chatColumnMaxWidth - 2 * VSpacing.xl)
                .frame(maxWidth: .infinity)
                .padding(.bottom, -VSpacing.sm)
            }

            if isReadonly {
                HStack(spacing: VSpacing.xs) {
                    VIconView(.eye, size: 14)
                    Text("Read-only conversation")
                        .font(VFont.bodySmallDefault)
                }
                .foregroundStyle(VColor.contentTertiary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, VSpacing.md)
            } else {
                ComposerSection(
                    inputText: $inputText,
                    isSending: isSending,
                    isAssistantBusy: isAssistantBusy,
                    hasPendingConfirmation: activePendingRequestId != nil,
                    onAllowPendingConfirmation: {
                        if let requestId = activePendingRequestId {
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
        if let btwText = btwResponse {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                HStack {
                    Text("/btw")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                    Spacer()
                    Button(action: { onDismissBtw?() }) {
                        VIconView(.x, size: 12)
                            .foregroundStyle(VColor.contentTertiary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Dismiss btw response")
                }

                if btwLoading && btwText.isEmpty {
                    Text("Thinking...")
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentTertiary)
                } else if !btwLoading && btwText.isEmpty {
                    Text("No response received.")
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentTertiary)
                } else {
                    Text(btwText)
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentDefault)
                        .textSelection(.enabled)
                }

                if !btwLoading {
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
            onDropFiles: onDropFiles,
            onDropImageData: onDropImageData,
            onDropStarted: onDropStarted,
            onDropEnded: onDropEnded,
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

/// Propagates the chat container's measured width up to ChatView so it can
/// forward it to MessageListView for resize-aware scroll stabilization.
private struct ChatContainerWidthKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

