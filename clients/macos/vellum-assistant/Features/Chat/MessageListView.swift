import AppKit
import Combine
import os
import os.signpost
import SwiftUI
import VellumAssistantShared

struct MessageListView: View {

    let messages: [ChatMessage]
    let messagesRevision: UInt64
    let isSending: Bool
    let isThinking: Bool
    let isCompacting: Bool
    let assistantActivityPhase: String
    let assistantActivityAnchor: String
    let assistantActivityReason: String?
    let assistantStatusText: String?
    let selectedModel: String
    let configuredProviders: Set<String>
    let providerCatalog: [ProviderCatalogEntry]
    let activeSubagents: [SubagentInfo]
    let dismissedDocumentSurfaceIds: Set<String>
    var onConfirmationAllow: ((String) -> Void)?
    var onConfirmationDeny: ((String) -> Void)?
    var onAlwaysAllow: ((String, String, String, String) -> Void)?
    /// Called when a temporary approval option is selected: (requestId, decision).
    var onTemporaryAllow: ((String, String) -> Void)?
    var onSurfaceAction: ((String, String, [String: AnyCodable]?) -> Void)?
    /// Called when a guardian decision action button is clicked: (requestId, action).
    var onGuardianAction: ((String, String) -> Void)?
    let onDismissDocumentWidget: ((String) -> Void)?
    var onForkFromMessage: ((String) -> Void)? = nil
    var showInspectButton: Bool = false
    var isTTSEnabled: Bool = false
    var onInspectMessage: ((String?) -> Void)?
    let mediaEmbedSettings: MediaEmbedResolverSettings?
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
    /// Pre-computed active pending confirmation request ID from the model layer.
    var activePendingRequestId: String?

    // MARK: - Pagination

    /// Pre-computed paginated visible messages from the model layer.
    /// Cached as a stored property on `ChatPaginationState` and updated
    /// reactively via Combine, so reading this in `body` is O(1).
    let paginatedVisibleMessages: [ChatMessage]
    /// Number of messages the view currently displays (suffix window size).
    var displayedMessageCount: Int = .max
    /// Whether older messages exist beyond the current display window.
    var hasMoreMessages: Bool = false
    /// True while a previous-page load is in progress.
    var isLoadingMoreMessages: Bool = false
    /// Callback to load the next older page of messages.
    var loadPreviousMessagePage: (() async -> Bool)?

    var conversationId: UUID?
    /// When set, scroll to this message ID and clear the binding.
    /// Used by notification deep links to anchor the view to a specific message.
    @Binding var anchorMessageId: UUID?
    /// Message ID to visually highlight after an anchor scroll completes.
    @Binding var highlightedMessageId: UUID?
    /// When false, disables interactive controls (buttons, actions) inside the
    /// message list while keeping scrolling and text selection functional.
    var isInteractionEnabled: Bool = true
    /// Measured width of the full chat pane. `layoutMetrics` derives the
    /// centered transcript column width from this value.
    var containerWidth: CGFloat = 0
    /// Stable height of the full chat pane (from GeometryReader). Unlike
    /// scroll viewport height, this doesn't fluctuate when the composer resizes.
    var containerHeight: CGFloat = 0
    var layoutMetrics: MessageListLayoutMetrics {
        MessageListLayoutMetrics(containerWidth: containerWidth)
    }
    /// Cached in `@State` to avoid `UserDefaults` IPC on every view body
    /// evaluation. Seeded once from `UserDefaults` when SwiftUI first creates
    /// the state; persisted back in `handleSendingChanged()` when flipped.
    @State var hasEverSentMessage: Bool = UserDefaults.standard.bool(forKey: "hasEverSentMessage")
    @State var appearance = AvatarAppearanceManager.shared
    @ObservedObject var typographyObserver = VFont.typographyObserver
    /// Read at the list level and passed down to each ChatBubble so that
    /// individual bubbles don't each subscribe to the shared manager.
    /// With @Observable fine-grained tracking, reading only `activeSurfaceId`
    /// won't trigger re-renders on frequent `data` progress ticks.
    var taskProgressManager = TaskProgressOverlayManager.shared
    /// Consolidates all scroll-related state with `@Observable` fine-grained
    /// per-property tracking. Each UI-facing property (`showScrollToLatest`,
    /// `scrollIndicatorsHidden`) is individually tracked, so SwiftUI only
    /// re-evaluates views that read the specific property that changed.
    /// See `MessageListScrollState.swift` for details.
    @State var scrollState = MessageListScrollState()
    /// Preserves thinking-block expanded/collapsed state across the
    /// start/end of an active turn. See `ThinkingBlockExpansionStore.swift`.
    @State var thinkingBlockExpansionStore = ThinkingBlockExpansionStore()
    /// Owned here (same level as `thinkingBlockExpansionStore`) so the state
    /// survives view-tree destruction. See `FilePreviewExpansionStore.swift`.
    @State var filePreviewExpansionStore = FilePreviewExpansionStore()
    /// In-flight resize scroll stabilization task; cancelled on each new resize.
    @State var resizeScrollTask: Task<Void, Never>?
    /// Native SwiftUI scroll position struct (macOS 15+). Replaces
    /// `ScrollViewReader` + `proxy.scrollTo()` and distance-from-bottom math.
    @State var scrollPosition = ScrollPosition()
    /// Starts false on fresh mount; set to true after scroll restore settles.
    /// Hides the scroll view during the restore window to prevent jitter.
    @State var isScrollRestored = false

    // MARK: - Body

    var body: some View {
        #if DEBUG
        let _ = os_signpost(.event, log: PerfSignposts.log, name: "MessageListView.body")
        #endif
            let widths = layoutMetrics
            // .frame(width:) creates _FrameLayout (not _FlexFrameLayout). FrameLayout
            // returns bounds.midX for alignment without querying children, stopping the
            // alignment cascade. The old .frame(maxWidth:) pattern created FlexFrameLayout
            // which queried explicitAlignment on the entire LazyVStack subtree — O(n) per
            // layout pass, causing 34-70s hangs. See AGENTS.md.
            ScrollView {
                HStack(spacing: 0) {
                    Spacer(minLength: 0)
                    scrollViewContent
                        .frame(width: widths.chatColumnWidth)
                        .background(
                            MessageListScrollObserver { newState in
                                enqueueScrollGeometryUpdate(newState)
                            }
                        )
                    Spacer(minLength: 0)
                }
                .frame(width: widths.scrollSurfaceWidth)
            }
            .scrollContentBackground(.hidden)
            .scrollDisabled(messages.isEmpty && !isSending)
            .defaultScrollAnchor(.top, for: .initialOffset)
            .scrollPosition($scrollPosition)
            .environment(\.thinkingBlockExpansionStore, thinkingBlockExpansionStore)
            .environment(\.filePreviewExpansionStore, filePreviewExpansionStore)
            .scrollIndicators(scrollState.scrollIndicatorsHidden ? .hidden : .automatic)
            .frame(width: widths.scrollSurfaceWidth)
            .opacity(isScrollRestored ? 1 : 0)
            .overlay(alignment: .bottom) {
                ScrollToLatestOverlayView(scrollState: scrollState, onScrollToBottom: { scrollPosition = ScrollPosition(edge: .bottom) })
            }
            .onAppear {
                handleAppear()
            }
            .onDisappear {
                scrollState.cancelAll()
                resizeScrollTask?.cancel()
                resizeScrollTask = nil
                highlightedMessageId = nil
            }
            .onChange(of: isSending) {
                handleSendingChanged()
            }
            .onChange(of: messages.count) {
                handleMessagesCountChanged()
            }
            .onChange(of: containerWidth) { handleContainerWidthChanged() }
            .onChange(of: activePendingRequestId) {
                #if os(macOS)
                handleConfirmationFocusIfNeeded()
                #endif
            }
            .task(id: anchorMessageId) { await handleAnchorMessageTask() }
            .onReceive(NotificationCenter.default.publisher(for: NSWindow.didBecomeKeyNotification)) { notification in
                if let requestId = activePendingRequestId, scrollState.lastAutoFocusedRequestId != requestId,
                   let window = notification.object as? NSWindow,
                   window === NSApp.keyWindow,
                   let responder = window.firstResponder as? NSTextView,
                   responder.isEditable {
                    window.makeFirstResponder(nil)
                    scrollState.lastAutoFocusedRequestId = requestId
                }
            }
    }
}
