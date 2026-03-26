import AppKit
import Combine
import os
import SwiftUI
import VellumAssistantShared

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "MessageListView")
private let stallLog = OSLog(subsystem: "com.vellum.assistant", category: "LayoutStall")

// MARK: - Scroll Suppression Environment

/// Environment key that child views (e.g. AssistantProgressView) call to
/// temporarily suppress auto-scroll-to-bottom during content expansion.
private struct SuppressAutoScrollKey: EnvironmentKey {
    static let defaultValue: (() -> Void)? = nil
}

extension EnvironmentValues {
    var suppressAutoScroll: (() -> Void)? {
        get { self[SuppressAutoScrollKey.self] }
        set { self[SuppressAutoScrollKey.self] = newValue }
    }
}

/// Holds scroll-related tracking values that must persist across body
/// evaluations but must NOT trigger SwiftUI re-renders when updated.
/// These values serve as dead-zone guards and smoothing state — they
/// are never read during body evaluation for rendering purposes.
/// Pattern mirrors non-reactive properties on the coordinator (not @Published).
@MainActor final class ScrollTrackingState {

    // MARK: - Layout Metadata Cache

    /// Cache key for the last computed `CachedMessageLayoutMetadata`.
    var cachedLayoutKey: PrecomputedCacheKey?
    /// Cached structural metadata, returned on cache hit.
    var cachedLayoutMetadata: CachedMessageLayoutMetadata?

    // MARK: - Version Counter (O(1) fingerprint replacement)

    /// Monotonically increasing counter that replaces the O(n) per-body-eval
    /// `computeMessageFingerprint()` hash. Incremented when any of the following
    /// triggers fire:
    /// - raw `messages.count` changes (new message appended, deletion, or
    ///   pagination load — also catches paginated-window shifts)
    /// - visible message count changes (hidden/subagent visibility transitions)
    /// - `isSending` or `isThinking` transitions (activity state change)
    /// - `visibleMessages.last?.isStreaming` transitions (end of streaming)
    /// - A tool call's `isComplete` transitions (observable via messages array
    ///   identity change in SwiftUI)
    ///
    /// Over-invalidation is safe (triggers a recompute); under-invalidation is not.
    var messageListVersion: Int = 0

    /// Cached raw (unfiltered) message count. Detects new arrivals,
    /// deletions, and pagination loads — including cases where the
    /// paginated visible window shifts at a fixed size.
    var lastKnownRawMessageCount: Int = 0
    /// Cached visible (paginated) message count. Detects changes in
    /// message visibility (hidden/subagent transitions) that don't
    /// alter the raw count.
    var lastKnownVisibleMessageCount: Int = 0
    /// Cached streaming state of the last visible message.
    var lastKnownLastMessageStreaming: Bool = false
    /// Cached count of incomplete tool calls across visible messages.
    var lastKnownIncompleteToolCallCount: Int = 0

    // MARK: - Scroll Geometry (non-reactive, updated every scroll tick)

    /// Content height from scroll geometry, used to guard against false
    /// detaches on short conversations that can't scroll.
    var scrollContentHeight: CGFloat = 0
    /// Container (viewport) height from scroll geometry, used alongside
    /// scrollContentHeight to determine if content is scrollable.
    var scrollContainerHeight: CGFloat = 0
    /// Last content offset Y observed by onScrollGeometryChange, used to
    /// determine scroll direction (increasing offset = scrolling toward older content).
    var lastScrollContentOffsetY: CGFloat = 0
}

/// Lightweight key that captures all inputs to `precomputedState`.
/// All fields are O(1) to compare. The `messageListVersion` counter
/// replaces the former O(n) hash-based fingerprint — it is incremented
/// by `onChange` handlers when structural or content changes occur.
struct PrecomputedCacheKey: Equatable {
    let messageListVersion: Int
    let isSending: Bool
    let isThinking: Bool
    let isCompacting: Bool
    let assistantStatusText: String?
    let activeSubagentFingerprint: Int
    let displayedMessageCount: Int
}

/// Lightweight snapshot of scroll geometry for the onScrollGeometryChange
/// handler. Captures values needed for scroll-direction detection,
/// scrollable-content detection, and viewport height tracking.
private struct ScrollGeometrySnapshot: Equatable {
    let contentOffsetY: CGFloat
    let contentHeight: CGFloat
    let containerHeight: CGFloat
    let visibleRectHeight: CGFloat
}

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
    let onConfirmationAllow: (String) -> Void
    let onConfirmationDeny: (String) -> Void
    let onAlwaysAllow: (String, String, String, String) -> Void
    /// Called when a temporary approval option is selected: (requestId, decision).
    var onTemporaryAllow: ((String, String) -> Void)?
    let onSurfaceAction: (String, String, [String: AnyCodable]?) -> Void
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

    // MARK: - Pagination

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
    @Binding var isNearBottom: Bool
    /// Measured width of the chat container, used to detect sidebar/split resizes
    /// and stabilize scroll position during layout width changes.
    var containerWidth: CGFloat = 0
    @AppStorage("hasEverSentMessage") private var hasEverSentMessage: Bool = false
    @AppStorage("completedConversationCount") private var completedConversationCount: Int = 0
    @State private var identity: IdentityInfo? = IdentityInfo.load()
    @State private var appearance = AvatarAppearanceManager.shared
    /// Read at the list level and passed down to each ChatBubble so that
    /// individual bubbles don't each subscribe to the shared manager.
    /// With @Observable fine-grained tracking, reading only `activeSurfaceId`
    /// won't trigger re-renders on frequent `data` progress ticks.
    var taskProgressManager = TaskProgressOverlayManager.shared
    /// Consolidates all scroll-related state: anchor tracking, scroll loop guard,
    /// bottom pin coordinator, suppression flags, and scroll-related tasks.
    @StateObject private var scrollCoordinator = MessageListScrollCoordinator()
    /// In-flight resize scroll stabilization task; cancelled on each new resize.
    @State private var resizeScrollTask: Task<Void, Never>?
    /// Native SwiftUI scroll position struct (macOS 15+). Replaces
    /// `ScrollViewReader` + `proxy.scrollTo()` and distance-from-bottom math.
    @State private var scrollPosition = ScrollPosition()

    /// The subset of messages actually shown, honoring the pagination window.
    /// Uses the shared `ChatVisibleMessageFilter` so hidden automated messages
    /// are excluded from rendered rows, pagination anchors, and all derived state.
    private var visibleMessages: [ChatMessage] {
        ChatVisibleMessageFilter.paginatedMessages(
            from: messages,
            displayedMessageCount: displayedMessageCount
        )
    }

    /// Checks whether observable message-level inputs have changed since the
    /// last body evaluation and, if so, bumps `scrollCoordinator.scrollTracking.messageListVersion`.
    /// This replaces the former O(n) `computeMessageFingerprint()` hash with an
    /// O(1) version counter. Over-invalidation is safe (triggers a recompute);
    /// under-invalidation is not.
    ///
    /// Tracks both the raw `messages.count` (catches new arrivals and
    /// paginated-window shifts at fixed length) and the filtered
    /// `visibleMessages.count` (catches hidden/subagent visibility
    /// transitions). All checks are O(1). `isSending` / `isThinking`
    /// transitions are handled via `PrecomputedCacheKey` fields directly.
    private func refreshMessageListVersionIfNeeded(visibleMessages: [ChatMessage]) {
        let currentRawCount = messages.count
        let currentVisibleCount = visibleMessages.count
        let currentLastStreaming = visibleMessages.last?.isStreaming ?? false
        let currentIncompleteToolCalls = visibleMessages.last?.toolCalls.filter { !$0.isComplete }.count ?? 0

        var changed = false

        if currentRawCount != scrollCoordinator.scrollTracking.lastKnownRawMessageCount {
            scrollCoordinator.scrollTracking.lastKnownRawMessageCount = currentRawCount
            changed = true
        }
        if currentVisibleCount != scrollCoordinator.scrollTracking.lastKnownVisibleMessageCount {
            scrollCoordinator.scrollTracking.lastKnownVisibleMessageCount = currentVisibleCount
            changed = true
        }
        if currentLastStreaming != scrollCoordinator.scrollTracking.lastKnownLastMessageStreaming {
            scrollCoordinator.scrollTracking.lastKnownLastMessageStreaming = currentLastStreaming
            changed = true
        }
        if currentIncompleteToolCalls != scrollCoordinator.scrollTracking.lastKnownIncompleteToolCallCount {
            scrollCoordinator.scrollTracking.lastKnownIncompleteToolCallCount = currentIncompleteToolCalls
            changed = true
        }

        if changed {
            scrollCoordinator.scrollTracking.messageListVersion += 1
        }
    }

    /// Computes a fingerprint over active subagents that captures identity,
    /// parent assignment, status, label, and error — not just count.
    private static func computeSubagentFingerprint(_ subagents: [SubagentInfo]) -> Int {
        var hasher = Hasher()
        hasher.combine(subagents.count)
        for s in subagents {
            hasher.combine(s.id)
            hasher.combine(s.parentMessageId)
            hasher.combine(s.label)
            hasher.combine(s.status)
            hasher.combine(s.error)
        }
        return hasher.finalize()
    }

    /// The active pending confirmation request ID, derived from the visible
    /// messages. Used by onChange to detect new confirmation appearances.
    private var currentPendingRequestId: String? {
        PendingConfirmationFocusSelector.activeRequestId(from: visibleMessages)
    }

    /// Computes all derived values needed by the message list body.
    ///
    /// Structural metadata (IDs, timestamps, role-based indices, subagent
    /// grouping) is memoized behind a lightweight O(1) cache key stored on
    /// the non-reactive `ScrollTrackingState`. Content-derived state
    /// (message data, confirmation placement, thinking indicators) is
    /// always computed fresh from the live `visibleMessages` array so
    /// SwiftUI's `.equatable()` diffing sees every mutation.
    private var derivedState: MessageListDerivedState {
        os_signpost(.begin, log: stallLog, name: "DerivedState.resolve")

        // Compute visible messages first so version tracking and layout
        // both operate on the same filtered set.
        let liveMessages = visibleMessages
        refreshMessageListVersionIfNeeded(visibleMessages: liveMessages)

        let key = PrecomputedCacheKey(
            messageListVersion: scrollCoordinator.scrollTracking.messageListVersion,
            isSending: isSending,
            isThinking: isThinking,
            isCompacting: isCompacting,
            assistantStatusText: assistantStatusText,
            activeSubagentFingerprint: Self.computeSubagentFingerprint(activeSubagents),
            displayedMessageCount: displayedMessageCount
        )
        let liveMessageById = Dictionary(
            liveMessages.map { ($0.id, $0) },
            uniquingKeysWith: { first, _ in first }
        )

        // --- Stage 1: Cached structural metadata ---
        let layout: CachedMessageLayoutMetadata
        if key == scrollCoordinator.scrollTracking.cachedLayoutKey,
           let cached = scrollCoordinator.scrollTracking.cachedLayoutMetadata,
           cached.displayMessageIds.count == liveMessages.count {
            #if DEBUG
            var seen = Set<UUID>()
            let freshIds = liveMessages.map(\.id).filter { seen.insert($0).inserted }
            assert(
                cached.displayMessageIds == freshIds,
                "layout cache stale: IDs \(cached.displayMessageIds.count) vs \(freshIds.count)"
            )
            #endif
            os_signpost(.event, log: stallLog, name: "DerivedState.layoutCacheHit")
            layout = cached
        } else {
            os_signpost(.event, log: stallLog, name: "DerivedState.layoutCacheMiss", "version=%d", scrollCoordinator.scrollTracking.messageListVersion)

            let displayMessageIds: [UUID] = {
                var seen = Set<UUID>()
                return liveMessages.map(\.id).filter { seen.insert($0).inserted }
            }()
            let messageIndexById = Dictionary(liveMessages.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { first, _ in first })
            let showTimestamp = timestampIds(for: liveMessages)
            let latestAssistantId = liveMessages.last(where: { $0.role == .assistant })?.id

            var hasPrecedingAssistantByIndex = Set<Int>()
            for i in liveMessages.indices where i > 0 {
                if liveMessages[i - 1].role == .assistant {
                    hasPrecedingAssistantByIndex.insert(i)
                }
            }

            let hasUserMessage = liveMessages.contains { $0.role == .user }
            let subagentsByParent: [UUID: [SubagentInfo]] = Dictionary(
                grouping: activeSubagents.filter { $0.parentMessageId != nil },
                by: { $0.parentMessageId! }
            )
            let orphanSubagents = activeSubagents.filter { $0.parentMessageId == nil }
            let effectiveStatusText = isCompacting ? "Compacting context\u{2026}" : assistantStatusText

            layout = CachedMessageLayoutMetadata(
                displayMessageIds: displayMessageIds,
                messageIndexById: messageIndexById,
                showTimestamp: showTimestamp,
                hasPrecedingAssistantByIndex: hasPrecedingAssistantByIndex,
                hasUserMessage: hasUserMessage,
                latestAssistantId: latestAssistantId,
                subagentsByParent: subagentsByParent,
                orphanSubagents: orphanSubagents,
                effectiveStatusText: effectiveStatusText
            )
            scrollCoordinator.scrollTracking.cachedLayoutKey = key
            scrollCoordinator.scrollTracking.cachedLayoutMetadata = layout
        }

        // --- Stage 2: Live content-derived state (always fresh) ---

        let activePendingRequestId = PendingConfirmationFocusSelector.activeRequestId(from: liveMessages)
        let anchoredThinkingIndex = resolvedThinkingAnchorIndex(for: liveMessages)

        var nextDecidedConfirmationByIndex: [Int: ToolConfirmationData] = [:]
        for i in liveMessages.indices {
            if i + 1 < liveMessages.count,
               let conf = liveMessages[i + 1].confirmation,
               conf.state != .pending {
                nextDecidedConfirmationByIndex[i] = conf
            }
        }

        var isConfirmationRenderedInlineByIndex = Set<Int>()
        for i in liveMessages.indices {
            guard let confirmation = liveMessages[i].confirmation,
                  confirmation.state == .pending,
                  let confirmationToolUseId = confirmation.toolUseId,
                  !confirmationToolUseId.isEmpty else { continue }
            for j in (0..<i).reversed() {
                let msg = liveMessages[j]
                guard msg.role == .assistant, msg.confirmation == nil else { continue }
                if msg.toolCalls.contains(where: { $0.toolUseId == confirmationToolUseId && $0.pendingConfirmation != nil }) {
                    isConfirmationRenderedInlineByIndex.insert(i)
                }
                break
            }
        }

        let lastVisible = liveMessages.last
        let currentTurnMessages: ArraySlice<ChatMessage> = {
            if isSending, let last = liveMessages.last, last.role == .user {
                let lastNonUser = liveMessages.last(where: {
                    $0.role != .user
                })
                let isActivelyProcessing = lastNonUser?.isStreaming == true
                    || lastNonUser?.confirmation?.state == .pending
                if !isActivelyProcessing {
                    return liveMessages[liveMessages.endIndex...]
                }
            }
            let lastTurnStart = liveMessages.indices.reversed().first(where: { idx in
                liveMessages[idx].role == .user
                    && liveMessages.index(after: idx) < liveMessages.endIndex
                    && liveMessages[liveMessages.index(after: idx)].role != .user
            })
            if let idx = lastTurnStart {
                return liveMessages[liveMessages.index(after: idx)...]
            }
            return liveMessages[liveMessages.startIndex...]
        }()
        let hasActiveToolCall = currentTurnMessages.contains(where: {
            $0.toolCalls.contains(where: { !$0.isComplete })
        })
        let wouldShowThinking = isSending
            && (isThinking || !(lastVisible?.isStreaming == true))
            && !hasActiveToolCall
        let lastVisibleIsAssistant = lastVisible?.role == .assistant
        let canInlineProcessing = wouldShowThinking && lastVisibleIsAssistant
        let shouldShowThinkingIndicator = wouldShowThinking && !canInlineProcessing

        let result = MessageListDerivedState(
            displayMessageIds: layout.displayMessageIds,
            messageIndexById: layout.messageIndexById,
            showTimestamp: layout.showTimestamp,
            hasPrecedingAssistantByIndex: layout.hasPrecedingAssistantByIndex,
            hasUserMessage: layout.hasUserMessage,
            latestAssistantId: layout.latestAssistantId,
            subagentsByParent: layout.subagentsByParent,
            orphanSubagents: layout.orphanSubagents,
            effectiveStatusText: layout.effectiveStatusText,
            displayMessageById: liveMessageById,
            activePendingRequestId: activePendingRequestId,
            nextDecidedConfirmationByIndex: nextDecidedConfirmationByIndex,
            isConfirmationRenderedInlineByIndex: isConfirmationRenderedInlineByIndex,
            anchoredThinkingIndex: anchoredThinkingIndex,
            hasActiveToolCall: hasActiveToolCall,
            canInlineProcessing: canInlineProcessing,
            shouldShowThinkingIndicator: shouldShowThinkingIndicator,
            hasMessages: !liveMessages.isEmpty
        )

        os_signpost(.end, log: stallLog, name: "DerivedState.resolve")
        return result
    }

    func canFork(from message: ChatMessage) -> Bool {
        onForkFromMessage != nil && message.daemonMessageId != nil && !message.isStreaming
    }

    func forkFromMessage(_ daemonMessageId: String) {
        onForkFromMessage?(daemonMessageId)
    }

    var forkFromMessageAction: ((String) -> Void)? {
        guard onForkFromMessage != nil else { return nil }
        return { daemonMessageId in
            forkFromMessage(daemonMessageId)
        }
    }

    /// Pre-compute which message IDs should show a timestamp divider.
    /// Avoids creating a Calendar instance per-message inside the ForEach body.
    /// Uses UUID-based keys so results are stable across array mutations.
    private func timestampIds(for list: [ChatMessage]) -> Set<UUID> {
        guard !list.isEmpty else { return [] }
        var result: Set<UUID> = [list[0].id]
        var calendar = Calendar.current
        calendar.timeZone = ChatTimestampTimeZone.resolve()
        for i in 1..<list.count {
            let current = list[i].timestamp
            let previous = list[i - 1].timestamp
            if !calendar.isDate(current, inSameDayAs: previous) || current.timeIntervalSince(previous) > 300 {
                result.insert(list[i].id)
            }
        }
        return result
    }

    /// Delegates scroll-to-bottom restoration to the coordinator.
    private func restoreScrollToBottom() {
        scrollCoordinator.restoreScrollToBottom(
            conversationId: conversationId,
            anchorMessageId: $anchorMessageId
        )
    }

    /// Delegates flash-highlight to the coordinator.
    private func flashHighlight(messageId: UUID) {
        scrollCoordinator.flashHighlight(messageId: messageId, highlightedMessageId: $highlightedMessageId)
    }

    /// Delegates scroll loop event recording to the coordinator.
    private func recordScrollLoopEvent(_ kind: ChatScrollLoopGuard.EventKind) {
        scrollCoordinator.recordScrollLoopEvent(
            kind,
            conversationId: conversationId,
            isNearBottom: isNearBottom,
            scrollViewportHeight: scrollCoordinator.currentScrollViewportHeight,
            anchorMessageId: anchorMessageId
        )
    }


    /// Delegates bottom-pin request to the coordinator.
    private func requestBottomPin(
        reason: BottomPinRequestReason,
        animated: Bool = false,
        userInitiated: Bool = false
    ) {
        scrollCoordinator.requestBottomPin(
            reason: reason,
            conversationId: conversationId,
            animated: animated,
            userInitiated: userInitiated
        )
    }

    /// Configures scroll callbacks and bindings on the scroll coordinator.
    private func configureScrollCallbacks() {
        // Wire the scrollTo closure so the coordinator can perform programmatic
        // scrolls without holding a reference to ScrollViewProxy.
        let binding = $scrollPosition
        scrollCoordinator.scrollTo = { id, anchor in
            if let stringId = id as? String {
                binding.wrappedValue.scrollTo(id: stringId, anchor: anchor)
            } else if let uuidId = id as? UUID {
                binding.wrappedValue.scrollTo(id: uuidId, anchor: anchor)
            }
        }
        scrollCoordinator.scrollToEdge = { edge in
            binding.wrappedValue.scrollTo(edge: edge)
        }
        scrollCoordinator.configureScrollCallbacks(
            scrollViewportHeight: scrollCoordinator.currentScrollViewportHeight,
            conversationId: conversationId,
            isNearBottom: $isNearBottom
        )
    }

    private var shouldAnchorThinkingToConfirmationChip: Bool {
        assistantActivityPhase == "thinking"
            && assistantActivityAnchor == "assistant_turn"
            && assistantActivityReason == "confirmation_resolved"
    }

    private func resolvedThinkingAnchorIndex(for list: [ChatMessage]) -> Int? {
        guard shouldAnchorThinkingToConfirmationChip else { return nil }
        guard !list.isEmpty else { return nil }

        for index in list.indices.reversed() {
            // Decided confirmation chips are usually rendered inline on the
            // preceding assistant bubble.
            if list[index].role == .assistant, list.index(after: index) < list.endIndex {
                let next = list[list.index(after: index)]
                if let nextConfirmation = next.confirmation, nextConfirmation.state != .pending {
                    return index
                }
            }

            // Fallback for standalone decided confirmation bubbles.
            if let confirmation = list[index].confirmation, confirmation.state != .pending {
                let hasPrecedingAssistant = index > list.startIndex
                    && list[list.index(before: index)].role == .assistant
                if !hasPrecedingAssistant {
                    return index
                }
            }
        }

        return nil
    }

    @ViewBuilder
    private func thinkingIndicatorRow(hasUserMessage: Bool) -> some View {
        RunningIndicator(
            label: !hasEverSentMessage && hasUserMessage
                ? "Waking up..."
                : assistantStatusText ?? "Thinking",
            showIcon: false
        )
        .frame(maxWidth: VSpacing.chatBubbleMaxWidth, alignment: .leading)
        .id("thinking-indicator")
        .transition(.opacity.combined(with: .move(edge: .bottom)))
    }

    @ViewBuilder
    private func compactingIndicatorRow() -> some View {
        RunningIndicator(
            label: "Compacting context\u{2026}",
            showIcon: false
        )
        .frame(maxWidth: VSpacing.chatBubbleMaxWidth, alignment: .leading)
        .id("compacting-indicator")
        .transition(.opacity.combined(with: .move(edge: .bottom)))
    }

    @ViewBuilder
    private var thinkingAvatarRow: some View {
        let avatarSize = ConversationAvatarFollower.avatarSize
        if appearance.customAvatarImage != nil {
            HStack {
                VAvatarImage(image: appearance.chatAvatarImage, size: avatarSize)
                Spacer()
            }
            .accessibilityHidden(true)
        } else if let body = appearance.characterBodyShape,
                  let eyes = appearance.characterEyeStyle,
                  let color = appearance.characterColor {
            HStack {
                AnimatedAvatarView(bodyShape: body, eyeStyle: eyes, color: color,
                                   size: avatarSize, blinkEnabled: true, pokeEnabled: true,
                                   isStreaming: true)
                    .frame(width: avatarSize, height: avatarSize)
                Spacer()
            }
            .accessibilityHidden(true)
        } else {
            HStack {
                VAvatarImage(image: appearance.chatAvatarImage, size: avatarSize)
                Spacer()
            }
            .accessibilityHidden(true)
        }
    }

    var body: some View {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: VSpacing.md) {
                    // MARK: - Pagination sentinel

                    if isLoadingMoreMessages {
                        HStack {
                            Spacer()
                            ProgressView()
                                .controlSize(.small)
                            Spacer()
                        }
                        .padding(.vertical, VSpacing.sm)
                        .id("page-loading-indicator")
                    } else if hasMoreMessages {
                        // Invisible sentinel: geometry-reported position gates
                        // pagination on actual viewport entry rather than
                        // LazyVStack prefetch (which fires several screens early).
                        Color.clear
                            .frame(height: 1)
                            .id("page-load-trigger")
                            .background {
                                GeometryReader { geo in
                                    Color.clear.preference(
                                        key: PaginationSentinelMinYKey.self,
                                        value: geo.frame(in: .named("chatScrollView")).minY
                                    )
                                }
                            }
                    }

                    let _ = recordScrollLoopEvent(.bodyEvaluation)
                    let _ = os_signpost(.event, log: stallLog, name: "MessageList.bodyEval")
                    let state = derivedState
                    let catalogHash = MessageCellView.hashCatalog(providerCatalog)
                    ForEach(state.displayMessageIds, id: \.self) { messageId in
                        if let message = state.displayMessageById[messageId] {
                            let index = state.messageIndexById[messageId] ?? 0
                            MessageCellView(
                                message: message,
                                index: index,
                                showTimestamp: state.showTimestamp.contains(messageId),
                                nextDecidedConfirmation: state.nextDecidedConfirmationByIndex[index],
                                isConfirmationRenderedInline: state.isConfirmationRenderedInlineByIndex.contains(index),
                                hasPrecedingAssistant: state.hasPrecedingAssistantByIndex.contains(index),
                                hasUserMessage: state.hasUserMessage,
                                activePendingRequestId: state.activePendingRequestId,
                                latestAssistantId: state.latestAssistantId,
                                anchoredThinkingIndex: state.anchoredThinkingIndex,
                                subagentsByParent: state.subagentsByParent,
                                canInlineProcessing: state.canInlineProcessing,
                                shouldShowThinkingIndicator: state.shouldShowThinkingIndicator,
                                assistantStatusText: state.effectiveStatusText,
                                dismissedDocumentSurfaceIds: dismissedDocumentSurfaceIds,
                                activeSurfaceId: taskProgressManager.activeSurfaceId,
                                isHighlighted: highlightedMessageId == messageId,
                                mediaEmbedSettings: mediaEmbedSettings,
                                onConfirmationAllow: onConfirmationAllow,
                                onConfirmationDeny: onConfirmationDeny,
                                onAlwaysAllow: onAlwaysAllow,
                                onTemporaryAllow: onTemporaryAllow,
                                onGuardianAction: onGuardianAction,
                                onSurfaceAction: onSurfaceAction,
                                onDismissDocumentWidget: onDismissDocumentWidget,
                                onForkFromMessage: forkFromMessageAction,
                                showInspectButton: showInspectButton,
                                isTTSEnabled: isTTSEnabled,
                                onInspectMessage: onInspectMessage,
                                onRehydrateMessage: onRehydrateMessage,
                                onSurfaceRefetch: onSurfaceRefetch,
                                onRetryFailedMessage: onRetryFailedMessage,
                                onRetryConversationError: onRetryConversationError,
                                onAbortSubagent: onAbortSubagent,
                                onSubagentTap: onSubagentTap,
                                subagentDetailStore: subagentDetailStore,
                                selectedModel: selectedModel,
                                configuredProviders: configuredProviders,
                                providerCatalog: providerCatalog,
                                providerCatalogHash: catalogHash
                            )
                            .equatable()
                        }
                    }

                    ForEach(state.orphanSubagents) { subagent in
                        SubagentEventsReader(
                            store: subagentDetailStore,
                            subagent: subagent,
                            onAbort: { onAbortSubagent?(subagent.id) },
                            onTap: { onSubagentTap?(subagent.id) }
                        )
                            .frame(maxWidth: VSpacing.chatBubbleMaxWidth, alignment: .leading)
                            .id("subagent-\(subagent.id)")
                            .transition(.opacity.combined(with: .move(edge: .bottom)))
                    }

                    if state.shouldShowThinkingIndicator && state.anchoredThinkingIndex == nil {
                        if isCompacting {
                            compactingIndicatorRow()
                        } else {
                            thinkingIndicatorRow(hasUserMessage: state.hasUserMessage)
                        }
                        // Show avatar below thinking indicator so it moves
                        // immediately when the user sends a message.
                        thinkingAvatarRow
                    } else if isCompacting && !state.shouldShowThinkingIndicator && !state.canInlineProcessing {
                        compactingIndicatorRow()
                    }


                    Color.clear.frame(height: 1)
                        .id("scroll-bottom-anchor")
                        .onAppear {
                            // Only auto-tether on initial load (before any scroll events).
                            // After the user has scrolled, rely on onScrollPhaseChange and
                            // onScrollGeometryChange tracking to manage isNearBottom —
                            // LazyVStack fires onAppear in the prefetch zone (several screens
                            // ahead) which would prematurely re-tether during normal scrolling.
                            if !scrollCoordinator.hasReceivedScrollEvent {
                                isNearBottom = true
                            }
                        }

                    // Viewport-height spacer that allows the last message
                    // to scroll to the top. Only rendered during push-to-top
                    // to avoid empty scrollable space in idle state.
                    if scrollCoordinator.pushToTopMessageId != nil {
                        Color.clear
                            .frame(height: scrollCoordinator.currentScrollViewportHeight.isFinite ? max(0, scrollCoordinator.currentScrollViewportHeight) : 0)
                            .allowsHitTesting(false)
                            .accessibilityHidden(true)
                    }
                }
                .padding(.horizontal, VSpacing.xl)
                .padding(.top, VSpacing.md)
                .padding(.bottom, VSpacing.md)
                .frame(maxWidth: VSpacing.chatColumnMaxWidth)
                .frame(maxWidth: .infinity)
            }
            .scrollContentBackground(.hidden)
            .plainTextCopy()
            .coordinateSpace(name: "chatScrollView")
            .scrollDisabled(messages.isEmpty && !isSending)
            .scrollPosition($scrollPosition)
            .environment(\.suppressAutoScroll, { [self] in
                scrollCoordinator.handleSuppressAutoScroll(
                    isNearBottom: isNearBottom,
                    conversationId: conversationId,
                    scrollViewportHeight: scrollCoordinator.currentScrollViewportHeight
                )
            })
            .onScrollPhaseChange { oldPhase, newPhase in
                scrollCoordinator.scrollPhase = newPhase
                if newPhase == .idle && oldPhase != .idle && scrollCoordinator.isAtBottom {
                    // User-initiated scrolls that land at the bottom exit
                    // push-to-top. Programmatic scrolls (.animating) are
                    // excluded to avoid undoing the initial push-to-top.
                    if oldPhase == .interacting || oldPhase == .decelerating {
                        scrollCoordinator.pushToTopMessageId = nil
                    }
                    scrollCoordinator.handleScrollToBottom()
                }
            }
            .onScrollGeometryChange(for: ScrollGeometrySnapshot.self) { geometry in
                ScrollGeometrySnapshot(
                    contentOffsetY: geometry.contentOffset.y,
                    contentHeight: geometry.contentSize.height,
                    containerHeight: geometry.containerSize.height,
                    visibleRectHeight: geometry.visibleRect.height
                )
            } action: { _, newState in
                // --- Scroll direction detection ---
                let tracking = scrollCoordinator.scrollTracking
                let effectiveContentHeight = newState.contentHeight - scrollCoordinator.tailSpacerHeight
                let isScrollable = effectiveContentHeight > newState.containerHeight || scrollCoordinator.pushToTopMessageId != nil
                let isScrollingUp = newState.contentOffsetY < tracking.lastScrollContentOffsetY
                tracking.scrollContentHeight = newState.contentHeight
                tracking.scrollContainerHeight = newState.containerHeight
                tracking.lastScrollContentOffsetY = newState.contentOffsetY

                // Only detach on direct user gesture (interacting), not momentum.
                // Only detach when content is scrollable (prevents false detaches
                // on short conversations).
                if scrollCoordinator.scrollPhase == .interacting && isScrollingUp && isScrollable {
                    scrollCoordinator.handleScrollUp()
                }

                // --- Viewport height update ---
                // Filter non-finite viewport heights and sub-pixel jitter.
                // A 0.5pt dead-zone prevents floating-point rounding differences
                // from triggering continuous updates that feed back into layout.
                // `currentScrollViewportHeight` is non-reactive (not `@State`), so
                // updating it here does NOT trigger body re-evaluations.
                let decision = PreferenceGeometryFilter.evaluate(
                    newValue: newState.visibleRectHeight,
                    previous: scrollCoordinator.currentScrollViewportHeight,
                    deadZone: 0.5
                )
                if case .accept(let accepted) = decision {
                    os_signpost(.begin, log: PerfSignposts.log, name: "viewportHeightChanged")
                    scrollCoordinator.currentScrollViewportHeight = accepted
                    os_signpost(.end, log: PerfSignposts.log, name: "viewportHeightChanged")
                }

                // --- Bottom detection (with hysteresis) ---
                // Asymmetric thresholds prevent oscillation during streaming:
                // content-height growth can briefly push distanceFromBottom past
                // the "at bottom" threshold before the scroll position catches
                // up, causing rapid true→false→true flips. A wider leave
                // threshold absorbs those transient spikes without overly
                // widening the idle-reattach zone (onScrollPhaseChange reattaches
                // when isAtBottom is true on idle).
                let distanceFromBottom = effectiveContentHeight - newState.contentOffsetY - newState.visibleRectHeight
                let nowAtBottom: Bool
                if scrollCoordinator.isAtBottom {
                    // Stay "at bottom" until clearly scrolled away.
                    nowAtBottom = distanceFromBottom.isFinite && distanceFromBottom <= 30
                } else {
                    // Only re-enter "at bottom" when truly close.
                    nowAtBottom = distanceFromBottom.isFinite && distanceFromBottom <= 10
                }
                if scrollCoordinator.isAtBottom != nowAtBottom {
                    scrollCoordinator.isAtBottom = nowAtBottom
                    if nowAtBottom {
                        scrollCoordinator.handleScrollToBottom()
                    }
                }

                // --- Push-to-top overflow detection ---
                if scrollCoordinator.pushToTopMessageId != nil && distanceFromBottom > 50 {
                    scrollCoordinator.pushToTopMessageId = nil
                    scrollCoordinator.requestBottomPin(
                        reason: .messageCount,
                        conversationId: conversationId,
                        animated: true
                    )
                }
            }
            .scrollIndicators(scrollCoordinator.hideScrollIndicators ? .hidden : .automatic)
            .onPreferenceChange(PaginationSentinelMinYKey.self) { sentinelMinY in
                scrollCoordinator.handlePaginationSentinel(
                    sentinelMinY: sentinelMinY,
                    scrollViewportHeight: scrollCoordinator.currentScrollViewportHeight,
                    hasMoreMessages: hasMoreMessages,
                    isLoadingMoreMessages: isLoadingMoreMessages,
                    visibleMessages: visibleMessages,
                    conversationId: conversationId,
                    loadPreviousMessagePage: loadPreviousMessagePage
                )
            }
            .overlay(alignment: .bottom) {
                if !isNearBottom {
                    Button(action: {
                        os_signpost(.event, log: PerfSignposts.log, name: "scrollToLatestPressed")
                        scrollCoordinator.hasReceivedScrollEvent = true
                        // Signal the coordinator to reattach and scroll to bottom.
                        scrollCoordinator.reattachToBottom()
                        requestBottomPin(reason: .initialRestore, animated: true, userInitiated: true)
                    }) {
                        HStack(spacing: VSpacing.xs) {
                            VIconView(.arrowDown, size: 10)
                            Text("Scroll to latest")
                                .font(VFont.bodySmallDefault)
                        }
                        .padding(.horizontal, VSpacing.md)
                        .padding(.vertical, VSpacing.sm)
                        .background(VColor.surfaceOverlay)
                        .clipShape(Capsule())
                        .shadow(color: VColor.auxBlack.opacity(0.15), radius: 4, y: 2)
                    }
                    .buttonStyle(.plain)
                    .background { ScrollWheelPassthrough() }
                    .padding(.bottom, VSpacing.lg)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .onAppear {
                configureScrollCallbacks()
                // Seed the confirmation marker on initial mount — conversationSwitched
                // doesn't fire for the initial value, so a conversation already paused
                // in awaiting_confirmation at launch or reconnect needs the marker set here.
                if !isSending {
                    scrollCoordinator.phaseWhenSendingStopped = assistantActivityPhase
                }
                if let id = anchorMessageId, messages.contains(where: { $0.id == id }) {
                    // Anchor is already set and the target message is loaded —
                    // scroll to it immediately instead of falling through to bottom.
                    os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested", "target=anchorMessage reason=onAppear")
                    os_signpost(.event, log: PerfSignposts.log, name: "anchorCleared", "reason=foundOnAppear")
                    recordScrollLoopEvent(.scrollToRequested)
                    $scrollPosition.wrappedValue.scrollTo(id: id, anchor: .center)
                    flashHighlight(messageId: id)
                    anchorMessageId = nil
                    scrollCoordinator.anchorSetTime = nil
                } else if anchorMessageId != nil {
                    // Anchor is set but the target message isn't loaded yet.
                    os_signpost(.event, log: PerfSignposts.log, name: "anchorSet", "reason=onAppearPending")
                    if scrollCoordinator.anchorSetTime == nil { scrollCoordinator.anchorSetTime = Date() }
                    // Start the independent timeout if not already running.
                    if scrollCoordinator.anchorTimeoutTask == nil {
                        scrollCoordinator.anchorTimeoutTask = Task { @MainActor [weak scrollCoordinator] in
                            do {
                                try await Task.sleep(nanoseconds: 10_000_000_000)
                            } catch { return }
                            guard !Task.isCancelled, let scrollCoordinator, anchorMessageId != nil else { return }
                            os_signpost(.event, log: PerfSignposts.log, name: "anchorTimedOut")
                            log.debug("Anchor message not found (timed out) — clearing stale anchor")
                            anchorMessageId = nil
                            scrollCoordinator.anchorSetTime = nil
                            scrollCoordinator.anchorTimeoutTask = nil
                            scrollCoordinator.reattachToBottom()
                            scrollCoordinator.requestBottomPin(reason: .initialRestore, conversationId: conversationId, animated: true)
                        }
                    }
                } else {
                    if !scrollCoordinator.hasReceivedScrollEvent {
                        scrollCoordinator.scrollToEdge?(.bottom)
                    }
                    restoreScrollToBottom()
                }
            }
            .onDisappear {
                scrollCoordinator.cancelAllTasks()
                resizeScrollTask?.cancel()
                resizeScrollTask = nil
                highlightedMessageId = nil
            }
            // MARK: - Consolidated onChange handlers (≤4, delegating to coordinator)
            .onChange(of: isSending) {
                scrollCoordinator.sendingStateChanged(
                    isSending: isSending,
                    isThinking: isThinking,
                    assistantActivityPhase: assistantActivityPhase,
                    messages: messages,
                    hasEverSentMessage: &hasEverSentMessage,
                    conversationId: conversationId
                )
            }
            .onChange(of: messages.count) {
                scrollCoordinator.messagesChanged(
                    messages: messages,
                    anchorMessageId: &anchorMessageId,
                    highlightedMessageId: $highlightedMessageId,
                    hasMoreMessages: hasMoreMessages,
                    isNearBottom: isNearBottom,
                    conversationId: conversationId,
                    currentPendingRequestId: currentPendingRequestId
                )
            }
            .onChange(of: containerWidth) {
                resizeScrollTask = scrollCoordinator.containerResized(
                    width: containerWidth,
                    conversationId: conversationId,
                    isNearBottom: isNearBottom,
                    anchorMessageId: anchorMessageId,
                    previousResizeTask: resizeScrollTask,
                    onResizeComplete: { [self] in resizeScrollTask = nil }
                )
            }
            .onChange(of: conversationId) { oldConversationId, _ in
                scrollCoordinator.conversationSwitched(
                    oldConversationId: oldConversationId,
                    newConversationId: conversationId,
                    isSending: isSending,
                    assistantActivityPhase: assistantActivityPhase,
                    containerWidth: containerWidth,
                    isNearBottom: &isNearBottom,
                    highlightedMessageId: $highlightedMessageId,
                    resizeScrollTask: &resizeScrollTask,
                    anchorMessageId: $anchorMessageId,
                    scrollViewportHeight: scrollCoordinator.currentScrollViewportHeight
                )
            }
            .onChange(of: currentPendingRequestId) {
                #if os(macOS)
                scrollCoordinator.handleConfirmationFocusIfNeeded(currentPendingRequestId: currentPendingRequestId)
                #endif
            }
            // anchorMessageId changes are handled via task(id:) to avoid
            // counting as an onChange modifier while still reacting to
            // external deep-link anchor assignments.
            .task(id: anchorMessageId) {
                // task(id:) fires on initial value and on changes. Only process
                // non-nil anchor assignments; nil transitions are cleanup handled
                // by messagesChanged and conversationSwitched.
                guard anchorMessageId != nil else { return }
                scrollCoordinator.anchorMessageIdChanged(
                    anchorMessageId: $anchorMessageId,
                    messages: messages,
                    conversationId: conversationId,
                    highlightedMessageId: $highlightedMessageId
                )
            }
            .onReceive(NotificationCenter.default.publisher(for: NSWindow.didBecomeKeyNotification)) { notification in
                if let requestId = currentPendingRequestId, scrollCoordinator.lastAutoFocusedRequestId != requestId,
                   let window = notification.object as? NSWindow,
                   window === NSApp.keyWindow,
                   let responder = window.firstResponder as? NSTextView,
                   responder.isEditable {
                    window.makeFirstResponder(nil)
                    scrollCoordinator.lastAutoFocusedRequestId = requestId
                }
            }
    }
}

// MARK: - MessageCellView

/// Per-message cell extracted from the ForEach body so SwiftUI has a typed
/// struct boundary for diffing: when all `let` inputs are equal, SwiftUI can
/// skip re-evaluating the body during LazySubviewPlacements.updateValue.
private struct MessageCellView: View, Equatable {
    static func == (lhs: MessageCellView, rhs: MessageCellView) -> Bool {
        lhs.message == rhs.message
            && lhs.index == rhs.index
            && lhs.showTimestamp == rhs.showTimestamp
            && lhs.nextDecidedConfirmation == rhs.nextDecidedConfirmation
            && lhs.isConfirmationRenderedInline == rhs.isConfirmationRenderedInline
            && lhs.hasPrecedingAssistant == rhs.hasPrecedingAssistant
            && lhs.hasUserMessage == rhs.hasUserMessage
            && lhs.activePendingRequestId == rhs.activePendingRequestId
            && lhs.latestAssistantId == rhs.latestAssistantId
            && lhs.anchoredThinkingIndex == rhs.anchoredThinkingIndex
            && lhs.subagentsByParent[lhs.message.id] == rhs.subagentsByParent[rhs.message.id]
            && lhs.canInlineProcessing == rhs.canInlineProcessing
            && lhs.shouldShowThinkingIndicator == rhs.shouldShowThinkingIndicator
            && lhs.assistantStatusText == rhs.assistantStatusText
            && lhs.dismissedDocumentSurfaceIds == rhs.dismissedDocumentSurfaceIds
            && lhs.activeSurfaceId == rhs.activeSurfaceId
            && lhs.isHighlighted == rhs.isHighlighted
            && lhs.selectedModel == rhs.selectedModel
            && lhs.configuredProviders == rhs.configuredProviders
            && (lhs.providerCatalogHash != rhs.providerCatalogHash ? false
                : lhs.providerCatalog.count == rhs.providerCatalog.count
                  && zip(lhs.providerCatalog, rhs.providerCatalog).allSatisfy({ $0.id == $1.id && $0.displayName == $1.displayName && $0.models.count == $1.models.count && zip($0.models, $1.models).allSatisfy({ $0.id == $1.id && $0.displayName == $1.displayName }) }))
            && lhs.isTTSEnabled == rhs.isTTSEnabled
    }

    let message: ChatMessage
    let index: Int
    let showTimestamp: Bool
    let nextDecidedConfirmation: ToolConfirmationData?
    let isConfirmationRenderedInline: Bool
    let hasPrecedingAssistant: Bool
    let hasUserMessage: Bool
    let activePendingRequestId: String?
    let latestAssistantId: UUID?
    let anchoredThinkingIndex: Int?
    let subagentsByParent: [UUID: [SubagentInfo]]
    let canInlineProcessing: Bool
    let shouldShowThinkingIndicator: Bool
    let assistantStatusText: String?
    let dismissedDocumentSurfaceIds: Set<String>
    let activeSurfaceId: String?
    let isHighlighted: Bool
    let mediaEmbedSettings: MediaEmbedResolverSettings?
    let onConfirmationAllow: (String) -> Void
    let onConfirmationDeny: (String) -> Void
    let onAlwaysAllow: (String, String, String, String) -> Void
    var onTemporaryAllow: ((String, String) -> Void)?
    var onGuardianAction: ((String, String) -> Void)?
    let onSurfaceAction: (String, String, [String: AnyCodable]?) -> Void
    let onDismissDocumentWidget: ((String) -> Void)?
    var onForkFromMessage: ((String) -> Void)?
    var showInspectButton: Bool = false
    var isTTSEnabled: Bool = false
    var onInspectMessage: ((String?) -> Void)?
    var onRehydrateMessage: ((UUID) -> Void)?
    var onSurfaceRefetch: ((String, String) -> Void)?
    var onRetryFailedMessage: ((UUID) -> Void)?
    var onRetryConversationError: ((UUID) -> Void)?
    var onAbortSubagent: ((String) -> Void)?
    var onSubagentTap: ((String) -> Void)?
    var subagentDetailStore: SubagentDetailStore
    let selectedModel: String
    let configuredProviders: Set<String>
    let providerCatalog: [ProviderCatalogEntry]
    let providerCatalogHash: Int

    static func hashCatalog(_ catalog: [ProviderCatalogEntry]) -> Int {
        var hasher = Hasher()
        for entry in catalog {
            hasher.combine(entry.id)
            hasher.combine(entry.displayName)
            for model in entry.models {
                hasher.combine(model.id)
                hasher.combine(model.displayName)
            }
        }
        return hasher.finalize()
    }

    @AppStorage("hasEverSentMessage") private var hasEverSentMessage: Bool = false

    private func modelListView(for msg: ChatMessage) -> some View {
        ModelListBubble(currentModel: selectedModel, configuredProviders: configuredProviders, providerCatalog: providerCatalog)
    }

    private func commandListFallbackMessage(for message: ChatMessage) -> ChatMessage {
        var fallbackMessage = message
        fallbackMessage.commandList = nil
        return fallbackMessage
    }

    @ViewBuilder
    private func commandListView(for message: ChatMessage) -> some View {
        if let commandEntries = CommandListBubble.parsedEntries(from: message.text) {
            CommandListBubble(commands: commandEntries)
        } else {
            ChatBubble(
                message: commandListFallbackMessage(for: message),
                decidedConfirmation: nil,
                onSurfaceAction: onSurfaceAction,
                onDismissDocumentWidget: { surfaceId in
                    onDismissDocumentWidget?(surfaceId)
                },
                dismissedDocumentSurfaceIds: dismissedDocumentSurfaceIds,
                onForkFromMessage: onForkFromMessage,
                showInspectButton: showInspectButton,
                isTTSEnabled: isTTSEnabled,
                onInspectMessage: onInspectMessage,
                onSurfaceRefetch: onSurfaceRefetch,
                onRehydrate: (message.wasTruncated || message.isContentStripped) ? { onRehydrateMessage?(message.id) } : nil,
                mediaEmbedSettings: mediaEmbedSettings,
                onConfirmationAllow: onConfirmationAllow,
                onConfirmationDeny: onConfirmationDeny,
                onAlwaysAllow: onAlwaysAllow,
                onTemporaryAllow: onTemporaryAllow,
                activeConfirmationRequestId: activePendingRequestId,
                onRetryFailedMessage: onRetryFailedMessage,
                onRetryConversationError: message.isError ? { onRetryConversationError?(message.id) } : nil,
                isLatestAssistantMessage: message.role == .assistant && message.id == latestAssistantId,
                isProcessingAfterTools: canInlineProcessing && message.id == latestAssistantId,
                processingStatusText: canInlineProcessing && message.id == latestAssistantId ? assistantStatusText : nil,
                activeSurfaceId: activeSurfaceId,
                hideInlineAvatar: shouldShowThinkingIndicator && anchoredThinkingIndex == nil
            )
        }
    }

    @ViewBuilder
    private func thinkingIndicatorRow() -> some View {
        RunningIndicator(
            label: !hasEverSentMessage && hasUserMessage
                ? "Waking up..."
                : assistantStatusText ?? "Thinking",
            showIcon: false
        )
        .frame(maxWidth: VSpacing.chatBubbleMaxWidth, alignment: .leading)
        .id("thinking-indicator")
    }

    var body: some View {
        if showTimestamp {
            TimestampDivider(date: message.timestamp)
        }

        if let confirmation = message.confirmation {
            if confirmation.state == .pending {
                if !isConfirmationRenderedInline {
                    ToolConfirmationBubble(
                        confirmation: confirmation,
                        isKeyboardActive: confirmation.requestId == activePendingRequestId,
                        onAllow: { onConfirmationAllow(confirmation.requestId) },
                        onDeny: { onConfirmationDeny(confirmation.requestId) },
                        onAlwaysAllow: onAlwaysAllow,
                        onTemporaryAllow: onTemporaryAllow
                    )
                    .id(message.id)
                }
            } else {
                if !hasPrecedingAssistant {
                    ToolConfirmationBubble(
                        confirmation: confirmation,
                        onAllow: { onConfirmationAllow(confirmation.requestId) },
                        onDeny: { onConfirmationDeny(confirmation.requestId) },
                        onAlwaysAllow: onAlwaysAllow,
                        onTemporaryAllow: onTemporaryAllow
                    )
                    .id(message.id)
                }
            }
        } else if message.modelList != nil {
            modelListView(for: message)
                .id(message.id)
        } else if message.commandList != nil {
            commandListView(for: message)
                .id(message.id)
        } else if let guardianDecision = message.guardianDecision {
            GuardianDecisionBubble(
                decision: guardianDecision,
                onAction: { requestId, action in
                    onGuardianAction?(requestId, action)
                }
            )
            .id(message.id)
        } else {
            ChatBubble(
                message: message,
                decidedConfirmation: nextDecidedConfirmation,
                onSurfaceAction: onSurfaceAction,
                onDismissDocumentWidget: { surfaceId in
                    onDismissDocumentWidget?(surfaceId)
                },
                dismissedDocumentSurfaceIds: dismissedDocumentSurfaceIds,
                onForkFromMessage: onForkFromMessage,
                showInspectButton: showInspectButton,
                isTTSEnabled: isTTSEnabled,
                onInspectMessage: onInspectMessage,
                onSurfaceRefetch: onSurfaceRefetch,
                onRehydrate: (message.wasTruncated || message.isContentStripped) ? { onRehydrateMessage?(message.id) } : nil,
                mediaEmbedSettings: mediaEmbedSettings,
                onConfirmationAllow: onConfirmationAllow,
                onConfirmationDeny: onConfirmationDeny,
                onAlwaysAllow: onAlwaysAllow,
                onTemporaryAllow: onTemporaryAllow,
                activeConfirmationRequestId: activePendingRequestId,
                onRetryFailedMessage: onRetryFailedMessage,
                onRetryConversationError: message.isError ? { onRetryConversationError?(message.id) } : nil,
                isLatestAssistantMessage: message.role == .assistant && message.id == latestAssistantId,
                isProcessingAfterTools: canInlineProcessing && message.id == latestAssistantId,
                processingStatusText: canInlineProcessing && message.id == latestAssistantId ? assistantStatusText : nil,
                activeSurfaceId: activeSurfaceId,
                hideInlineAvatar: shouldShowThinkingIndicator && anchoredThinkingIndex == nil
            )
            .background(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .fill(VColor.primaryBase.opacity(isHighlighted ? 0.15 : 0))
                    .padding(.horizontal, -VSpacing.sm)
                    .padding(.vertical, -VSpacing.xs)
            )
            .animation(VAnimation.slow, value: isHighlighted)
            .id(message.id)
        }

        ForEach(subagentsByParent[message.id] ?? []) { subagent in
            SubagentEventsReader(
                store: subagentDetailStore,
                subagent: subagent,
                onAbort: { onAbortSubagent?(subagent.id) },
                onTap: { onSubagentTap?(subagent.id) }
            )
                .frame(maxWidth: VSpacing.chatBubbleMaxWidth, alignment: .leading)
                .id("subagent-\(subagent.id)")
        }

        if shouldShowThinkingIndicator && anchoredThinkingIndex == index {
            thinkingIndicatorRow()
        }
    }
}

/// Preference key that propagates the pagination sentinel's minY (in the
/// `chatScrollView` coordinate space) so the geometry-based pagination
/// trigger can evaluate whether the sentinel has entered the top band.
private struct PaginationSentinelMinYKey: PreferenceKey {
    static var defaultValue: CGFloat = .infinity
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = min(value, nextValue())
    }
}


// MARK: - Cached Message Layout Metadata

/// Structural metadata cached behind a version-counter key on
/// `ScrollTrackingState`. Contains only fields derived from message IDs,
/// roles, timestamps, and subagent identity — never mutable content like
/// text segments or confirmation states. Cache invalidation is gated by
/// `refreshMessageListVersionIfNeeded()` which tracks structural changes.
struct CachedMessageLayoutMetadata {
    let displayMessageIds: [UUID]
    let messageIndexById: [UUID: Int]
    let showTimestamp: Set<UUID>
    let hasPrecedingAssistantByIndex: Set<Int>
    let hasUserMessage: Bool
    let latestAssistantId: UUID?
    let subagentsByParent: [UUID: [SubagentInfo]]
    let orphanSubagents: [SubagentInfo]
    let effectiveStatusText: String?
}

// MARK: - Message List Derived State

/// All derived values needed by the message list body. Combines cached
/// structural metadata (from `CachedMessageLayoutMetadata`) with live
/// content-derived state computed fresh each body evaluation. Content
/// fields (message data, confirmation placement, thinking indicators)
/// are always live so SwiftUI's `.equatable()` diffing sees every mutation.
struct MessageListDerivedState {
    // --- Cached structural metadata (from CachedMessageLayoutMetadata) ---
    let displayMessageIds: [UUID]
    let messageIndexById: [UUID: Int]
    let showTimestamp: Set<UUID>
    let hasPrecedingAssistantByIndex: Set<Int>
    let hasUserMessage: Bool
    let latestAssistantId: UUID?
    let subagentsByParent: [UUID: [SubagentInfo]]
    let orphanSubagents: [SubagentInfo]
    let effectiveStatusText: String?

    // --- Live content-derived state (always fresh) ---
    let displayMessageById: [UUID: ChatMessage]
    let activePendingRequestId: String?
    let nextDecidedConfirmationByIndex: [Int: ToolConfirmationData]
    let isConfirmationRenderedInlineByIndex: Set<Int>
    let anchoredThinkingIndex: Int?
    let hasActiveToolCall: Bool
    let canInlineProcessing: Bool
    let shouldShowThinkingIndicator: Bool
    let hasMessages: Bool
}
