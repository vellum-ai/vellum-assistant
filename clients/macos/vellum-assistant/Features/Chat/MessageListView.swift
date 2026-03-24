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
/// Pattern mirrors `AnchorVisibilityTracker.lastMinY` (not @Published).
@MainActor final class ScrollTrackingState {
    /// Last reported ConversationTailAnchorYKey value.
    /// Only used for the 2pt dead-zone check in the preference handler.
    var lastTailAnchorY: CGFloat = .infinity
    /// Pending avatar Y position awaiting smoothing delay.
    var pendingAvatarY: CGFloat?
    /// Timestamp of the last applied avatar display Y update.
    var avatarLastAppliedAt: Date?
    /// Non-reactive avatar anchor Y position. Only used for threshold
    /// comparisons and visibility boundary detection — never read during
    /// body evaluation for rendering, so mutations do not trigger re-renders.
    var avatarTargetY: CGFloat = .infinity
    /// Debounced task for transcript snapshot updates, coalescing rapid scroll
    /// events into a single snapshot capture per 150ms window.
    var snapshotDebounceTask: Task<Void, Never>?

    // MARK: - PrecomputedState Cache

    /// Cache key for the last computed `PrecomputedMessageListState`.
    var cachedPrecomputedKey: PrecomputedCacheKey?
    /// Cached result for `precomputedState`, returned on cache hit.
    var cachedPrecomputedState: PrecomputedMessageListState?

    // MARK: - Version Counter (O(1) fingerprint replacement)

    /// Monotonically increasing counter that replaces the O(n) per-body-eval
    /// `computeMessageFingerprint()` hash. Incremented when any of the following
    /// triggers fire:
    /// - `messages.count` changes (new message appended or pagination load)
    /// - `isSending` or `isThinking` transitions (activity state change)
    /// - `messages.last?.isStreaming` transitions (end of streaming)
    /// - A tool call's `isComplete` transitions (observable via messages array
    ///   identity change in SwiftUI)
    ///
    /// Over-invalidation is safe (triggers a recompute); under-invalidation is not.
    var messageListVersion: Int = 0

    /// Cached message count for detecting structural changes.
    var lastKnownMessageCount: Int = 0
    /// Cached streaming state of the last message.
    var lastKnownLastMessageStreaming: Bool = false
    /// Cached count of incomplete tool calls across all messages.
    var lastKnownIncompleteToolCallCount: Int = 0
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
    /// Read once at the list level and passed down to each ChatBubble so that
    /// individual bubbles don't each subscribe to the shared ObservableObject.
    /// Only the active surface ID is needed here (to suppress inline rendering).
    /// Observing the full TaskProgressOverlayManager would cause the entire
    /// message list to re-render on every frequent `data` progress tick.
    @State private var activeSurfaceId: String?
    /// Tracks the last pending confirmation request ID that triggered an
    /// auto-focus handoff. Used to detect nil→non-nil transitions so we
    /// resign first responder exactly once per new confirmation appearance.
    @State private var lastAutoFocusedRequestId: String?
    /// Consolidates all scroll-related state: anchor tracking, scroll loop guard,
    /// bottom pin coordinator, suppression flags, and scroll-related tasks.
    @StateObject private var scrollCoordinator = MessageListScrollCoordinator()
    /// The scroll view's viewport height, captured via preference key. Used by
    /// the anchor GeometryReader to determine if the anchor is within bounds.
    @State private var scrollViewportHeight: CGFloat = .infinity
    /// Timestamp when anchorMessageId was set. Used together with pagination
    /// exhaustion to decide when a stale anchor should be cleared.
    @State private var anchorSetTime: Date?
    /// Independent timer task that clears a stale anchor after 10 seconds,
    /// regardless of whether messages.count changes. This covers the edge
    /// case where pagination stalls without adding/removing messages.
    @State private var anchorTimeoutTask: Task<Void, Never>?
    /// Last container width that triggered a resize scroll handler, used to
    /// detect meaningful width changes (>2pt) and avoid sub-pixel jitter.
    @State private var lastHandledContainerWidth: CGFloat = 0
    /// In-flight resize scroll stabilization task; cancelled on each new resize.
    @State private var resizeScrollTask: Task<Void, Never>?
    /// Task that clears the highlight flash after the animation duration.
    @State private var highlightDismissTask: Task<Void, Never>?
    @State private var isAvatarVisible: Bool = false
    @State private var avatarDisplayY: CGFloat = .infinity
    @State private var avatarSmoothingTask: Task<Void, Never>?
    @State private var hasPlayedTailEntryAnimation = false
    /// Captures the `assistantActivityPhase` at the moment `isSending` goes false.
    /// Used to distinguish mid-turn tool-confirmation pauses (phase == "awaiting_confirmation")
    /// from genuine turn endings, so the `onChange(of: isSending)` handler can decide
    /// whether to reattach the scroll position on the next `isSending = true` transition.
    @State private var phaseWhenSendingStopped: String = ""

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
    /// All checks are O(1) — we only inspect `messages.count`,
    /// `messages.last?.isStreaming`, and the last message's tool call completion
    /// states (typically 0–3 tool calls). `isSending` / `isThinking` transitions
    /// are handled via `PrecomputedCacheKey` fields directly.
    ///
    /// Mutation paths that affect `PrecomputedMessageListState` inputs:
    /// - `messages.count` changes (append, pagination, deletion)
    /// - `messages.last?.isStreaming` transitions (end of streaming)
    /// - Tool call `isComplete` transitions — detected via the last message's
    ///   tool calls (active tool calls are always on the most recent assistant
    ///   message) and via `messages.count` changes when tool results arrive
    private func refreshMessageListVersionIfNeeded() {
        let currentCount = messages.count
        let currentLastStreaming = messages.last?.isStreaming ?? false
        // Tool call completion is detected via the incomplete count on the
        // last message only — active tool calls live on the tail assistant
        // message, and completion of older tool calls always coincides with
        // a messages.count change (the tool result message is appended).
        let currentIncompleteToolCalls = messages.last?.toolCalls.filter { !$0.isComplete }.count ?? 0

        var changed = false

        if currentCount != scrollCoordinator.scrollTracking.lastKnownMessageCount {
            scrollCoordinator.scrollTracking.lastKnownMessageCount = currentCount
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

    /// Computes all expensive derived values once per body evaluation.
    /// Moving these out of the LazyVStack closure ensures O(n) scans
    /// (timestamp indices, subagent grouping, turn detection) run once
    /// per body evaluation rather than being re-evaluated on layout passes.
    ///
    /// Memoized behind a lightweight O(1) cache key stored on the
    /// non-reactive `ScrollTrackingState`. The key uses a version counter
    /// (incremented by `refreshMessageListVersionIfNeeded()`) instead of
    /// an O(n) per-message hash, making cache key construction O(1).
    /// Cache hit returns immediately; cache miss runs the full computation.
    /// Storing on the class (not @State) ensures cache updates never
    /// trigger additional body re-evaluations.
    private var precomputedState: PrecomputedMessageListState {
        os_signpost(.begin, log: stallLog, name: "PrecomputedState.resolve")
        refreshMessageListVersionIfNeeded()
        let key = PrecomputedCacheKey(
            messageListVersion: scrollCoordinator.scrollTracking.messageListVersion,
            isSending: isSending,
            isThinking: isThinking,
            isCompacting: isCompacting,
            assistantStatusText: assistantStatusText,
            activeSubagentFingerprint: Self.computeSubagentFingerprint(activeSubagents),
            displayedMessageCount: displayedMessageCount
        )

        if key == scrollCoordinator.scrollTracking.cachedPrecomputedKey,
           let cached = scrollCoordinator.scrollTracking.cachedPrecomputedState {
            #if DEBUG
            // Spot-check cache correctness in debug builds.
            let freshMessages = visibleMessages
            assert(
                cached.displayMessages.count == freshMessages.count,
                "precomputedState cache stale: displayMessages count \(cached.displayMessages.count) vs \(freshMessages.count)"
            )
            #endif
            os_signpost(.end, log: stallLog, name: "PrecomputedState.resolve", "hit")
            return cached
        }

        os_signpost(.event, log: stallLog, name: "PrecomputedState.cacheMiss", "version=%d", scrollCoordinator.scrollTracking.messageListVersion)

        let displayMessages = visibleMessages
        let activePendingRequestId = PendingConfirmationFocusSelector.activeRequestId(from: displayMessages)
        let latestAssistantId = displayMessages.last(where: { $0.role == .assistant })?.id
        let anchoredThinkingIndex = resolvedThinkingAnchorIndex(for: displayMessages)
        let subagentsByParent: [UUID: [SubagentInfo]] = Dictionary(
            grouping: activeSubagents.filter { $0.parentMessageId != nil },
            by: { $0.parentMessageId! }
        )
        let orphanSubagents = activeSubagents.filter { $0.parentMessageId == nil }
        let showTimestamp = timestampIds(for: displayMessages)
        let messageIndexById = Dictionary(displayMessages.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { _, last in last })

        var nextDecidedConfirmationByIndex: [Int: ToolConfirmationData] = [:]
        for i in displayMessages.indices {
            if i + 1 < displayMessages.count,
               let conf = displayMessages[i + 1].confirmation,
               conf.state != .pending {
                nextDecidedConfirmationByIndex[i] = conf
            }
        }

        var isConfirmationRenderedInlineByIndex = Set<Int>()
        for i in displayMessages.indices {
            guard let confirmation = displayMessages[i].confirmation,
                  confirmation.state == .pending,
                  let confirmationToolUseId = confirmation.toolUseId,
                  !confirmationToolUseId.isEmpty else { continue }
            for j in (0..<i).reversed() {
                let msg = displayMessages[j]
                guard msg.role == .assistant, msg.confirmation == nil else { continue }
                if msg.toolCalls.contains(where: { $0.toolUseId == confirmationToolUseId && $0.pendingConfirmation != nil }) {
                    isConfirmationRenderedInlineByIndex.insert(i)
                }
                break
            }
        }

        var hasPrecedingAssistantByIndex = Set<Int>()
        for i in displayMessages.indices where i > 0 {
            if displayMessages[i - 1].role == .assistant {
                hasPrecedingAssistantByIndex.insert(i)
            }
        }

        let hasUserMessage = displayMessages.contains { $0.role == .user }
        let lastVisible = displayMessages.last
        let currentTurnMessages: ArraySlice<ChatMessage> = {
            if isSending, let last = displayMessages.last, last.role == .user {
                let lastNonUser = displayMessages.last(where: {
                    $0.role != .user
                })
                let isActivelyProcessing = lastNonUser?.isStreaming == true
                    || lastNonUser?.confirmation?.state == .pending
                if !isActivelyProcessing {
                    return displayMessages[displayMessages.endIndex...]
                }
            }
            let lastTurnStart = displayMessages.indices.reversed().first(where: { idx in
                displayMessages[idx].role == .user
                    && displayMessages.index(after: idx) < displayMessages.endIndex
                    && displayMessages[displayMessages.index(after: idx)].role != .user
            })
            if let idx = lastTurnStart {
                return displayMessages[displayMessages.index(after: idx)...]
            }
            return displayMessages[displayMessages.startIndex...]
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
        let effectiveStatusText = isCompacting ? "Compacting context\u{2026}" : assistantStatusText

        let result = PrecomputedMessageListState(
            displayMessages: displayMessages,
            messageIndexById: messageIndexById,
            activePendingRequestId: activePendingRequestId,
            latestAssistantId: latestAssistantId,
            anchoredThinkingIndex: anchoredThinkingIndex,
            subagentsByParent: subagentsByParent,
            orphanSubagents: orphanSubagents,
            showTimestamp: showTimestamp,
            nextDecidedConfirmationByIndex: nextDecidedConfirmationByIndex,
            isConfirmationRenderedInlineByIndex: isConfirmationRenderedInlineByIndex,
            hasPrecedingAssistantByIndex: hasPrecedingAssistantByIndex,
            hasUserMessage: hasUserMessage,
            lastVisible: lastVisible,
            currentTurnMessages: currentTurnMessages,
            hasActiveToolCall: hasActiveToolCall,
            wouldShowThinking: wouldShowThinking,
            lastVisibleIsAssistant: lastVisibleIsAssistant,
            canInlineProcessing: canInlineProcessing,
            shouldShowThinkingIndicator: shouldShowThinkingIndicator,
            effectiveStatusText: effectiveStatusText
        )

        scrollCoordinator.scrollTracking.cachedPrecomputedKey = key
        scrollCoordinator.scrollTracking.cachedPrecomputedState = result
        os_signpost(.end, log: stallLog, name: "PrecomputedState.resolve", "miss")
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

    private var lastRenderableMessage: ChatMessage? {
        messages.last(where: {
            if case .queued = $0.status { return false }
            return true
        })
    }

    private var isLastMessageStreaming: Bool {
        lastRenderableMessage?.isStreaming == true
    }

    private var shouldShowConversationTailAvatar: Bool {
        // Intentionally show the avatar under the latest rendered conversation tail
        // (user or assistant content), not only after the first assistant bubble.
        guard !visibleMessages.isEmpty else { return false }
        return isAvatarVisible
    }

    private var shouldPlayTailEntryAnimation: Bool {
        !hasPlayedTailEntryAnimation && messages.count <= 2
    }

    private var shouldCoalesceAvatarUpdates: Bool {
        ConversationAvatarFollower.shouldCoalesce(
            isSending: isSending,
            isThinking: isThinking,
            isLastMessageStreaming: isLastMessageStreaming
        )
    }

    private func applyAvatarDisplayY(forAnchorY anchorY: CGFloat) {
        // Circuit breaker: suppress @State mutations when a scroll loop is detected.
        let convIdString = conversationId?.uuidString ?? "unknown"
        if scrollCoordinator.scrollLoopGuard.isTripped(conversationId: convIdString) { return }

        let y = anchorY + ConversationAvatarFollower.verticalOffset
        // Dead-zone: skip @State update when position hasn't moved meaningfully.
        // Each avatarDisplayY change triggers a MessageListView body re-evaluation;
        // sub-pixel jitter during scroll would otherwise cause continuous re-renders.
        guard abs(avatarDisplayY - y) > 2 else { return }

        // During streaming / sending / thinking, only allow the avatar to move
        // downward (increasing Y).  Auto-scroll viewport adjustments can briefly
        // report a smaller tail-anchor Y, which would yank the avatar back toward
        // the top of the viewport.  Clamping to downward-only movement keeps the
        // avatar tracking smoothly with the growing content.  When coalescing ends
        // (streaming finishes), the onChange handler re-applies the true position.
        if shouldCoalesceAvatarUpdates && avatarDisplayY.isFinite && y < avatarDisplayY {
            return
        }

        recordScrollLoopEvent(.avatarDisplayYApplied)
        scrollCoordinator.scrollTracking.avatarLastAppliedAt = Date()
        // Set @State without withAnimation — the spring animation is applied via
        // .animation() on the avatar view's .offset() modifier instead. This avoids
        // wrapping the mutation in an animation transaction, which would cause SwiftUI
        // to re-evaluate the body on each spring interpolation frame and feed layout
        // shifts back into the tail anchor preference → avatar update cycle.
        avatarDisplayY = y
    }

    private func updateAvatarFollower(anchorY: CGFloat) {
        recordScrollLoopEvent(.avatarFollowerUpdate)
        // Compute visibility once and update @State only on boundary crossings.
        // During an active send, don't hide the avatar on transient non-finite
        // anchors — the LazyVStack briefly deallocates the anchor view during
        // re-layout (thinking indicator, rich UI expansion). Hiding would cause
        // the avatar to flash off-screen via shouldShowConversationTailAvatar.
        let nowVisible = anchorY.isFinite
            && ConversationAvatarFollower.shouldShow(anchorY: anchorY, viewportHeight: scrollViewportHeight)
        let convIdString = conversationId?.uuidString ?? "unknown"
        let isTripped = scrollCoordinator.scrollLoopGuard.isTripped(conversationId: convIdString)
        if isAvatarVisible != nowVisible {
            // Circuit breaker: when tripped, only allow hiding (removing UI is safe).
            // Showing (false→true) adds layout that could feed the loop — suppress it.
            // Send guard: during send, don't hide on transient non-finite anchors.
            if (!isTripped || !nowVisible) && (nowVisible || !isSending) {
                isAvatarVisible = nowVisible
            }
        }

        // Update non-reactive tracking position (no body re-evaluation).
        if ConversationAvatarFollower.shouldUpdateTarget(
            previousAnchorY: scrollCoordinator.scrollTracking.avatarTargetY,
            newAnchorY: anchorY,
            viewportHeight: scrollViewportHeight
        ) {
            scrollCoordinator.scrollTracking.avatarTargetY = anchorY
        }

        guard anchorY.isFinite else {
            avatarSmoothingTask?.cancel()
            avatarSmoothingTask = nil
            scrollCoordinator.scrollTracking.pendingAvatarY = nil
            scrollCoordinator.scrollTracking.avatarLastAppliedAt = nil
            // During an active send, the LazyVStack may transiently deallocate
            // the tail anchor view during re-layout (e.g. thinking indicator
            // insertion, rich UI expansion), producing a non-finite preference.
            // Keep the avatar at its last known position so it doesn't flash
            // off-screen and back. Also suppress when circuit breaker is tripped
            // to avoid @State mutations that feed the scroll loop.
            if !isTripped && !isSending && avatarDisplayY != .infinity {
                avatarDisplayY = .infinity
            }
            return
        }

        // Skip position tracking when the avatar is off-screen. The avatar
        // overlay is hidden via shouldShowConversationTailAvatar, so updating
        // avatarDisplayY for an invisible element just wastes layout passes.
        guard nowVisible else {
            avatarSmoothingTask?.cancel()
            avatarSmoothingTask = nil
            scrollCoordinator.scrollTracking.pendingAvatarY = nil
            return
        }

        let now = Date()
        let delay = ConversationAvatarFollower.smoothingDelay(
            isSending: isSending,
            isThinking: isThinking,
            isLastMessageStreaming: isLastMessageStreaming,
            lastAppliedAt: scrollCoordinator.scrollTracking.avatarLastAppliedAt,
            now: now
        )

        if delay <= 0 {
            avatarSmoothingTask?.cancel()
            avatarSmoothingTask = nil
            scrollCoordinator.scrollTracking.pendingAvatarY = nil
            // Only apply @State avatar position when circuit breaker isn't tripped
            if !isTripped {
                applyAvatarDisplayY(forAnchorY: anchorY)
            }
            return
        }

        scrollCoordinator.scrollTracking.pendingAvatarY = anchorY
        guard avatarSmoothingTask == nil else { return }

        avatarSmoothingTask = Task { @MainActor in
            do {
                try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            } catch {
                return
            }
            guard !Task.isCancelled else { return }
            guard let pending = scrollCoordinator.scrollTracking.pendingAvatarY else {
                avatarSmoothingTask = nil
                return
            }
            scrollCoordinator.scrollTracking.pendingAvatarY = nil
            // Only apply @State avatar position when circuit breaker isn't tripped
            if !scrollCoordinator.scrollLoopGuard.isTripped(conversationId: conversationId?.uuidString ?? "unknown") {
                applyAvatarDisplayY(forAnchorY: pending)
            }
            avatarSmoothingTask = nil
        }
    }

    @ViewBuilder
    private var conversationTailAvatar: some View {
        if shouldShowConversationTailAvatar {
            if appearance.customAvatarImage != nil {
                HStack {
                    VAvatarImage(image: appearance.chatAvatarImage, size: ConversationAvatarFollower.avatarSize)
                        .modifier(AvatarGlowModifier(isActive: isSending))
                    Spacer()
                }
                .padding(.horizontal, VSpacing.xl)
                .frame(maxWidth: VSpacing.chatColumnMaxWidth)
                .frame(maxWidth: .infinity)
                .offset(y: avatarDisplayY)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            } else if let body = appearance.characterBodyShape,
               let eyes = appearance.characterEyeStyle,
               let color = appearance.characterColor {
                AnimatedAvatarView(bodyShape: body, eyeStyle: eyes, color: color,
                                   size: ConversationAvatarFollower.avatarSize,
                                   entryAnimationEnabled: shouldPlayTailEntryAnimation)
                    .frame(width: ConversationAvatarFollower.avatarSize,
                           height: ConversationAvatarFollower.avatarSize)
                    .modifier(AvatarGlowModifier(isActive: isSending))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, VSpacing.xl)
                    .frame(maxWidth: VSpacing.chatColumnMaxWidth)
                    .frame(maxWidth: .infinity)
                    .offset(y: avatarDisplayY)
                    .animation(ConversationAvatarFollower.spring, value: avatarDisplayY)
                    .accessibilityHidden(true)
                    .onAppear {
                        if shouldPlayTailEntryAnimation {
                            hasPlayedTailEntryAnimation = true
                        }
                    }
            } else {
                HStack {
                    VAvatarImage(image: appearance.chatAvatarImage, size: ConversationAvatarFollower.avatarSize)
                        .modifier(AvatarGlowModifier(isActive: isSending))
                    Spacer()
                }
                .padding(.horizontal, VSpacing.xl)
                .frame(maxWidth: VSpacing.chatColumnMaxWidth)
                .frame(maxWidth: .infinity)
                .offset(y: avatarDisplayY)
                .animation(ConversationAvatarFollower.spring, value: avatarDisplayY)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
        }
    }

    /// Delegates scroll-to-bottom restoration to the coordinator.
    private func restoreScrollToBottom(proxy: ScrollViewProxy) {
        scrollCoordinator.restoreScrollToBottom(
            proxy: proxy,
            conversationId: conversationId,
            anchorMessageId: $anchorMessageId,
            scrollViewportHeight: scrollViewportHeight,
            avatarSmoothingTask: &avatarSmoothingTask,
            isAvatarVisible: &isAvatarVisible,
            avatarDisplayY: &avatarDisplayY
        )
    }

    /// Flash-highlight the given message after an anchor scroll completes.
    /// The highlight fades out automatically after 1.5 seconds.
    private func flashHighlight(messageId: UUID) {
        highlightDismissTask?.cancel()
        highlightedMessageId = messageId
        highlightDismissTask = Task { @MainActor in
            do {
                try await Task.sleep(nanoseconds: 1_500_000_000)
            } catch {
                return
            }
            guard !Task.isCancelled else { return }
            withAnimation(VAnimation.slow) {
                highlightedMessageId = nil
            }
            highlightDismissTask = nil
        }
    }

    /// Delegates scroll loop event recording to the coordinator.
    private func recordScrollLoopEvent(_ kind: ChatScrollLoopGuard.EventKind) {
        scrollCoordinator.recordScrollLoopEvent(
            kind,
            conversationId: conversationId,
            isNearBottom: isNearBottom,
            scrollViewportHeight: scrollViewportHeight,
            anchorMessageId: anchorMessageId
        )
    }


    /// Delegates bottom-pin request to the coordinator.
    private func requestBottomPin(
        reason: BottomPinRequestReason,
        proxy: ScrollViewProxy,
        animated: Bool = false
    ) {
        scrollCoordinator.requestBottomPin(
            reason: reason,
            proxy: proxy,
            conversationId: conversationId,
            animated: animated
        )
    }

    /// Delegates bottom-pin coordinator configuration to the scroll coordinator.
    private func configureBottomPinCoordinator(proxy: ScrollViewProxy) {
        scrollCoordinator.configureBottomPinCoordinator(
            proxy: proxy,
            scrollViewportHeight: scrollViewportHeight,
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

    var body: some View {
        ScrollViewReader { proxy in
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
                    let state = precomputedState
                    let catalogHash = MessageCellView.hashCatalog(providerCatalog)
                    ForEach(state.displayMessages) { message in
                        let index = state.messageIndexById[message.id] ?? 0
                        MessageCellView(
                            message: message,
                            index: index,
                            showTimestamp: state.showTimestamp.contains(message.id),
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
                            activeSurfaceId: activeSurfaceId,
                            isHighlighted: highlightedMessageId == message.id,
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
                    } else if isCompacting && !state.shouldShowThinkingIndicator && !state.canInlineProcessing {
                        compactingIndicatorRow()
                    }

                    Color.clear
                        .frame(height: 1)
                        .id("conversation-tail-anchor")
                        .background {
                            GeometryReader { geo in
                                Color.clear.preference(
                                    key: ConversationTailAnchorYKey.self,
                                    value: geo.frame(in: .named("chatScrollView")).maxY
                                )
                            }
                        }
                        .transaction { $0.disablesAnimations = true }

                    if !state.displayMessages.isEmpty && ConversationAvatarFollower.bottomInset > 0 {
                        Color.clear
                            .frame(height: ConversationAvatarFollower.bottomInset)
                            .accessibilityHidden(true)
                    }

                    Color.clear.frame(height: 1)
                        .id("scroll-bottom-anchor")
                        .onAppear {
                            // Only auto-tether on initial load (before any scroll events).
                            // After the user has scrolled, rely on ScrollWheelDetector and
                            // anchorTracker preference tracking to manage isNearBottom —
                            // LazyVStack fires onAppear in the prefetch zone (several screens
                            // ahead) which would prematurely re-tether during normal scrolling.
                            if !scrollCoordinator.hasReceivedScrollEvent {
                                isNearBottom = true
                            }
                        }
                        .background {
                            GeometryReader { geo in
                                Color.clear.preference(
                                    key: AnchorMinYKey.self,
                                    value: geo.frame(in: .named("chatScrollView")).minY
                                )
                            }
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
            .environment(\.suppressAutoScroll, { [self] in
                let resizeActive = resizeScrollTask != nil && !resizeScrollTask!.isCancelled
                scrollCoordinator.handleSuppressAutoScroll(
                    isNearBottom: isNearBottom,
                    isResizeActive: resizeActive,
                    conversationId: conversationId,
                    proxy: proxy,
                    scrollViewportHeight: scrollViewportHeight
                )
            })
            .background {
                GeometryReader { geo in
                    Color.clear.preference(key: ScrollViewportHeightKey.self, value: geo.size.height)
                }
                ScrollWheelDetector(
                    onScrollUp: { scrollCoordinator.handleScrollUp() },
                    onScrollToBottom: { scrollCoordinator.handleScrollToBottom() },
                    conversationId: conversationId
                )
            }
            .scrollIndicators(.automatic)
            .onPreferenceChange(ScrollViewportHeightKey.self) { height in
                // Filter non-finite viewport heights and sub-pixel jitter.
                // A 0.5pt dead-zone prevents floating-point rounding differences
                // between render passes from triggering continuous @State mutations
                // (scrollViewportHeight) which would create a runaway render loop.
                let decision = PreferenceGeometryFilter.evaluate(
                    newValue: height,
                    previous: scrollViewportHeight,
                    deadZone: 0.5
                )
                guard case .accept(let accepted) = decision else { return }
                os_signpost(.begin, log: PerfSignposts.log, name: "viewportHeightPreferenceChange")
                let viewportChanged = scrollCoordinator.updateAnchorViewport(
                    height: accepted,
                    storedViewportHeight: &scrollViewportHeight
                )
                if viewportChanged, scrollCoordinator.scrollTracking.lastTailAnchorY.isFinite {
                    // Reconcile the avatar follower on resize so a hidden target
                    // is refreshed before a later visibility transition reveals it.
                    updateAvatarFollower(anchorY: scrollCoordinator.scrollTracking.lastTailAnchorY)
                }
                os_signpost(.end, log: PerfSignposts.log, name: "viewportHeightPreferenceChange")
            }
            .transaction { $0.disablesAnimations = true }
            .onPreferenceChange(AnchorMinYKey.self) { minY in
                // Filter non-finite anchor values and apply 2pt dead-zone to
                // reduce layout invalidation cascades during rapid scroll.
                let decision = PreferenceGeometryFilter.evaluate(
                    newValue: minY,
                    previous: scrollCoordinator.anchorLastMinY
                )
                switch decision {
                case .rejectNonFinite:
                    scrollCoordinator.handleNonFiniteAnchor()
                    return
                case .rejectDeadZone:
                    return
                case .accept(let accepted):
                    os_signpost(.begin, log: PerfSignposts.log, name: "anchorMinYPreferenceChange")
                    scrollCoordinator.handleAcceptedAnchorMinY(
                        accepted: accepted,
                        scrollViewportHeight: scrollViewportHeight,
                        anchorMessageId: anchorMessageId,
                        proxy: proxy,
                        conversationId: conversationId,
                        messages: messages,
                        isNearBottom: isNearBottom,
                        containerWidth: containerWidth,
                        highlightedMessageId: highlightedMessageId
                    )
                    os_signpost(.end, log: PerfSignposts.log, name: "anchorMinYPreferenceChange")
                }
            }
            .transaction { $0.disablesAnimations = true }
            .onPreferenceChange(ConversationTailAnchorYKey.self) { anchorY in
                // Filter non-finite tail anchor values and apply 2pt dead-zone
                // to reduce layout invalidation cascades during rapid scroll.
                let decision = PreferenceGeometryFilter.evaluate(
                    newValue: anchorY,
                    previous: scrollCoordinator.scrollTracking.lastTailAnchorY
                )
                guard case .accept(let accepted) = decision else { return }
                recordScrollLoopEvent(.tailAnchorPreferenceChange)
                scrollCoordinator.scrollTracking.lastTailAnchorY = accepted
                // Defer to next run loop to prevent synchronous layout re-entry
                // on macOS. This preference fires during placeSubviews; calling
                // withAnimation (inside applyAvatarDisplayY) synchronously causes
                // _PaddingLayout.sizeThatFits to be re-entered, creating an infinite
                // layout cycle when avatar properties change concurrently with a
                // ToolConfirmationBubble in the message list.
                Task { @MainActor in
                    updateAvatarFollower(anchorY: accepted)
                }
            }
            .transaction { $0.disablesAnimations = true }
            .onPreferenceChange(PaginationSentinelMinYKey.self) { sentinelMinY in
                scrollCoordinator.handlePaginationSentinel(
                    sentinelMinY: sentinelMinY,
                    scrollViewportHeight: scrollViewportHeight,
                    hasMoreMessages: hasMoreMessages,
                    isLoadingMoreMessages: isLoadingMoreMessages,
                    proxy: proxy,
                    visibleMessages: visibleMessages,
                    conversationId: conversationId,
                    loadPreviousMessagePage: loadPreviousMessagePage
                )
            }
            .overlay(alignment: .topLeading) {
                conversationTailAvatar
            }
            .overlay(alignment: .bottom) {
                if !isNearBottom && !scrollCoordinator.anchorIsVisible
                    && scrollCoordinator.anchorLastMinY > scrollViewportHeight + 20
                {
                    Button(action: {
                        os_signpost(.event, log: PerfSignposts.log, name: "scrollToLatestPressed")
                        scrollCoordinator.hasReceivedScrollEvent = true
                        // Signal the coordinator to reattach and scroll to bottom.
                        scrollCoordinator.bottomPinCoordinator.handleUserAction(.jumpToLatest)
                        requestBottomPin(reason: .initialRestore, proxy: proxy, animated: true)
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
                configureBottomPinCoordinator(proxy: proxy)
                // Seed the confirmation marker on initial mount — onChange(of:
                // conversationId) doesn't fire for the initial value, so a
                // conversation already paused in awaiting_confirmation at launch
                // or reconnect needs the marker set here.
                if !isSending {
                    phaseWhenSendingStopped = assistantActivityPhase
                }
                if let id = anchorMessageId, messages.contains(where: { $0.id == id }) {
                    // Anchor is already set and the target message is loaded —
                    // scroll to it immediately instead of falling through to bottom.
                    os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested", "target=anchorMessage reason=onAppear")
                    os_signpost(.event, log: PerfSignposts.log, name: "anchorCleared", "reason=foundOnAppear")
                    recordScrollLoopEvent(.scrollToRequested)
                    proxy.scrollTo(id, anchor: .center)
                    flashHighlight(messageId: id)
                    anchorMessageId = nil
                    anchorSetTime = nil
                } else if anchorMessageId != nil {
                    // Anchor is set but the target message isn't loaded yet.
                    // Record the timestamp so the elapsed-time guard starts
                    // counting from view appearance (onChange may not fire for
                    // the initial value).
                    os_signpost(.event, log: PerfSignposts.log, name: "anchorSet", "reason=onAppearPending")
                    if anchorSetTime == nil { anchorSetTime = Date() }
                    // Start the independent timeout if not already running
                    // (onChange(of: anchorMessageId) may not fire for the
                    // initial value when the view first appears).
                    if anchorTimeoutTask == nil {
                        anchorTimeoutTask = Task { @MainActor in
                            do {
                                try await Task.sleep(nanoseconds: 10_000_000_000)
                            } catch {
                                return
                            }
                            guard !Task.isCancelled, anchorMessageId != nil else { return }
                            os_signpost(.event, log: PerfSignposts.log, name: "anchorTimedOut")
                            log.debug("Anchor message not found (timed out) — clearing stale anchor")
                            anchorMessageId = nil
                            anchorSetTime = nil
                            anchorTimeoutTask = nil
                            scrollCoordinator.bottomPinCoordinator.reattach()
                            requestBottomPin(reason: .initialRestore, proxy: proxy, animated: true)
                        }
                    }
                } else {
                    restoreScrollToBottom(proxy: proxy)
                }
                // When anchorMessageId is set but the target message isn't loaded
                // yet, skip scrolling entirely — onChange(of: messages.count) will
                // retry once history finishes loading.
            }
            .onDisappear {
                scrollCoordinator.cancelAllTasks()
                anchorTimeoutTask?.cancel()
                anchorTimeoutTask = nil
                resizeScrollTask?.cancel()
                resizeScrollTask = nil
                avatarSmoothingTask?.cancel()
                avatarSmoothingTask = nil
                highlightDismissTask?.cancel()
                highlightDismissTask = nil
                highlightedMessageId = nil
            }
            .onChange(of: isSending) {
                if isSending {
                    scrollCoordinator.hasReceivedScrollEvent = true
                    // Reattach and pin to bottom for user-initiated actions (send,
                    // regenerate, retry). Skip reattach only when the daemon resumes
                    // from a tool confirmation (not a user action during confirmation).
                    //
                    // Detection: when the daemon resumes, it sets both isSending=true
                    // AND assistantActivityPhase="thinking" in the same mutation. When
                    // the user sends/regenerates during confirmation, only isSending
                    // changes — assistantActivityPhase stays "awaiting_confirmation"
                    // until the daemon processes the new request.
                    let isDaemonConfirmationResume =
                        phaseWhenSendingStopped == "awaiting_confirmation"
                        && assistantActivityPhase != "awaiting_confirmation"
                    if isDaemonConfirmationResume && !scrollCoordinator.bottomPinCoordinator.isFollowingBottom {
                        // Daemon resumed from confirmation while user was scrolled up.
                    } else {
                        scrollCoordinator.bottomPinCoordinator.reattach()
                        requestBottomPin(reason: .messageCount, proxy: proxy, animated: true)
                    }
                } else {
                    // Capture the activity phase at the moment sending stops.
                    // "awaiting_confirmation" marks a mid-turn pause; any other value
                    // (idle, streaming, tool_running) marks a genuine turn ending.
                    phaseWhenSendingStopped = assistantActivityPhase
                }
            }
            .onChange(of: assistantActivityPhase) {
                // Clear stale confirmation marker when the phase leaves
                // "awaiting_confirmation" while isSending is still false (e.g.,
                // confirmation denied → idle, or reconnect resets the phase).
                // When the daemon resumes (phase → thinking AND isSending → true
                // simultaneously), isSending is already true here, so we skip —
                // the isSending handler needs the marker intact.
                if !isSending
                    && phaseWhenSendingStopped == "awaiting_confirmation"
                    && assistantActivityPhase != "awaiting_confirmation"
                {
                    phaseWhenSendingStopped = assistantActivityPhase
                }
            }
            .onChange(of: isThinking) {
                if !isThinking {
                    if !hasEverSentMessage && messages.contains(where: { $0.role == .user }) {
                        hasEverSentMessage = true
                    }
                }
            }
            .onChange(of: shouldCoalesceAvatarUpdates) {
                if !shouldCoalesceAvatarUpdates {
                    updateAvatarFollower(anchorY: scrollCoordinator.scrollTracking.pendingAvatarY ?? scrollCoordinator.scrollTracking.avatarTargetY)
                }
            }
            .onChange(of: messages.count) {
                // Anchor scroll takes priority: when a notification deep-link
                // set anchorMessageId, retry scrolling to it as messages load
                // (e.g., history arrives after a conversation switch). This must run
                // before the bottom-scroll branch to avoid competing scrollTo calls.
                if let id = anchorMessageId, messages.contains(where: { $0.id == id }) {
                    os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested", "target=anchorMessage reason=messagesChanged")
                    os_signpost(.event, log: PerfSignposts.log, name: "anchorCleared", "reason=foundInMessages")
                    recordScrollLoopEvent(.scrollToRequested)
                    // Anchor jumps bypass the coordinator — they are higher priority.
                    scrollCoordinator.bottomPinCoordinator.cancelActiveSession(reason: .deepLinkAnchorHandoff)
                    withAnimation {
                        proxy.scrollTo(id, anchor: .center)
                    }
                    flashHighlight(messageId: id)
                    anchorMessageId = nil
                    anchorSetTime = nil
                    anchorTimeoutTask?.cancel()
                    anchorTimeoutTask = nil
                    return
                }
                // If anchor is set but the target message still hasn't appeared,
                // check pagination exhaustion with a minimum elapsed time guard.
                // The guard prevents premature clearing when hasMoreMessages is
                // still at its default `false` before the daemon history response
                // arrives (e.g., a streaming message changes messages.count before
                // history loads). The independent anchorTimeoutTask handles the
                // time-based fallback separately.
                if anchorMessageId != nil {
                    let paginationExhausted = !hasMoreMessages
                    let minWaitElapsed = anchorSetTime.map { Date().timeIntervalSince($0) > 2 } ?? false
                    if paginationExhausted && minWaitElapsed {
                        os_signpost(.event, log: PerfSignposts.log, name: "anchorCleared", "reason=paginationExhausted")
                        log.debug("Anchor message not found (pagination exhausted) — clearing stale anchor")
                        anchorMessageId = nil
                        anchorSetTime = nil
                        anchorTimeoutTask?.cancel()
                        anchorTimeoutTask = nil
                        scrollCoordinator.bottomPinCoordinator.reattach()
                        requestBottomPin(reason: .messageCount, proxy: proxy, animated: true)
                        return
                    }
                }
                if isNearBottom && !scrollCoordinator.isSuppressed && anchorMessageId == nil {
                    requestBottomPin(reason: .messageCount, proxy: proxy, animated: true)
                } else if !scrollCoordinator.hasReceivedScrollEvent && anchorMessageId == nil && !messages.isEmpty {
                    // History just loaded but the coordinator's initial-restore session
                    // may have already expired (500ms timeout). Force a fresh scroll-to-bottom
                    // so messages are visible without requiring user scroll interaction.
                    requestBottomPin(reason: .initialRestore, proxy: proxy)
                } else if scrollCoordinator.isSuppressed {
                    log.debug("Auto-scroll suppressed (bottom-scroll suppression active)")
                }
            }
            .onChange(of: containerWidth) {
                guard containerWidth > 0, abs(containerWidth - lastHandledContainerWidth) > 2 else { return }
                lastHandledContainerWidth = containerWidth
                resizeScrollTask?.cancel()
                resizeScrollTask = scrollCoordinator.makeResizeTask(
                    proxy: proxy,
                    conversationId: conversationId,
                    isNearBottom: isNearBottom,
                    anchorMessageId: anchorMessageId,
                    scrollViewportHeight: scrollViewportHeight,
                    onComplete: { [self] in resizeScrollTask = nil }
                )
            }
            .onChange(of: conversationId) { oldConversationId, _ in
                // Reset view-local state that doesn't belong in the coordinator.
                resizeScrollTask?.cancel()
                resizeScrollTask = nil
                avatarSmoothingTask?.cancel()
                avatarSmoothingTask = nil
                scrollCoordinator.resetForConversationSwitch(
                    oldConversationId: oldConversationId,
                    newConversationId: conversationId,
                    isSending: isSending,
                    assistantActivityPhase: assistantActivityPhase
                )
                isNearBottom = true
                highlightedMessageId = nil
                highlightDismissTask?.cancel()
                highlightDismissTask = nil
                // Capture the new conversation's activity phase so a conversation
                // already paused in awaiting_confirmation is correctly tracked.
                phaseWhenSendingStopped = isSending ? "" : assistantActivityPhase
                lastHandledContainerWidth = containerWidth
                anchorTimeoutTask?.cancel()
                anchorTimeoutTask = nil
                hasPlayedTailEntryAnimation = false
                // Avatar state is reset inside restoreScrollToBottom so the
                // reset is shared with onAppear.
                restoreScrollToBottom(proxy: proxy)
            }
            .onChange(of: anchorMessageId) {
                // Only cancel scroll restore when a new anchor is set (non-nil).
                // The nil transition fires during conversation switches (stale anchor
                // cleanup) and must not cancel the restore just started.
                if anchorMessageId != nil {
                    scrollCoordinator.scrollRestoreTask?.cancel()
                    scrollCoordinator.scrollRestoreTask = nil
                    // Anchor jumps are higher priority — cancel any active pin session.
                    scrollCoordinator.bottomPinCoordinator.cancelActiveSession(reason: .deepLinkAnchorHandoff)
                }
                // Record the timestamp when a new anchor is set so the
                // pagination-exhaustion guard can measure elapsed time.
                anchorSetTime = anchorMessageId != nil ? Date() : nil
                // Cancel any previous timeout task.
                anchorTimeoutTask?.cancel()
                anchorTimeoutTask = nil
                guard let id = anchorMessageId else { return }
                os_signpost(.event, log: PerfSignposts.log, name: "anchorSet", "reason=anchorMessageIdChanged")
                // Only scroll and clear if the target message is already loaded;
                // otherwise leave the anchor set so the messages-change handler
                // can retry once history finishes loading.
                if messages.contains(where: { $0.id == id }) {
                    os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested", "target=anchorMessage reason=anchorChanged")
                    os_signpost(.event, log: PerfSignposts.log, name: "anchorCleared", "reason=foundOnAnchorChange")
                    recordScrollLoopEvent(.scrollToRequested)
                    withAnimation {
                        proxy.scrollTo(id, anchor: .center)
                    }
                    flashHighlight(messageId: id)
                    anchorMessageId = nil
                    anchorSetTime = nil
                } else {
                    // Start an independent 10-second timeout that clears the
                    // anchor even if messages.count never changes (e.g., pagination
                    // stalls or the daemon never responds with more history).
                    anchorTimeoutTask = Task { @MainActor in
                        do {
                            try await Task.sleep(nanoseconds: 10_000_000_000)
                        } catch {
                            return
                        }
                        guard !Task.isCancelled, anchorMessageId != nil else { return }
                        os_signpost(.event, log: PerfSignposts.log, name: "anchorTimedOut")
                        log.debug("Anchor message not found (timed out) — clearing stale anchor")
                        anchorMessageId = nil
                        anchorSetTime = nil
                        anchorTimeoutTask = nil
                        scrollCoordinator.bottomPinCoordinator.reattach()
                        requestBottomPin(reason: .initialRestore, proxy: proxy, animated: true)
                    }
                }
            }
            .onChange(of: currentPendingRequestId) {
                #if os(macOS)
                if let requestId = currentPendingRequestId, lastAutoFocusedRequestId != requestId {
                    // A new pending confirmation just appeared. Resign first
                    // responder from the composer so the confirmation bubble's
                    // key monitor can intercept Tab/Enter/Escape immediately.
                    // Only mark as handled after a successful resign so
                    // didBecomeKeyNotification can retry when the window is inactive.
                    if let window = NSApp.keyWindow,
                       let responder = window.firstResponder as? NSTextView,
                       responder.isEditable {
                        window.makeFirstResponder(nil)
                        lastAutoFocusedRequestId = requestId
                    }
                } else if currentPendingRequestId == nil {
                    lastAutoFocusedRequestId = nil
                }
                #endif
            }
            .onReceive(NotificationCenter.default.publisher(for: NSWindow.didBecomeKeyNotification)) { notification in
                if let requestId = currentPendingRequestId, lastAutoFocusedRequestId != requestId,
                   let window = notification.object as? NSWindow,
                   window === NSApp.keyWindow,
                   let responder = window.firstResponder as? NSTextView,
                   responder.isEditable {
                    window.makeFirstResponder(nil)
                    lastAutoFocusedRequestId = requestId
                }
            }
            .onReceive(TaskProgressOverlayManager.shared.$activeSurfaceId) { newId in
                activeSurfaceId = newId
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
                activeSurfaceId: activeSurfaceId
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
                activeSurfaceId: activeSurfaceId
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

/// Preference key used to propagate the scroll view's viewport height from a
/// background GeometryReader up to the MessageListView so the anchor-visibility
/// check can compare the anchor's Y position against the viewport bounds.
private struct ScrollViewportHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        // Use max so sibling views in the same .background block (which report
        // the default value of 0) don't overwrite the real viewport height.
        value = max(value, nextValue())
    }
}

/// Preference key that propagates the anchor's Y position (in the chatScrollView
/// coordinate space) from the GeometryReader up to the MessageListView.
private struct AnchorMinYKey: PreferenceKey {
    static var defaultValue: CGFloat = .infinity
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        // Use min so sibling views in the LazyVStack (which report the default
        // value of .infinity) don't overwrite the anchor's actual Y position.
        value = min(value, nextValue())
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

/// Centralizes the "do we still need to scroll?" check for bottom-pinning
/// paths so expansion/streaming guards stop once the tail anchor re-enters
/// the viewport.
enum MessageListBottomAnchorPolicy {
    /// Distinguishes why a bottom-anchor check passed or failed, so callers
    /// can handle missing geometry differently from a genuine scroll drift.
    enum VerificationOutcome: Equatable {
        /// The anchor is within tolerance of the viewport bottom — no action needed.
        case anchored
        /// The anchor has drifted below the viewport and should be re-pinned.
        case needsRepin
        /// One or both geometry inputs are non-finite (e.g. `.infinity`, `.nan`),
        /// meaning the layout has not been measured yet or is in a transient state.
        case geometryUnavailable
    }

    static let repinTolerance: CGFloat = 2

    /// Evaluates the bottom-anchor position against the viewport and returns
    /// a structured outcome describing the result.
    static func verify(
        anchorMinY: CGFloat,
        viewportHeight: CGFloat,
        tolerance: CGFloat = repinTolerance
    ) -> VerificationOutcome {
        guard anchorMinY.isFinite, viewportHeight.isFinite else {
            return .geometryUnavailable
        }
        if anchorMinY > viewportHeight + tolerance {
            return .needsRepin
        }
        return .anchored
    }

    /// Returns `true` when the anchor needs re-pinning OR geometry is unavailable.
    /// Existing call sites rely on this collapsing `geometryUnavailable` into `true`,
    /// preserving current behavior until callers adopt `verify(...)` directly.
    static func needsRepin(
        anchorMinY: CGFloat,
        viewportHeight: CGFloat,
        tolerance: CGFloat = repinTolerance
    ) -> Bool {
        switch verify(anchorMinY: anchorMinY, viewportHeight: viewportHeight, tolerance: tolerance) {
        case .anchored:
            return false
        case .needsRepin, .geometryUnavailable:
            return true
        }
    }
}

// MARK: - Avatar Glow

/// Pulsing glow effect applied to the conversation tail avatar while the
/// assistant is generating a response, making the "still working" state
/// visible near the content area.
private struct AvatarGlowModifier: ViewModifier {
    let isActive: Bool

    @State private var glowIntensity: CGFloat = 0

    func body(content: Content) -> some View {
        content
            .shadow(color: VColor.primaryActive.opacity(glowIntensity), radius: 6 + glowIntensity * 10, x: 0, y: 0)
            .shadow(color: VColor.primaryActive.opacity(glowIntensity * 0.5), radius: 2 + glowIntensity * 4, x: 0, y: 0)
            .onChange(of: isActive) {
                if isActive {
                    withAnimation(.easeInOut(duration: 2.5).repeatForever(autoreverses: true)) {
                        glowIntensity = 0.25
                    }
                } else {
                    withAnimation(.easeOut(duration: 0.4)) {
                        glowIntensity = 0
                    }
                }
            }
            .onAppear {
                if isActive {
                    DispatchQueue.main.async {
                        withAnimation(.easeInOut(duration: 2.5).repeatForever(autoreverses: true)) {
                            glowIntensity = 0.25
                        }
                    }
                }
            }
    }
}

// MARK: - Precomputed Message List State

/// Holds derived values computed once per body evaluation so they are not
/// redundantly recalculated inside the LazyVStack ForEach body.
/// Note: `LazyVStack` already gates child view evaluation, so each cell is
/// only built when it scrolls into the prefetch window. The primary gain here
/// is avoiding repeated O(n) scans (timestamp indices, subagent grouping,
/// current-turn detection) on every layout pass.
struct PrecomputedMessageListState {
    let displayMessages: [ChatMessage]
    let messageIndexById: [UUID: Int]
    let activePendingRequestId: String?
    let latestAssistantId: UUID?
    let anchoredThinkingIndex: Int?
    let subagentsByParent: [UUID: [SubagentInfo]]
    let orphanSubagents: [SubagentInfo]
    let showTimestamp: Set<UUID>
    let nextDecidedConfirmationByIndex: [Int: ToolConfirmationData]
    let isConfirmationRenderedInlineByIndex: Set<Int>
    let hasPrecedingAssistantByIndex: Set<Int>
    let hasUserMessage: Bool
    let lastVisible: ChatMessage?
    let currentTurnMessages: ArraySlice<ChatMessage>
    let hasActiveToolCall: Bool
    let wouldShowThinking: Bool
    let lastVisibleIsAssistant: Bool
    let canInlineProcessing: Bool
    let shouldShowThinkingIndicator: Bool
    let effectiveStatusText: String?
}
