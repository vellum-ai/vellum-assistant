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
    // MARK: - Scroll State

    /// Native SwiftUI scroll position. Initialized to `.bottom` so the first
    /// layout starts at the bottom of the content.
    /// https://developer.apple.com/documentation/swiftui/scrollposition
    @State var scrollPosition = ScrollPosition(edge: .bottom)
    /// Tracks whether the viewport is within 30pt of the content bottom.
    /// Updated by `onScrollGeometryChange` — fires only on Bool transitions,
    /// not every geometry tick (~2 fires per scroll session vs ~120fps).
    /// https://developer.apple.com/documentation/swiftui/view/onscrollgeometrychange(for:of:action:)
    @State var isAtBottom: Bool = true
    /// Captures the first visible message ID before a pagination load so
    /// position can be restored after new items are prepended.
    @State var topVisibleMessageId: UUID? = nil
    /// True while a previous-page pagination load is in flight.
    @State var isLoadingMore: Bool = false

    // MARK: - Auxiliary State

    /// Non-observable projection cache for derived transcript state.
    /// Kept off the SwiftUI observation graph to avoid "Modifying state
    /// during view update" warnings during body evaluation memoization.
    @State var projectionCache = ProjectionCache()
    /// Tracks the last conversation ID to detect conversation switches.
    @State var lastConversationId: UUID? = nil
    /// Tracks the last auto-focused confirmation request ID to avoid
    /// re-focusing the same confirmation bubble.
    @State var lastAutoFocusedRequestId: String? = nil
    /// In-flight highlight dismiss task; cancelled on conversation switch.
    @State var highlightDismissTask: Task<Void, Never>? = nil
    /// In-flight anchor timeout task.
    @State var anchorTimeoutTask: Task<Void, Never>? = nil
    /// Timestamp when the anchor was set (for pagination exhaustion guard).
    @State var anchorSetTime: Date? = nil
    /// Tracks the last chat column width to detect real resizes.
    @State var lastHandledChatColumnWidth: CGFloat = 0
    /// In-flight resize scroll stabilization task; cancelled on each new resize.
    @State var resizeScrollTask: Task<Void, Never>?
    /// In-flight pagination load task; cancelled on conversation switch.
    @State var paginationTask: Task<Void, Never>?
    /// Tracks the viewport height for the turnMinHeight calculation.
    @State var viewportHeight: CGFloat = .infinity

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
            // layout pass, causing 34-70s hangs.
            ScrollView {
                HStack(spacing: 0) {
                    Spacer(minLength: 0)
                    scrollViewContent
                        .frame(width: widths.chatColumnWidth)
                    Spacer(minLength: 0)
                }
                .frame(width: widths.scrollSurfaceWidth)
            }
            .scrollContentBackground(.hidden)
            .scrollDisabled(messages.isEmpty && !isSending)
            // Apply only to .initialOffset — where the scroll view starts
            // when first displayed (including .id() recreation on switch).
            // Deliberately NOT using the all-roles overload (.sizeChanges)
            // because it would auto-scroll on every content height change
            // during streaming — the exact behavior this redesign removes.
            // https://developer.apple.com/documentation/swiftui/view/defaultscrollanchor(_:for:)
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .scrollPosition($scrollPosition)
            .environment(\.suppressAutoScroll, {
                // No-op: auto-scroll has been removed. Child views
                // (AssistantProgressView) still call this environment
                // action during manual expansion; the call is harmless.
            })
            // --- Bottom detection ---
            // Returns Bool so the action fires only on enter/leave transitions
            // (~2 fires per scroll session), not on every geometry tick (~120fps).
            .onScrollGeometryChange(for: Bool.self) { geo in
                let dist = geo.contentSize.height
                    - geo.contentOffset.y
                    - geo.visibleRect.height
                return dist < 30
            } action: { _, atBottom in
                withAnimation(.easeInOut(duration: 0.2)) {
                    isAtBottom = atBottom
                }
            }
            // --- Viewport height tracking ---
            .onScrollGeometryChange(for: CGFloat.self) { geo in
                geo.visibleRect.height
            } action: { _, newHeight in
                viewportHeight = newHeight
            }
            // --- Pagination trigger ---
            // Rising-edge detection: fires only on transition from
            // not-near-top to near-top, preventing repeated loads.
            .onScrollGeometryChange(for: Bool.self) { geo in
                geo.contentOffset.y < 200
            } action: { wasNearTop, isNearTop in
                if isNearTop && !wasNearTop {
                    handlePaginationTrigger()
                }
            }
            .id(conversationId)
            .frame(width: widths.scrollSurfaceWidth)
            .overlay(alignment: .bottom) {
                ScrollToLatestOverlayView(
                    isAtBottom: isAtBottom,
                    onScrollToLatest: {
                        withAnimation(.easeInOut(duration: 0.3)) {
                            scrollPosition.scrollTo(id: "scroll-bottom-anchor", anchor: .bottom)
                        }
                    }
                )
            }
            .onAppear {
                handleAppear()
            }
            .onDisappear {
                // Do NOT clear scrollPosition here. The old ScrollView's
                // onDisappear fires AFTER the new ScrollView's onAppear.
                // Since both share the same @State var scrollPosition (the
                // .id() modifier is on ScrollView, not MessageListView),
                // clearing here overwrites the new ScrollView's initial
                // position.
                resizeScrollTask?.cancel()
                resizeScrollTask = nil
                paginationTask?.cancel()
                paginationTask = nil
                highlightDismissTask?.cancel()
                highlightDismissTask = nil
                anchorTimeoutTask?.cancel()
                anchorTimeoutTask = nil
                highlightedMessageId = nil
            }
            .onChange(of: isSending) {
                handleSendingChanged()
            }
            .onChange(of: messages.count) {
                handleMessagesCountChanged()
            }
            .onChange(of: containerWidth) { handleContainerWidthChanged() }
            .onChange(of: conversationId) {
                if lastConversationId != conversationId,
                   conversationId != nil {
                    handleConversationSwitched()
                }
            }
            .onChange(of: activePendingRequestId) {
                #if os(macOS)
                handleConfirmationFocusIfNeeded()
                #endif
            }
            .task(id: anchorMessageId) { await handleAnchorMessageTask() }
            .onReceive(NotificationCenter.default.publisher(for: NSWindow.didBecomeKeyNotification)) { notification in
                if let requestId = activePendingRequestId, lastAutoFocusedRequestId != requestId,
                   let window = notification.object as? NSWindow,
                   window === NSApp.keyWindow,
                   let responder = window.firstResponder as? NSTextView,
                   responder.isEditable {
                    window.makeFirstResponder(nil)
                    lastAutoFocusedRequestId = requestId
                }
            }
    }

    // MARK: - Pagination

    func handlePaginationTrigger() {
        guard hasMoreMessages, !isLoadingMore else { return }
        let startConversationId = conversationId
        topVisibleMessageId = paginatedVisibleMessages.first?.id
        isLoadingMore = true
        paginationTask?.cancel()
        paginationTask = Task {
            _ = await loadPreviousMessagePage?()
            guard !Task.isCancelled, conversationId == startConversationId else {
                isLoadingMore = false
                return
            }
            isLoadingMore = false
            if let anchorId = topVisibleMessageId {
                try? await Task.sleep(nanoseconds: 100_000_000)
                guard !Task.isCancelled, conversationId == startConversationId else { return }
                scrollPosition.scrollTo(id: anchorId, anchor: .top)
            }
        }
    }
}
