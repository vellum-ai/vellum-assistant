import AppKit
import Combine
import os
import os.signpost
import SwiftUI
import VellumAssistantShared

struct MessageListView: View {

    let messages: [ChatMessage]
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
    /// Measured width of the chat container, used to detect sidebar/split resizes
    /// and stabilize scroll position during layout width changes.
    /// When false, disables interactive controls (buttons, actions) inside the
    /// message list while keeping scrolling and text selection functional.
    var isInteractionEnabled: Bool = true
    var containerWidth: CGFloat = 0
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
    /// Pure policy coordinator that models scroll decisions. All scroll
    /// policy flows through this coordinator's `handle(_:)` method; the
    /// resulting output intents are translated into concrete `scrollState`
    /// / `ScrollPosition` mutations by the view layer.
    @State var scrollCoordinator = ScrollCoordinator()
    /// In-flight resize scroll stabilization task; cancelled on each new resize.
    @State var resizeScrollTask: Task<Void, Never>?
    /// Native SwiftUI scroll position struct (macOS 15+). Replaces
    /// `ScrollViewReader` + `proxy.scrollTo()` and distance-from-bottom math.
    @State var scrollPosition = ScrollPosition()

    // MARK: - Body

    var body: some View {
        #if DEBUG
        let _ = os_signpost(.event, log: PerfSignposts.log, name: "MessageListView.body")
        #endif
            // .frame(width:) creates _FrameLayout (not _FlexFrameLayout). FrameLayout
            // returns bounds.midX for alignment without querying children, stopping the
            // alignment cascade. The old .frame(maxWidth:) pattern created FlexFrameLayout
            // which queried explicitAlignment on the entire LazyVStack subtree — O(n) per
            // layout pass, causing 34-70s hangs. See AGENTS.md.
            ScrollView {
                scrollViewContent
                    .background(
                        MessageListScrollObserver { newState in
                            enqueueScrollGeometryUpdate(newState)
                        }
                    )
            }
            .scrollContentBackground(.hidden)
            .scrollDisabled(messages.isEmpty && !isSending)
            // Apply only to .initialOffset — where the scroll view starts
            // when first displayed (including .id() recreation on switch).
            // Deliberately NOT using the all-roles overload (.sizeChanges)
            // because it fights user scroll-up during streaming: SwiftUI's
            // definition of "at bottom" for anchor purposes can differ from
            // our hysteresis-based isAtBottom, causing the viewport to snap
            // back to bottom on every content-height change even after the
            // user has entered freeBrowsing. Our explicit content-height
            // auto-follow handles streaming growth with proper mode checks.
            // https://developer.apple.com/documentation/swiftui/view/defaultscrollanchor(_:for:)
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .scrollPosition($scrollPosition)
            .environment(\.suppressAutoScroll, { [self] in
                os_signpost(.event, log: PerfSignposts.log, name: "scrollSuppressionChanged", "on reason=manualExpansionDetach")
                let intents = scrollCoordinator.handle(.manualExpansion)
                executeCoordinatorIntents(intents)
                // Keep scrollState in sync as runtime executor.
                scrollState.handleManualExpansionInteraction()
            })
            .onScrollPhaseChange { oldPhase, newPhase in
                let coordinatorPhase = ScrollCoordinator.Phase.from(newPhase)
                let intents = scrollCoordinator.handle(.scrollPhaseChanged(phase: coordinatorPhase))
                executeCoordinatorIntents(intents)
                // Keep scrollState in sync as runtime executor.
                scrollState.scrollPhase = newPhase
                if newPhase == .idle && oldPhase != .idle && scrollState.isAtBottom {
                    scrollState.handleReachedBottom()
                }
            }
            .scrollIndicators(scrollState.scrollIndicatorsHidden ? .hidden : .automatic)
            .id(conversationId)
            .frame(width: containerWidth > 0 ? min(containerWidth, VSpacing.chatColumnMaxWidth) : VSpacing.chatColumnMaxWidth)
            .overlay(alignment: .bottom) {
                ScrollToLatestOverlayView(scrollState: scrollState)
            }
            .onAppear {
                let intents = scrollCoordinator.handle(.appeared)
                executeCoordinatorIntents(intents)
                handleAppear()
            }
            .onDisappear {
                scrollCoordinator.reset()
                scrollState.cancelAll()
                resizeScrollTask?.cancel()
                resizeScrollTask = nil
                highlightedMessageId = nil
            }
            .onChange(of: isSending) {
                let intents = scrollCoordinator.handle(.sendingChanged(isSending: isSending))
                executeCoordinatorIntents(intents)
                handleSendingChanged()
            }
            .onChange(of: messages.count) {
                let intents = scrollCoordinator.handle(.messageCountChanged)
                executeCoordinatorIntents(intents)
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
