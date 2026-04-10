import AppKit
import Combine
import os
import os.signpost
import SwiftUI
import VellumAssistantShared

private let scrollDiag = Logger(subsystem: Bundle.appBundleIdentifier, category: "ScrollDiag")

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
    // MARK: - Scroll state (simplified)

    /// Native SwiftUI scroll position (macOS 15+).
    @State var scrollPosition = ScrollPosition()
    /// Whether the viewport is within the bottom dead-zone.
    /// Uses asymmetric hysteresis (30pt leave, 10pt enter) via
    /// `onScrollGeometryChange` to prevent oscillation.
    @State var isAtBottom: Bool = true
    /// Measured viewport height from `onScrollGeometryChange`.
    /// Passed to `MessageListContentView` for the active-turn
    /// `minHeight` calculation.
    @State var viewportHeight: CGFloat = .infinity
    /// Non-observable cache for derived-state memoization.
    @State var projectionCache = ProjectionCache()
    /// Tracks which conversation is currently displayed, so lifecycle
    /// handlers can detect conversation switches.
    @State var currentConversationId: UUID?

    // MARK: - Pagination state

    @State var wasPaginationTriggerInRange: Bool = false
    @State var isPaginationInFlight: Bool = false
    @State var lastPaginationCompletedAt: Date = .distantPast
    @State var paginationTask: Task<Void, Never>?

    // MARK: - Anchor / highlight state

    @State var highlightDismissTask: Task<Void, Never>?
    @State var anchorTimeoutTask: Task<Void, Never>?
    @State var anchorSetTime: Date?

    // MARK: - Misc view-local state

    @State var lastAutoFocusedRequestId: String?
    @State var lastActivityPhaseWhenIdle: String = ""
    @State var lastHandledChatColumnWidth: CGFloat = 0
    @State var resizeScrollTask: Task<Void, Never>?
    @State var scrollRestoreTask: Task<Void, Never>?

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
                    Spacer(minLength: 0)
                }
                .frame(width: widths.scrollSurfaceWidth)
            }
            .scrollContentBackground(.hidden)
            .scrollDisabled(messages.isEmpty && !isSending)
            // Position at bottom on first display (including .id() recreation
            // on conversation switch). Scoped to .initialOffset only — NOT
            // .sizeChanges, which would fight user scroll-up by snapping back
            // to bottom on every content-height change.
            // https://developer.apple.com/documentation/swiftui/view/defaultscrollanchor(_:for:)
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .scrollPosition($scrollPosition)
            // --- Bottom detection via onScrollGeometryChange ---
            // Returns a BottomDetection struct with two thresholds so the
            // action closure can apply asymmetric hysteresis (30pt leave,
            // 10pt enter) without reading @State inside the transform.
            // The Bool-pair means the action fires at most a few times per
            // scroll session — not on every frame.
            .onScrollGeometryChange(for: BottomDetection.self) { geometry in
                let distance = geometry.contentSize.height
                    - geometry.contentOffset.y
                    - geometry.visibleRect.height
                return BottomDetection(
                    nearBottom: distance.isFinite && distance <= 30,
                    atBottom: distance.isFinite && distance <= 10
                )
            } action: { _, detection in
                if isAtBottom {
                    if !detection.nearBottom {
                        withAnimation(VAnimation.spring) { isAtBottom = false }
                    }
                } else {
                    if detection.atBottom {
                        withAnimation(VAnimation.spring) { isAtBottom = true }
                    }
                }
            }
            // --- Viewport height tracking ---
            .onScrollGeometryChange(for: CGFloat.self) { geometry in
                geometry.visibleRect.height
            } action: { _, newHeight in
                guard newHeight.isFinite else { return }
                if abs(newHeight - viewportHeight) > 0.5 {
                    viewportHeight = newHeight
                }
            }
            // --- Pagination trigger ---
            .onScrollGeometryChange(for: Bool.self) { geometry in
                let sentinelMinY = -geometry.contentOffset.y
                return MessageListPaginationTriggerPolicy.isInTriggerBand(
                    sentinelMinY: sentinelMinY,
                    viewportHeight: geometry.visibleRect.height
                )
            } action: { wasInRange, isInRange in
                wasPaginationTriggerInRange = isInRange
                guard isInRange && !wasInRange else { return }
                triggerPagination()
            }
            .scrollIndicators(.automatic)
            .id(conversationId)
            .frame(width: widths.scrollSurfaceWidth)
            .overlay(alignment: .bottom) {
                ScrollToLatestOverlayView(
                    isAtBottom: isAtBottom,
                    onScrollToLatest: { scrollToBottom(animated: true) }
                )
            }
            .onAppear { handleAppear() }
            .onDisappear {
                // Do NOT clear scrollPosition here. The old ScrollView's
                // onDisappear fires AFTER the new ScrollView's onAppear
                // (confirmed by diagnostic logs: 10-225ms delay). Clearing
                // here overwrites the scrollTo(edge: .bottom) that
                // handleConversationSwitched() just issued.
                let convStr = conversationId?.uuidString ?? "nil"
                scrollDiag.debug("onDisappear: leaving conv=\(convStr, privacy: .public)")
                resizeScrollTask?.cancel()
                resizeScrollTask = nil
                paginationTask?.cancel()
                paginationTask = nil
                anchorTimeoutTask?.cancel()
                anchorTimeoutTask = nil
                highlightDismissTask?.cancel()
                highlightDismissTask = nil
                scrollRestoreTask?.cancel()
                scrollRestoreTask = nil
                highlightedMessageId = nil
            }
            .onChange(of: isSending) { handleSendingChanged() }
            .onChange(of: messages.count) { handleMessagesCountChanged() }
            .onChange(of: containerWidth) { handleContainerWidthChanged() }
            .onChange(of: conversationId) {
                // Safety net for rapid conversation switching. onChange fires
                // synchronously on every conversationId change, guaranteeing
                // handleConversationSwitched() runs even when SwiftUI
                // coalesces .id() lifecycle events during rapid switching.
                if currentConversationId != conversationId,
                   conversationId != nil {
                    let oldConv = currentConversationId?.uuidString ?? "nil"
                    let newConv = conversationId?.uuidString ?? "nil"
                    scrollDiag.debug("onChange(conversationId): detected switch old=\(oldConv, privacy: .public) new=\(newConv, privacy: .public)")
                    currentConversationId = conversationId
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
}
