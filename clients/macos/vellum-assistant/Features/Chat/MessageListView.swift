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
    /// Callback invoked by the "Scroll to latest" CTA to reset the sliding
    /// pagination window to the newest slice before the scroll executes.
    var onSnapWindowToLatest: (() -> Void)?

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
    /// Caches each transcript row's measured height so the LazyVStack reports
    /// an accurate `contentSize` for off-screen cells. Gated on the
    /// `message-height-cache` macOS feature flag. Reset on conversation
    /// switch (via `.id(conversationId)`), column-width change, and
    /// typography-generation change.
    @State var messageHeightCache = MessageHeightCache()
    /// In-flight resize scroll stabilization task; cancelled on each new resize.
    @State var resizeScrollTask: Task<Void, Never>?
    /// Filtered viewport height used by the latest-turn spacer layout.
    /// Only viewport changes feed the content view — scroll offset and content
    /// height stay out of the layout diff path.
    @State var viewportHeight: CGFloat = .infinity
    /// Native SwiftUI scroll position struct (macOS 15+). Replaces
    /// `ScrollViewReader` + `proxy.scrollTo()` and distance-from-bottom math.
    @State var scrollPosition = ScrollPosition()

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
                            MessageListScrollObserver(
                                onGeometryChange: { newState in
                                    enqueueScrollGeometryUpdate(newState)
                                },
                                shouldPreserveScrollAnchor: { [scrollState] in
                                    // Skip during pagination — the explicit
                                    // scroll-to-anchor in `handlePaginationSentinel`
                                    // is the source of truth for that flow, and
                                    // shifting the offset to absorb the older
                                    // page's height would race the snap.
                                    !scrollState.isPaginationInFlight
                                },
                                onAnchorShift: { [scrollState] in
                                    // Debug-only counter for anchor-preserver
                                    // activations. Flag-gated so the hot path
                                    // pays nothing when the overlay is off.
                                    guard MacOSClientFeatureFlagManager.shared.isEnabled("scroll-debug-overlay") else { return }
                                    scrollState.recordDebugAnchorShift()
                                },
                                onAnchorDecision: { [scrollState] event in
                                    // Debug-only full-decision log. Captures
                                    // skips (shrinks, live-scroll gate, etc.)
                                    // plus applies, with pre/post offsets.
                                    guard MacOSClientFeatureFlagManager.shared.isEnabled("scroll-debug-overlay") else { return }
                                    scrollState.recordAnchorDecision(event)
                                }
                            )
                        )
                    Spacer(minLength: 0)
                }
                .frame(width: widths.scrollSurfaceWidth)
                // In the inverted scroll, short content gravity-pulls to the
                // visual bottom. Pin it to the pre-flip bottom (= visual top)
                // so the first message always starts at the top of the viewport.
                // Uses Layout protocol instead of .frame(minHeight:alignment:)
                // to avoid _FlexFrameLayout's O(n × depth) explicitAlignment
                // cascade through the entire LazyVStack subtree.
                .bottomAlignedMinHeight(viewportHeight.isFinite ? viewportHeight : nil)
            }
            .scrollContentBackground(.hidden)
            .scrollDisabled(messages.isEmpty && !isSending)
            .scrollPosition($scrollPosition)
            .environment(\.thinkingBlockExpansionStore, thinkingBlockExpansionStore)
            .environment(\.filePreviewExpansionStore, filePreviewExpansionStore)
            .environment(\.messageHeightCache, messageHeightCache)
            .scrollIndicators(scrollState.scrollIndicatorsHidden ? .hidden : .automatic)
            .frame(width: widths.scrollSurfaceWidth)
            .id(conversationId)
            .flipped()  // Invert the scroll — visual bottom becomes natural top
            .overlay(alignment: .bottom) {
                // Inverted scroll: SwiftUI's .top edge maps to the visual bottom
                // (latest messages), so we scroll to .top to reach them.
                ScrollToLatestOverlayView(scrollState: scrollState, onScrollToBottom: {
                    // Reset the sliding window to the latest slice before
                    // scrolling so the CTA always lands on the actual newest
                    // messages — not the newest message that happened to be
                    // in the previously anchored window. No-op when the
                    // window is already pinned to latest.
                    onSnapWindowToLatest?()
                    scrollPosition = ScrollPosition(edge: .top)
                })
            }
            .overlay(alignment: .topTrailing) {
                ScrollDebugOverlayView(scrollState: scrollState)
                    .padding(.top, VSpacing.sm)
                    .padding(.trailing, VSpacing.md)
            }
            .onAppear {
                handleAppear()
            }
            .onDisappear {
                scrollState.cancelAll()
                resizeScrollTask?.cancel()
                resizeScrollTask = nil
                viewportHeight = .infinity
                highlightedMessageId = nil
            }
            .onChange(of: isSending) {
                handleSendingChanged()
            }
            .onChange(of: messages.count) {
                handleMessagesCountChanged()
            }
            .onChange(of: messagesRevision) {
                handleMessagesRevisionChanged()
            }
            .onChange(of: containerWidth) { handleContainerWidthChanged() }
            .onChange(of: layoutMetrics.chatColumnWidth) {
                // Column-width changes re-flow every row, so the cached
                // heights are stale. Resetting here lets the next render
                // repopulate with the new measurements.
                messageHeightCache.reset()
            }
            .onChange(of: typographyObserver.generation) {
                // Typography changes (font size, line spacing) resize every
                // row. Same rationale as chat-column-width changes.
                messageHeightCache.reset()
            }
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
