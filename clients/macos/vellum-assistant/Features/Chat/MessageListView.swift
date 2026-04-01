import AppKit
import Combine
import os
import os.signpost
import SwiftUI
import VellumAssistantShared

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "MessageListView")
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
    @AppStorage("hasEverSentMessage") private var hasEverSentMessage: Bool = false
    @AppStorage("completedConversationCount") private var completedConversationCount: Int = 0
    @State private var appearance = AvatarAppearanceManager.shared
    /// Read at the list level and passed down to each ChatBubble so that
    /// individual bubbles don't each subscribe to the shared manager.
    /// With @Observable fine-grained tracking, reading only `activeSurfaceId`
    /// won't trigger re-renders on frequent `data` progress ticks.
    var taskProgressManager = TaskProgressOverlayManager.shared
    /// Consolidates all scroll-related state with `@Observable` fine-grained
    /// per-property tracking. Each UI-facing property (`showTailSpacer`,
    /// `showScrollToLatest`, `scrollIndicatorsHidden`) is individually tracked,
    /// so SwiftUI only re-evaluates views that read the specific property that
    /// changed. See `MessageListScrollState.swift` for details.
    @State private var scrollState = MessageListScrollState()
    /// In-flight resize scroll stabilization task; cancelled on each new resize.
    @State private var resizeScrollTask: Task<Void, Never>?
    /// Native SwiftUI scroll position struct (macOS 15+). Replaces
    /// `ScrollViewReader` + `proxy.scrollTo()` and distance-from-bottom math.
    @State private var scrollPosition = ScrollPosition()

    /// The subset of messages actually shown, honoring the pagination window.
    /// Reads the pre-computed cache from the model layer in O(1) instead of
    /// running the O(n) visibility filter on every body evaluation.
    ///
    /// - SeeAlso: [WWDC23 — Demystify SwiftUI performance](https://developer.apple.com/videos/play/wwdc2023/10160/)
    private var visibleMessages: [ChatMessage] {
        paginatedVisibleMessages
    }

    /// Checks whether observable message-level inputs have changed since the
    /// last body evaluation and, if so, bumps `scrollState.messageListVersion`.
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

        // O(n) hash of visible message IDs — catches "same count, different
        // IDs" scenarios where hasRenderableContent changes cause different
        // messages to pass the visibility filter without changing the count.
        var idHasher = Hasher()
        for msg in visibleMessages { idHasher.combine(msg.id) }
        let currentIdFingerprint = idHasher.finalize()

        var changed = false

        if currentRawCount != scrollState.lastKnownRawMessageCount {
            scrollState.lastKnownRawMessageCount = currentRawCount
            changed = true
        }
        if currentVisibleCount != scrollState.lastKnownVisibleMessageCount {
            scrollState.lastKnownVisibleMessageCount = currentVisibleCount
            changed = true
        }
        if currentLastStreaming != scrollState.lastKnownLastMessageStreaming {
            scrollState.lastKnownLastMessageStreaming = currentLastStreaming
            changed = true
        }
        if currentIncompleteToolCalls != scrollState.lastKnownIncompleteToolCallCount {
            scrollState.lastKnownIncompleteToolCallCount = currentIncompleteToolCalls
            changed = true
        }
        if currentIdFingerprint != scrollState.lastKnownVisibleIdFingerprint {
            scrollState.lastKnownVisibleIdFingerprint = currentIdFingerprint
            changed = true
        }

        if changed {
            scrollState.messageListVersion += 1
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

    /// Computes all derived values needed by the message list body.
    ///
    /// Structural metadata (IDs, timestamps, role-based indices, subagent
    /// grouping) is memoized behind a lightweight O(1) cache key stored on
    /// the `@ObservationIgnored` fields of `MessageListScrollState`. Content-derived state
    /// (message data, confirmation placement, thinking indicators) is
    /// always computed fresh from the live `visibleMessages` array so
    /// SwiftUI's `.equatable()` diffing sees every mutation.
    private var derivedState: MessageListDerivedState {
        os_signpost(.begin, log: stallLog, name: "DerivedState.resolve")
        scrollState.recordBodyEvaluation()

        if scrollState.isThrottled, let cached = scrollState.cachedDerivedStateBox as? MessageListDerivedState {
            os_signpost(.end, log: stallLog, name: "DerivedState.resolve")
            return cached
        }

        // Compute visible messages first so version tracking and layout
        // both operate on the same filtered set.
        let liveMessages = visibleMessages
        scrollState.cachedFirstVisibleMessageId = liveMessages.first?.id
        refreshMessageListVersionIfNeeded(visibleMessages: liveMessages)

        let key = PrecomputedCacheKey(
            messageListVersion: scrollState.messageListVersion,
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
        if key == scrollState.cachedLayoutKey,
           let cached = scrollState.cachedLayoutMetadata,
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
            os_signpost(.event, log: stallLog, name: "DerivedState.layoutCacheMiss", "version=%d", scrollState.messageListVersion)

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
            scrollState.cachedLayoutKey = key
            scrollState.cachedLayoutMetadata = layout
        }

        // --- Stage 2: Live content-derived state (always fresh) ---

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

        scrollState.cachedDerivedStateBox = result
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

    /// Restores scroll-to-bottom after a conversation load or app restart.
    /// Issues a delayed fallback pin that catches cases where the declarative
    /// `ScrollPosition(edge: .bottom)` hasn't fully resolved for the new content.
    /// The `isAtBottom` guard is intentionally omitted: during a conversation
    /// switch, `isAtBottom` is unreliable because scroll geometry hasn't updated
    /// yet for the new content. An extra pin when already at bottom is a no-op.
    private func restoreScrollToBottom() {
        scrollState.scrollRestoreTask?.cancel()
        scrollState.scrollRestoreTask = Task { @MainActor [scrollState] in
            try? await Task.sleep(nanoseconds: 100_000_000)
            guard !Task.isCancelled else { return }
            if anchorMessageId == nil
                && !scrollState.hasBeenInteracted
            {
                os_signpost(.event, log: PerfSignposts.log, name: "scrollRestoreStage", "stage=fallback")
                scrollState.transition(to: .followingBottom)
                scrollState.requestPinToBottom()
            }
            scrollState.scrollRestoreTask = nil
        }
    }

    /// Flash-highlights a message and schedules auto-dismiss after 1.5 seconds.
    private func flashHighlight(messageId: UUID) {
        scrollState.highlightDismissTask?.cancel()
        highlightedMessageId = messageId
        scrollState.highlightDismissTask = Task { @MainActor [scrollState] in
            do {
                try await Task.sleep(nanoseconds: 1_500_000_000)
            } catch { return }
            guard !Task.isCancelled else { return }
            withAnimation(VAnimation.slow) {
                highlightedMessageId = nil
            }
            scrollState.highlightDismissTask = nil
        }
    }

    /// Configures scroll action closures on the scroll state so it can
    /// perform programmatic scrolls via the view-owned ScrollPosition.
    private func configureScrollCallbacks() {
        let binding = $scrollPosition
        scrollState.scrollTo = { id, anchor in
            if let stringId = id as? String {
                binding.wrappedValue.scrollTo(id: stringId, anchor: anchor)
            } else if let uuidId = id as? UUID {
                binding.wrappedValue.scrollTo(id: uuidId, anchor: anchor)
            }
        }
        scrollState.scrollToEdge = { edge in
            binding.wrappedValue.scrollTo(edge: edge)
        }
        scrollState.currentConversationId = conversationId
    }

    /// Handles confirmation focus handoff: when a new pending confirmation
    /// appears, resign first responder from the composer so the confirmation
    /// bubble's key monitor can intercept Tab/Enter/Escape immediately.
    #if os(macOS)
    private func handleConfirmationFocusIfNeeded() {
        if let requestId = activePendingRequestId, scrollState.lastAutoFocusedRequestId != requestId {
            if let window = NSApp.keyWindow,
               let responder = window.firstResponder as? NSTextView,
               responder.isEditable {
                window.makeFirstResponder(nil)
                scrollState.lastAutoFocusedRequestId = requestId
            }
        } else if activePendingRequestId == nil {
            scrollState.lastAutoFocusedRequestId = nil
        }
    }
    #endif

    /// Evaluates a pagination sentinel preference change and triggers pagination
    /// if the sentinel entered the trigger band.
    private func handlePaginationSentinel(sentinelMinY: CGFloat) {
        guard PreferenceGeometryFilter.evaluate(
            newValue: sentinelMinY,
            previous: .infinity,
            deadZone: 0
        ) != .rejectNonFinite else { return }

        let isInRange = MessageListPaginationTriggerPolicy.isInTriggerBand(
            sentinelMinY: sentinelMinY,
            viewportHeight: scrollState.viewportHeight
        )
        let shouldFire = MessageListPaginationTriggerPolicy.shouldTrigger(
            sentinelMinY: sentinelMinY,
            viewportHeight: scrollState.viewportHeight,
            wasInRange: scrollState.wasPaginationTriggerInRange
        )
        guard shouldFire,
              hasMoreMessages,
              !isLoadingMoreMessages,
              !scrollState.isPaginationInFlight
        else { return }

        guard Date().timeIntervalSince(scrollState.lastPaginationCompletedAt) > 0.5 else { return }

        // Fire pagination — update edge state only now so guard rejections
        // (including cooldown) don't consume the one-shot rising edge.
        scrollState.wasPaginationTriggerInRange = isInRange
        scrollState.isPaginationInFlight = true
        let anchorId = scrollState.cachedFirstVisibleMessageId
        let taskConversationId = scrollState.currentConversationId
        os_signpost(.event, log: PerfSignposts.log, name: "paginationSentinelFired")
        scrollState.paginationTask = Task { [scrollState] in
            defer {
                if !Task.isCancelled {
                    scrollState.lastPaginationCompletedAt = Date()
                    scrollState.isPaginationInFlight = false
                    scrollState.paginationTask = nil
                } else if scrollState.paginationTask == nil,
                          scrollState.currentConversationId == taskConversationId {
                    scrollState.lastPaginationCompletedAt = Date()
                    scrollState.isPaginationInFlight = false
                }
            }
            let hadMore = await loadPreviousMessagePage?() ?? false
            if hadMore, let id = anchorId {
                    scrollState.beginStabilization(.pagination)
                    try? await Task.sleep(nanoseconds: 100_000_000)
                    guard !Task.isCancelled else {
                        scrollState.endStabilization()
                        return
                    }
                    os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested", "target=paginationAnchor")
                    scrollState.performScrollTo(id, anchor: .top)
                    scrollState.endStabilization()
            }
        }
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

    /// The scroll view's main content: LazyVStack of message cells,
    /// pagination sentinel, thinking indicators, and tail spacer.
    @ViewBuilder
    private var scrollViewContent: some View {
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
            }

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
                        hasEverSentMessage: hasEverSentMessage,
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
                    // onScrollGeometryChange tracking to manage mode —
                    // LazyVStack fires onAppear in the prefetch zone (several screens
                    // ahead) which would prematurely re-tether during normal scrolling.
                    if !scrollState.hasBeenInteracted {
                        scrollState.handleReachedBottom()
                    }
                }

            TailSpacerView(scrollState: scrollState)
        }
        .disabled(!isInteractionEnabled)
        .padding(.horizontal, VSpacing.xl)
        .padding(.top, VSpacing.md)
        .padding(.bottom, VSpacing.md)
        .frame(maxWidth: VSpacing.chatColumnMaxWidth)
        .frame(maxWidth: .infinity)
        .environment(\.bubbleMaxWidth, containerWidth > 0
            ? min(VSpacing.chatBubbleMaxWidth, max(containerWidth - 2 * VSpacing.xl, 0))
            : VSpacing.chatBubbleMaxWidth)
    }

    // MARK: - Scroll geometry handler

    private func handleScrollGeometryUpdate(_ newState: ScrollGeometrySnapshot) {
        // --- Scroll direction detection ---
        let effectiveContentHeight = newState.contentHeight - scrollState.tailSpacerHeight
        let isScrollable = effectiveContentHeight > newState.containerHeight || scrollState.mode.pushToTopMessageId != nil
        let isScrollingUp = newState.contentOffsetY < scrollState.lastContentOffsetY
        scrollState.scrollContentHeight = newState.contentHeight
        scrollState.scrollContainerHeight = newState.containerHeight
        scrollState.lastContentOffsetY = newState.contentOffsetY

        // Only detach on direct user gesture (interacting), not momentum.
        // Only detach when content is scrollable (prevents false detaches
        // on short conversations).
        if scrollState.scrollPhase == .interacting && isScrollingUp && isScrollable {
            scrollState.scrollRestoreTask?.cancel()
            scrollState.scrollRestoreTask = nil
            scrollState.handleUserScrollUp()
        }

        // --- Viewport height update ---
        // Filter non-finite viewport heights and sub-pixel jitter.
        // A 0.5pt dead-zone prevents floating-point rounding differences
        // from triggering continuous updates that feed back into layout.
        let decision = PreferenceGeometryFilter.evaluate(
            newValue: newState.visibleRectHeight,
            previous: scrollState.viewportHeight,
            deadZone: 0.5
        )
        if case .accept(let accepted) = decision {
            os_signpost(.begin, log: PerfSignposts.log, name: "viewportHeightChanged")
            scrollState.viewportHeight = accepted
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
        if scrollState.isAtBottom {
            // Stay "at bottom" until clearly scrolled away.
            nowAtBottom = distanceFromBottom.isFinite && distanceFromBottom <= 30
        } else {
            // Only re-enter "at bottom" when truly close.
            nowAtBottom = distanceFromBottom.isFinite && distanceFromBottom <= 10
        }
        if scrollState.isAtBottom != nowAtBottom {
            scrollState.isAtBottom = nowAtBottom
            if nowAtBottom {
                scrollState.handleReachedBottom()
            }
        }

        // --- Push-to-top overflow detection ---
        // Only clear push-to-top if the pin request succeeds.
        // When the user has detached from bottom, pinToBottom returns
        // false. Clearing pushToTopMessageId without a successful pin
        // removes the tail spacer without the accompanying scroll
        // adjustment, causing a content-height discontinuity that
        // makes the scroll position jump.
        if scrollState.mode.pushToTopMessageId != nil && distanceFromBottom > 50 {
            scrollState.handlePushToTopOverflow()
        }

        // --- Pagination trigger ---
        // Derive pagination from scroll offset instead of a
        // GeometryReader+PreferenceKey sentinel inside the
        // LazyVStack. The old sentinel reported minY in the
        // ScrollView coordinate space (0 at viewport top,
        // negative when scrolled past). contentOffsetY has
        // inverted sign (0 at top, positive when scrolled
        // down), so we negate to preserve the same semantics.
        handlePaginationSentinel(
            sentinelMinY: -newState.contentOffsetY
        )
    }

    // MARK: - Lifecycle handlers

    private func handleAppear() {
        configureScrollCallbacks()
        // Seed the confirmation marker on initial mount — conversationSwitched
        // doesn't fire for the initial value, so a conversation already paused
        // in awaiting_confirmation at launch or reconnect needs the marker set here.
        if !isSending {
            scrollState.lastActivityPhaseWhenIdle = assistantActivityPhase
        }
        if let id = anchorMessageId, messages.contains(where: { $0.id == id }) {
            // Anchor is already set and the target message is loaded —
            // scroll to it immediately instead of falling through to bottom.
            os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested", "target=anchorMessage reason=onAppear")
            os_signpost(.event, log: PerfSignposts.log, name: "anchorCleared", "reason=foundOnAppear")
            $scrollPosition.wrappedValue.scrollTo(id: id, anchor: .center)
            flashHighlight(messageId: id)
            anchorMessageId = nil
            scrollState.anchorSetTime = nil
        } else if anchorMessageId != nil {
            // Anchor is set but the target message isn't loaded yet.
            os_signpost(.event, log: PerfSignposts.log, name: "anchorSet", "reason=onAppearPending")
            if scrollState.anchorSetTime == nil { scrollState.anchorSetTime = Date() }
            // Start the independent timeout if not already running.
            if scrollState.anchorTimeoutTask == nil {
                    scrollState.anchorTimeoutTask = Task { @MainActor [scrollState] in
                        do {
                            try await Task.sleep(nanoseconds: 10_000_000_000)
                        } catch { return }
                        guard !Task.isCancelled, anchorMessageId != nil else { return }
                        os_signpost(.event, log: PerfSignposts.log, name: "anchorTimedOut")
                        log.debug("Anchor message not found (timed out) — clearing stale anchor")
                        anchorMessageId = nil
                        scrollState.anchorSetTime = nil
                        scrollState.anchorTimeoutTask = nil
                        scrollState.transition(to: .followingBottom)
                        scrollState.requestPinToBottom(animated: true, userInitiated: true)
                    }
            }
        } else {
            if !scrollState.hasBeenInteracted {
                scrollState.scrollToEdge?(.bottom)
            }
            restoreScrollToBottom()
        }
    }

    // MARK: - onChange handlers

    private func handleSendingChanged() {
        if isSending {
            // Clear stale confirmation marker: if the phase left "awaiting_confirmation"
            // while not sending, the marker is stale.
            let effectivePhase: String
            if scrollState.lastActivityPhaseWhenIdle == "awaiting_confirmation"
                && assistantActivityPhase != "awaiting_confirmation"
            {
                effectivePhase = assistantActivityPhase
            } else {
                effectivePhase = scrollState.lastActivityPhaseWhenIdle
            }
            // Reattach and pin to bottom for user-initiated actions (send,
            // regenerate, retry). Skip reattach only when the daemon resumes
            // from a tool confirmation (not a user action during confirmation).
            let isDaemonConfirmationResume =
                effectivePhase == "awaiting_confirmation"
                && assistantActivityPhase != "awaiting_confirmation"
            if isDaemonConfirmationResume && !scrollState.isFollowingBottom {
                // Daemon resumed from confirmation while user was scrolled up.
            } else {
                // For user-initiated sends, scroll the user's message to
                // the viewport top with space below for the assistant's
                // response. Daemon confirmation resumes stay bottom-pinned.
                if !isDaemonConfirmationResume, let lastUserMsg = messages.last(where: { $0.role == .user }) {
                    scrollState.enterPushToTop(messageId: lastUserMsg.id)
                    os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested",
                                "target=userMessage reason=pushToTop")
                } else {
                    scrollState.transition(to: .followingBottom)
                    scrollState.requestPinToBottom(animated: true)
                }
            }
        } else {
            // Capture the activity phase at the moment sending stops.
            scrollState.lastActivityPhaseWhenIdle = assistantActivityPhase
            // End push-to-top phase and scroll to bottom so the user
            // sees the complete response.
            if scrollState.mode.pushToTopMessageId != nil {
                scrollState.exitPushToTop(animated: true)
            }
            // First-message detection.
            if !hasEverSentMessage && messages.contains(where: { $0.role == .user }) {
                hasEverSentMessage = true
            }
        }
    }

    private func handleMessagesCountChanged() {
        // --- Anchor message resolution ---
        if let id = anchorMessageId, messages.contains(where: { $0.id == id }) {
            os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested", "target=anchorMessage reason=messagesChanged")
            os_signpost(.event, log: PerfSignposts.log, name: "anchorCleared", "reason=foundInMessages")
            scrollState.transition(to: .programmaticScroll(reason: .deepLinkAnchor(id: id)))
            withAnimation {
                scrollState.scrollTo?(id, .center)
            }
            flashHighlight(messageId: id)
            anchorMessageId = nil
            scrollState.anchorSetTime = nil
            scrollState.anchorTimeoutTask?.cancel()
            scrollState.anchorTimeoutTask = nil
            return
        }
        // If anchor is set but the target message still hasn't appeared,
        // check pagination exhaustion with a minimum elapsed time guard.
        if anchorMessageId != nil {
            let paginationExhausted = !hasMoreMessages
            let minWaitElapsed = scrollState.anchorSetTime.map { Date().timeIntervalSince($0) > 2 } ?? false
            if paginationExhausted && minWaitElapsed {
                os_signpost(.event, log: PerfSignposts.log, name: "anchorCleared", "reason=paginationExhausted")
                log.debug("Anchor message not found (pagination exhausted) — clearing stale anchor")
                anchorMessageId = nil
                scrollState.anchorSetTime = nil
                scrollState.anchorTimeoutTask?.cancel()
                scrollState.anchorTimeoutTask = nil
                scrollState.transition(to: .followingBottom)
                scrollState.requestPinToBottom(animated: true)
                return
            }
        }
        // --- Bottom-pin on new messages ---
        if scrollState.mode.pushToTopMessageId != nil && anchorMessageId == nil {
            // no-op: push-to-top suppresses bottom-pin
        } else if anchorMessageId == nil {
            scrollState.requestPinToBottom(animated: true)
        }
        // --- Confirmation focus handoff ---
        #if os(macOS)
        handleConfirmationFocusIfNeeded()
        #endif
    }

    private func handleContainerWidthChanged() {
        guard containerWidth > 0, abs(containerWidth - scrollState.lastHandledContainerWidth) > 2 else { return }
        scrollState.lastHandledContainerWidth = containerWidth
        resizeScrollTask?.cancel()
        resizeScrollTask = Task { @MainActor [scrollState] in
            scrollState.beginStabilization(.resize)
            defer {
                if !Task.isCancelled { resizeScrollTask = nil }
            }
            try? await Task.sleep(nanoseconds: 100_000_000)
            guard !Task.isCancelled else {
                scrollState.endStabilization()
                return
            }
            scrollState.endStabilization()
            if scrollState.isFollowingBottom && anchorMessageId == nil && !scrollState.isAtBottom {
                scrollState.requestPinToBottom()
            }
        }
    }

    private func handleConversationSwitched() {
        // Reset view-local state.
        resizeScrollTask?.cancel()
        resizeScrollTask = nil
        highlightedMessageId = nil
        scrollState.highlightDismissTask?.cancel()
        scrollState.highlightDismissTask = nil
        // Reset scroll state for the new conversation.
        scrollState.reset(for: conversationId)
        // Capture the new conversation's activity phase so a conversation
        // already paused in awaiting_confirmation is correctly tracked.
        scrollState.lastActivityPhaseWhenIdle = isSending ? "" : assistantActivityPhase
        scrollState.lastHandledContainerWidth = containerWidth
        scrollState.anchorTimeoutTask?.cancel()
        scrollState.anchorTimeoutTask = nil
        scrollState.lastAutoFocusedRequestId = nil
        // When switching to a conversation that is already actively sending,
        // .onChange(of: isSending) won't fire (the value doesn't change), so
        // mode stays .initialLoad. Transition to .followingBottom now so that
        // requestPinToBottom() can issue pins for streaming messages.
        if isSending {
            scrollState.transition(to: .followingBottom)
        }
        // Declarative position reset — processed in the same layout pass as new content.
        // https://developer.apple.com/documentation/swiftui/scrollposition
        scrollState.scrollRestoreTask?.cancel()
        if anchorMessageId == nil {
            scrollPosition = ScrollPosition(edge: .bottom)
        }
        restoreScrollToBottom()
    }

    private func handleAnchorMessageTask() async {
        // task(id:) fires on initial value and on changes. Only process
        // non-nil anchor assignments; nil transitions are cleanup handled
        // by messagesChanged and conversationSwitched.
        guard let id = anchorMessageId else { return }
        // Cancel scroll restore when a new anchor is set.
        scrollState.scrollRestoreTask?.cancel()
        scrollState.scrollRestoreTask = nil
        scrollState.transition(to: .programmaticScroll(reason: .deepLinkAnchor(id: id)))
        scrollState.anchorSetTime = Date()
        scrollState.anchorTimeoutTask?.cancel()
        scrollState.anchorTimeoutTask = nil
        os_signpost(.event, log: PerfSignposts.log, name: "anchorSet", "reason=anchorMessageIdChanged")
        if messages.contains(where: { $0.id == id }) {
            os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested", "target=anchorMessage reason=anchorChanged")
            os_signpost(.event, log: PerfSignposts.log, name: "anchorCleared", "reason=foundOnAnchorChange")
            withAnimation {
                scrollState.scrollTo?(id, .center)
            }
            flashHighlight(messageId: id)
            anchorMessageId = nil
            scrollState.anchorSetTime = nil
        } else {
            // Start an independent 10-second timeout that clears the
            // anchor even if messages.count never changes.
            scrollState.anchorTimeoutTask = Task { @MainActor [scrollState] in
                do {
                    try await Task.sleep(nanoseconds: 10_000_000_000)
                } catch { return }
                guard !Task.isCancelled, anchorMessageId != nil else { return }
                os_signpost(.event, log: PerfSignposts.log, name: "anchorTimedOut")
                log.debug("Anchor message not found (timed out) — clearing stale anchor")
                anchorMessageId = nil
                scrollState.anchorSetTime = nil
                scrollState.anchorTimeoutTask = nil
                scrollState.requestPinToBottom(animated: true, userInitiated: true)
            }
        }
    }

    var body: some View {
        #if DEBUG
        let _ = os_signpost(.event, log: PerfSignposts.log, name: "MessageListView.body")
        #endif
            ScrollView {
                scrollViewContent
            }
            .scrollContentBackground(.hidden)
            .coordinateSpace(name: "chatScrollView")
            .scrollDisabled(messages.isEmpty && !isSending)
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .scrollPosition($scrollPosition)
            .environment(\.suppressAutoScroll, { [self] in
                scrollState.endStabilization()
                if scrollState.isFollowingBottom {
                    os_signpost(.event, log: PerfSignposts.log, name: "scrollSuppressionChanged", "on reason=expansionPinning")
                    scrollState.requestPinToBottom()
                } else {
                    os_signpost(.event, log: PerfSignposts.log, name: "scrollSuppressionChanged", "on reason=offBottomExpansion")
                    scrollState.beginStabilization(.expansion)
                }
            })
            .onScrollPhaseChange { oldPhase, newPhase in
                scrollState.scrollPhase = newPhase
                if newPhase == .idle && oldPhase != .idle && scrollState.isAtBottom {
                    if oldPhase == .interacting || oldPhase == .decelerating,
                       scrollState.mode.pushToTopMessageId != nil {
                        scrollState.exitPushToTop(animated: false)
                    }
                    scrollState.handleReachedBottom()
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
                handleScrollGeometryUpdate(newState)
            }
            .scrollIndicators(scrollState.scrollIndicatorsHidden ? .hidden : .automatic)
            .overlay(alignment: .bottom) {
                ScrollToLatestOverlayView(scrollState: scrollState)
            }
            .onAppear { handleAppear() }
            .onDisappear {
                scrollState.cancelAll()
                resizeScrollTask?.cancel()
                resizeScrollTask = nil
                highlightedMessageId = nil
            }
            .onChange(of: isSending) { handleSendingChanged() }
            .onChange(of: messages.count) { handleMessagesCountChanged() }
            .onChange(of: containerWidth) { handleContainerWidthChanged() }
            .onChange(of: conversationId) { _, _ in handleConversationSwitched() }
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

// MARK: - TailSpacerView

/// Isolated child view for the push-to-top tail spacer. Creates its own
/// observation boundary so changes to `showTailSpacer` only invalidate this
/// view — not the parent `LazyVStack` or `ForEach`.
///
/// Reference: [WWDC23 — Discover Observation in SwiftUI](https://developer.apple.com/videos/play/wwdc2023/10149/)
private struct TailSpacerView: View {
    let scrollState: MessageListScrollState

    var body: some View {
        if scrollState.showTailSpacer {
            Color.clear
                .frame(height: scrollState.tailSpacerHeight)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
                .onAppear {
                    scrollState.consumePendingPushToTop()
                }
        }
    }
}

// MARK: - ScrollToLatestOverlayView

/// Isolated child view for the "Scroll to latest" CTA. Creates its own
/// observation boundary so changes to `showScrollToLatest` only invalidate
/// this view — not the parent `MessageListView.body` or `ForEach`.
private struct ScrollToLatestOverlayView: View {
    let scrollState: MessageListScrollState

    var body: some View {
        if scrollState.showScrollToLatest {
            Button(action: {
                os_signpost(.event, log: PerfSignposts.log, name: "scrollToLatestPressed")
                scrollState.requestPinToBottom(animated: true, userInitiated: true)
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
            && lhs.hasEverSentMessage == rhs.hasEverSentMessage
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
            && lhs.mediaEmbedSettings == rhs.mediaEmbedSettings
    }

    let message: ChatMessage
    let index: Int
    let showTimestamp: Bool
    let nextDecidedConfirmation: ToolConfirmationData?
    let isConfirmationRenderedInline: Bool
    let hasPrecedingAssistant: Bool
    let hasUserMessage: Bool
    let hasEverSentMessage: Bool
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
    var onConfirmationAllow: ((String) -> Void)?
    var onConfirmationDeny: ((String) -> Void)?
    var onAlwaysAllow: ((String, String, String, String) -> Void)?
    var onTemporaryAllow: ((String, String) -> Void)?
    var onGuardianAction: ((String, String) -> Void)?
    var onSurfaceAction: ((String, String, [String: AnyCodable]?) -> Void)?
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
                onSurfaceAction: onSurfaceAction ?? { _, _, _ in },
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
            .equatable()
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
                        onAllow: { onConfirmationAllow?(confirmation.requestId) },
                        onDeny: { onConfirmationDeny?(confirmation.requestId) },
                        onAlwaysAllow: onAlwaysAllow ?? { _, _, _, _ in },
                        onTemporaryAllow: onTemporaryAllow
                    )
                    .id(message.id)
                }
            } else {
                if !hasPrecedingAssistant {
                    ToolConfirmationBubble(
                        confirmation: confirmation,
                        onAllow: { onConfirmationAllow?(confirmation.requestId) },
                        onDeny: { onConfirmationDeny?(confirmation.requestId) },
                        onAlwaysAllow: onAlwaysAllow ?? { _, _, _, _ in },
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
                onSurfaceAction: onSurfaceAction ?? { _, _, _ in },
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
            .equatable()
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



// MARK: - Cached Message Layout Metadata

/// Structural metadata cached behind a version-counter key on
/// `MessageListScrollState`. Contains only fields derived from message IDs,
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
