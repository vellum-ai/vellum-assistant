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

/// Holds the last-known anchor minY without triggering SwiftUI re-renders.
/// Only `isVisible` is @Published so re-renders happen only when the
/// visible/invisible boundary is crossed — not on every scroll tick.
@MainActor final class AnchorVisibilityTracker: ObservableObject {
    var lastMinY: CGFloat = .infinity  // NOT @Published — no re-render on scroll
    @Published var isVisible: Bool = true

    /// Updates the tracked minY and recalculates visibility.
    /// Only publishes `isVisible` when the boundary is actually crossed
    /// (visible ↔ invisible), not on every scroll tick — this prevents
    /// SwiftUI re-renders during continuous scrolling.
    func update(minY: CGFloat, viewportHeight: CGFloat) {
        lastMinY = minY
        let newVisible = minY >= -20 && minY <= viewportHeight + 20
        if isVisible != newVisible { isVisible = newVisible }
    }

    /// Returns `true` when the viewport height actually changed, so callers
    /// can refresh any state tied to the visible geometry.
    @discardableResult
    func updateViewport(height: CGFloat, storedViewportHeight: inout CGFloat) -> Bool {
        guard storedViewportHeight != height else { return false }
        storedViewportHeight = height
        // Don't recompute visibility before the anchor position has been
        // measured — lastMinY starts at .infinity, and .infinity <= height + 20
        // evaluates to false, incorrectly flipping isVisible to false and
        // flashing the "Scroll to latest" button on short conversations.
        guard lastMinY.isFinite else { return true }
        let newVisible = lastMinY >= -20 && lastMinY <= height + 20
        if isVisible != newVisible { isVisible = newVisible }
        return true
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
}

/// Lightweight key that captures all inputs to `precomputedState`.
/// For the message array we use a hash-based fingerprint rather than
/// storing the full array, keeping equality checks O(1) after an
/// O(visible-messages) fingerprint computation.
struct PrecomputedCacheKey: Equatable {
    let messageFingerprint: Int
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
    /// Guards the pagination sentinel against re-entry during the brief window
    /// between Task launch and the first `await` (before isLoadingMoreMessages is set).
    @State private var isPaginationInFlight: Bool = false
    @State private var paginationTask: Task<Void, Never>?
    /// Suppresses bottom auto-scroll for the ~32ms layout window after pagination
    /// restores scroll position, preventing a jump back to the bottom.
    @State private var isSuppressingBottomScroll: Bool = false
    @State private var isAppActive: Bool = NSApp.isActive
    @State private var conversationSwitchSuppressionTask: Task<Void, Never>?
    @State private var suppressScrollbarDuringConversationSwitch: Bool = false
    @State private var expandSuppressionTask: Task<Void, Never>?
    /// Tracks the last pending confirmation request ID that triggered an
    /// auto-focus handoff. Used to detect nil→non-nil transitions so we
    /// resign first responder exactly once per new confirmation appearance.
    @State private var lastAutoFocusedRequestId: String?
    /// Tracks whether the scroll-bottom-anchor is physically within the scroll
    /// view's visible viewport. Used alongside `isNearBottom` to suppress the
    /// "Scroll to latest" button when all content fits on screen. Stored as an
    /// ObservableObject so only boundary crossings (not every scroll tick)
    /// trigger re-renders.
    @StateObject private var anchorTracker = AnchorVisibilityTracker()
    /// Whether a physical scroll event (wheel/trackpad) has been received since
    /// the current conversation loaded. Used by `restoreScrollToBottom` to skip
    /// retries once the user has interacted, and by the scroll-bottom-anchor's
    /// `onAppear` to avoid premature re-tethering during LazyVStack prefetch.
    @State private var hasReceivedScrollEvent: Bool = false
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
    /// In-flight staged scroll-to-bottom task used after conversation switches and
    /// app restarts to reliably anchor the viewport once layout settles.
    @State private var scrollRestoreTask: Task<Void, Never>?
    /// Whether the AnchorMinYKey preference has fired since the last scroll
    /// restore began. Ensures anchorTracker.isVisible reflects real geometry
    /// rather than the manual reset applied on conversation switch.
    @State private var hasFreshAnchorMeasurement: Bool = false
    @State private var isAvatarVisible: Bool = false
    @State private var avatarDisplayY: CGFloat = .infinity
    @State private var avatarSmoothingTask: Task<Void, Never>?
    @State private var hasPlayedTailEntryAnimation = false
    /// Non-reactive scroll tracking state (dead-zone guards, smoothing).
    /// Stored on a class so mutations never trigger body re-evaluations.
    @State private var scrollTracking = ScrollTrackingState()
    /// Tracks whether the pagination sentinel was previously inside the
    /// trigger band. Used by `MessageListPaginationTriggerPolicy.shouldTrigger`
    /// to enforce one-shot edge-transition semantics.
    @State private var wasPaginationTriggerInRange: Bool = false
    /// Detects runaway scroll-loop patterns and emits one aggregate warning
    /// per cooldown window instead of per-frame log spam.
    @State private var scrollLoopGuard = ChatScrollLoopGuard()
    /// Coordinates bounded scroll-to-bottom retry sessions and manages the
    /// follow/detach state machine. All automatic bottom-follow requests are
    /// routed through this coordinator instead of issuing direct scrollTo calls.
    @State private var bottomPinCoordinator = ChatBottomPinCoordinator()
    /// Captures the `assistantActivityPhase` at the moment `isSending` goes false.
    /// Used to distinguish mid-turn tool-confirmation pauses (phase == "awaiting_confirmation")
    /// from genuine turn endings, so the `onChange(of: isSending)` handler can decide
    /// whether to reattach the scroll position on the next `isSending = true` transition.
    @State private var phaseWhenSendingStopped: String = ""
    /// One-shot flag: logs a warning the first time anchor, tail, or viewport
    /// geometry is non-finite during a render pass. Visible even if the JSONL
    /// session log later fails for an unrelated reason.
    @State private var hasLoggedNonFiniteGeometry: Bool = false

    /// The subset of messages actually shown, honoring the pagination window.
    /// Uses the shared `ChatVisibleMessageFilter` so hidden automated messages
    /// are excluded from rendered rows, pagination anchors, and all derived state.
    private var visibleMessages: [ChatMessage] {
        ChatVisibleMessageFilter.paginatedMessages(
            from: messages,
            displayedMessageCount: displayedMessageCount
        )
    }

    /// Computes a lightweight fingerprint over visible messages that detects
    /// additions, deletions, streaming updates, and confirmation state changes
    /// without storing the full message array.
    private func computeMessageFingerprint() -> Int {
        var hasher = Hasher()
        hasher.combine(messages.count)
        hasher.combine(displayedMessageCount)
        let visible = visibleMessages
        hasher.combine(visible.count)
        for msg in visible {
            hasher.combine(msg.id)
            hasher.combine(msg.textSegments.count)
            if let last = msg.textSegments.last {
                hasher.combine(last.count)
            }
            hasher.combine(msg.toolCalls.count)
            for toolCall in msg.toolCalls {
                hasher.combine(toolCall.isComplete)
            }
            hasher.combine(msg.isStreaming)
            if let conf = msg.confirmation {
                // ToolConfirmationState is Equatable but not Hashable/RawRepresentable;
                // map to an int tag for hashing.
                switch conf.state {
                case .pending: hasher.combine(0)
                case .approved: hasher.combine(1)
                case .denied: hasher.combine(2)
                case .timedOut: hasher.combine(3)
                }
            } else {
                hasher.combine(-1)
            }
        }
        return hasher.finalize()
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
    /// Memoized behind a lightweight input fingerprint stored on the
    /// non-reactive `ScrollTrackingState`. Cache hit returns immediately
    /// after an O(visible-messages) fingerprint comparison; cache miss
    /// runs the full computation. Storing on the class (not @State)
    /// ensures cache updates never trigger additional body re-evaluations.
    private var precomputedState: PrecomputedMessageListState {
        let key = PrecomputedCacheKey(
            messageFingerprint: computeMessageFingerprint(),
            isSending: isSending,
            isThinking: isThinking,
            isCompacting: isCompacting,
            assistantStatusText: assistantStatusText,
            activeSubagentFingerprint: Self.computeSubagentFingerprint(activeSubagents),
            displayedMessageCount: displayedMessageCount
        )

        if key == scrollTracking.cachedPrecomputedKey,
           let cached = scrollTracking.cachedPrecomputedState {
            #if DEBUG
            // Spot-check cache correctness in debug builds.
            let freshMessages = visibleMessages
            assert(
                cached.displayMessages.count == freshMessages.count,
                "precomputedState cache stale: displayMessages count \(cached.displayMessages.count) vs \(freshMessages.count)"
            )
            #endif
            return cached
        }

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

        scrollTracking.cachedPrecomputedKey = key
        scrollTracking.cachedPrecomputedState = result
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
        if scrollLoopGuard.isTripped(conversationId: convIdString) { return }

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
        scrollTracking.avatarLastAppliedAt = Date()
        // Set @State without withAnimation — the spring animation is applied via
        // .animation() on the avatar view's .offset() modifier instead. This avoids
        // wrapping the mutation in an animation transaction, which would cause SwiftUI
        // to re-evaluate the body on each spring interpolation frame and feed layout
        // shifts back into the tail anchor preference → avatar update cycle.
        avatarDisplayY = y
    }

    private func updateAvatarFollower(anchorY: CGFloat) {
        recordScrollLoopEvent(.avatarFollowerUpdate)

        // Compute visibility
        let nowVisible = anchorY.isFinite
            && ConversationAvatarFollower.shouldShow(anchorY: anchorY, viewportHeight: scrollViewportHeight)
        let convIdString = conversationId?.uuidString ?? "unknown"
        let isTripped = scrollLoopGuard.isTripped(conversationId: convIdString)
        if isAvatarVisible != nowVisible {
            // When tripped, only allow hiding (removing UI is safe and prevents stale state).
            // Showing (false→true) adds layout that could feed the loop — suppress it.
            if !isTripped || !nowVisible {
                isAvatarVisible = nowVisible
            }
        }

        // Update non-reactive tracking position (no body re-evaluation).
        if ConversationAvatarFollower.shouldUpdateTarget(
            previousAnchorY: scrollTracking.avatarTargetY,
            newAnchorY: anchorY,
            viewportHeight: scrollViewportHeight
        ) {
            scrollTracking.avatarTargetY = anchorY
        }

        guard anchorY.isFinite else {
            avatarSmoothingTask?.cancel()
            avatarSmoothingTask = nil
            scrollTracking.pendingAvatarY = nil
            scrollTracking.avatarLastAppliedAt = nil
            // Only mutate @State avatarDisplayY when circuit breaker isn't tripped
            if !isTripped && avatarDisplayY != .infinity { avatarDisplayY = .infinity }
            return
        }

        // Skip position tracking when the avatar is off-screen. The avatar
        // overlay is hidden via shouldShowConversationTailAvatar, so updating
        // avatarDisplayY for an invisible element just wastes layout passes.
        guard nowVisible else {
            avatarSmoothingTask?.cancel()
            avatarSmoothingTask = nil
            scrollTracking.pendingAvatarY = nil
            return
        }

        let now = Date()
        let delay = ConversationAvatarFollower.smoothingDelay(
            isSending: isSending,
            isThinking: isThinking,
            isLastMessageStreaming: isLastMessageStreaming,
            lastAppliedAt: scrollTracking.avatarLastAppliedAt,
            now: now
        )

        if delay <= 0 {
            avatarSmoothingTask?.cancel()
            avatarSmoothingTask = nil
            scrollTracking.pendingAvatarY = nil
            // Only apply @State avatar position when circuit breaker isn't tripped
            if !isTripped {
                applyAvatarDisplayY(forAnchorY: anchorY)
            }
            return
        }

        scrollTracking.pendingAvatarY = anchorY
        guard avatarSmoothingTask == nil else { return }

        avatarSmoothingTask = Task { @MainActor in
            do {
                try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            } catch {
                return
            }
            guard !Task.isCancelled else { return }
            guard let pending = scrollTracking.pendingAvatarY else {
                avatarSmoothingTask = nil
                return
            }
            scrollTracking.pendingAvatarY = nil
            // Only apply @State avatar position when circuit breaker isn't tripped
            if !scrollLoopGuard.isTripped(conversationId: conversationId?.uuidString ?? "unknown") {
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

    /// Staged scroll-to-bottom that retries after increasing delays to handle
    /// cases where SwiftUI hasn't committed the new content's layout yet (e.g.
    /// after a conversation switch or app restart). Cancelled by user scroll-up,
    /// user scroll-to-bottom, anchor message set, or view disappearance.
    private func restoreScrollToBottom(proxy: ScrollViewProxy) {
        scrollRestoreTask?.cancel()
        hasFreshAnchorMeasurement = false

        // Reset avatar follower state so the avatar starts hidden and only
        // appears once the conversation tail anchor reports a fresh position
        // after the scroll settles. Without this, the avatar can flash at a
        // stale Y from a previous layout pass (e.g. app re-launch where
        // onAppear calls restoreScrollToBottom without resetting avatar state).
        avatarSmoothingTask?.cancel()
        avatarSmoothingTask = nil
        scrollTracking.avatarTargetY = .infinity
        isAvatarVisible = false
        avatarDisplayY = .infinity
        scrollTracking.pendingAvatarY = nil
        scrollTracking.avatarLastAppliedAt = nil
        scrollTracking.lastTailAnchorY = .infinity

        // Route the initial restore through the coordinator for bounded retries.
        if anchorMessageId == nil {
            requestBottomPin(reason: .initialRestore, proxy: proxy)
        }

        scrollRestoreTask = Task { @MainActor in
            guard !Task.isCancelled else { return }
            // Stage 0: immediate — the coordinator fires its first attempt above.
            os_signpost(.event, log: PerfSignposts.log, name: "scrollRestoreStage", "stage=0")
            log.debug("Scroll restore: stage 0 (immediate, coordinator-driven)")

            // Stage 1: ~3 frames — handles most conversation switches.
            try? await Task.sleep(nanoseconds: 50_000_000)
            guard !Task.isCancelled else { return }
            os_signpost(.event, log: PerfSignposts.log, name: "scrollRestoreStage", "stage=1")
            if anchorMessageId == nil {
                requestBottomPin(reason: .initialRestore, proxy: proxy)
            }
            log.debug("Scroll restore: stage 1 (50ms)")

            // Stage 2: ~9 frames — catches slower layout/materialization.
            try? await Task.sleep(nanoseconds: 150_000_000)
            guard !Task.isCancelled else { return }
            // Only retry when the anchor genuinely drifted off-screen.
            // `geometryUnavailable` means layout hasn't measured yet —
            // the coordinator will pick up the next finite preference update
            // instead of spinning retries on missing geometry.
            let restoreOutcome = MessageListBottomAnchorPolicy.verify(
                anchorMinY: anchorTracker.lastMinY,
                viewportHeight: scrollViewportHeight
            )
            if anchorMessageId == nil
                && !hasReceivedScrollEvent
                && restoreOutcome == .needsRepin
            {
                os_signpost(.event, log: PerfSignposts.log, name: "scrollRestoreStage", "stage=2 action=retry")
                requestBottomPin(reason: .initialRestore, proxy: proxy)
                log.debug("Scroll restore: stage 2 (200ms) — retrying via coordinator")
            } else {
                os_signpost(.event, log: PerfSignposts.log, name: "scrollRestoreStage", "stage=2 action=skipped")
                log.debug("Scroll restore: stage 2 skipped (anchor=\(String(describing: anchorMessageId)) scrollEvent=\(hasReceivedScrollEvent))")
            }

            if !Task.isCancelled { scrollRestoreTask = nil }
        }
    }

    /// Fires a single pagination load, restores the scroll anchor, and
    /// manages the `isPaginationInFlight` / `isSuppressingBottomScroll` guards.
    private func triggerPagination(proxy: ScrollViewProxy) {
        guard !isPaginationInFlight else { return }
        isPaginationInFlight = true
        // Pagination scroll-position restore is higher priority — cancel any
        // active pin session so the coordinator doesn't fight the restore.
        bottomPinCoordinator.cancelActiveSession(reason: .paginationRestore)
        let anchorId = visibleMessages.first?.id
        os_signpost(.event, log: PerfSignposts.log, name: "paginationSentinelFired")
        log.debug("[pagination] fired — anchorId: \(String(describing: anchorId))")
        paginationTask = Task {
            defer {
                if !Task.isCancelled {
                    isPaginationInFlight = false
                    paginationTask = nil
                } else if paginationTask == nil {
                    isPaginationInFlight = false
                }
            }
            let hadMore = await loadPreviousMessagePage?() ?? false
            log.debug("[pagination] loadPreviousMessagePage returned hadMore=\(hadMore)")
            if hadMore, let id = anchorId {
                // Suppress bottom auto-scroll for the brief layout window so the
                // restored anchor position is not immediately overridden.
                isSuppressingBottomScroll = true
                os_signpost(.event, log: PerfSignposts.log, name: "scrollSuppressionChanged", "on reason=pagination")
                // Wait ~6 frames for SwiftUI to complete layout before restoring position.
                // 100ms gives video embed cards (which animate height over 0.25s) enough
                // time to settle so the scroll restoration lands at the right position.
                try? await Task.sleep(nanoseconds: 100_000_000)
                guard !Task.isCancelled else {
                    isSuppressingBottomScroll = false
                    return
                }
                os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested", "target=paginationAnchor")
                recordScrollLoopEvent(.scrollToRequested)
                proxy.scrollTo(id, anchor: .top)
                log.debug("[pagination] scroll restored to anchor \(id)")
                isSuppressingBottomScroll = false
                os_signpost(.event, log: PerfSignposts.log, name: "scrollSuppressionChanged", "off reason=paginationDone")
            }
        }
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

    /// Records a scroll-related event into the loop guard and emits a
    /// diagnostic warning if the guard trips (too many events in the window).
    private func recordScrollLoopEvent(_ kind: ChatScrollLoopGuard.EventKind) {
        let convId = conversationId?.uuidString ?? "unknown"
        let timestamp = ProcessInfo.processInfo.systemUptime

        if let snapshot = scrollLoopGuard.record(kind, conversationId: convId, timestamp: timestamp) {
            let countsDescription = snapshot.counts.map { "\($0.key.rawValue)=\($0.value)" }.joined(separator: " ")
            log.warning(
                "Scroll loop detected — trippedBy=\(snapshot.trippedBy.rawValue) window=\(snapshot.windowDuration)s \(countsDescription) isNearBottom=\(isNearBottom) hasReceivedScrollEvent=\(hasReceivedScrollEvent) anchorMessageId=\(String(describing: anchorMessageId)) anchorLastMinY=\(anchorTracker.lastMinY) viewportHeight=\(scrollViewportHeight)"
            )
            var sanitizer = NumericSanitizer()
            let safeScrollOffsetY = sanitizer.sanitize(anchorTracker.lastMinY, field: "scrollOffsetY")
            let safeViewportHeight = sanitizer.sanitize(scrollViewportHeight, field: "viewportHeight")
            logNonFiniteGeometryOnce(sanitizer: sanitizer)
            ChatDiagnosticsStore.shared.record(ChatDiagnosticEvent(
                kind: .scrollLoopDetected,
                conversationId: convId,
                reason: "trippedBy=\(snapshot.trippedBy.rawValue) \(countsDescription)",
                isPinnedToBottom: isNearBottom,
                isUserScrolling: hasReceivedScrollEvent,
                scrollOffsetY: safeScrollOffsetY,
                viewportHeight: safeViewportHeight,
                nonFiniteFields: sanitizer.nonFiniteFields
            ))
        }
    }

    /// Schedules a debounced transcript snapshot capture. Coalesces rapid scroll
    /// events into a single snapshot per 150ms window, avoiding O(n) tool-call
    /// scans on every scroll tick.
    private func scheduleTranscriptSnapshot() {
        scrollTracking.snapshotDebounceTask?.cancel()
        scrollTracking.snapshotDebounceTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(150))
            guard !Task.isCancelled else { return }
            updateTranscriptSnapshot()
        }
    }

    /// Captures a point-in-time transcript snapshot into `ChatDiagnosticsStore`.
    /// Called via `scheduleTranscriptSnapshot()` so that `DebugStateWriter`
    /// and `HangContextWriter` always have recent transcript state available.
    private func updateTranscriptSnapshot() {
        guard let convId = conversationId else { return }
        let msgs = messages
        let totalToolCalls = msgs.reduce(0) { $0 + $1.toolCalls.count }

        // Route all geometry through NumericSanitizer so non-finite values
        // (inf, -inf, NaN) are replaced with nil and tracked in nonFiniteFields.
        // scrollViewportHeight and lastTailAnchorY start as .infinity before
        // their preference callbacks run.
        var sanitizer = NumericSanitizer()
        let safeAnchorMinY = sanitizer.sanitize(anchorTracker.lastMinY, field: "anchorMinY")
        let safeTailAnchorY = sanitizer.sanitize(scrollTracking.lastTailAnchorY, field: "tailAnchorY")
        let safeViewportHeight = sanitizer.sanitize(scrollViewportHeight, field: "scrollViewportHeight")
        let safeContainerWidth = sanitizer.sanitize(containerWidth, field: "containerWidth")
        logNonFiniteGeometryOnce(sanitizer: sanitizer)

        // Capture rolling scroll loop guard counts for debug-state.json.
        let guardCounts = scrollLoopGuard.currentCounts(conversationId: convId.uuidString)
        let guardCountsStringKeyed: [String: Int]? = guardCounts.isEmpty ? nil : Dictionary(
            uniqueKeysWithValues: guardCounts.map { ($0.key.rawValue, $0.value) }
        )

        ChatDiagnosticsStore.shared.updateSnapshot(ChatTranscriptSnapshot(
            conversationId: convId.uuidString,
            capturedAt: Date(),
            messageCount: msgs.count,
            toolCallCount: totalToolCalls,
            isPinnedToBottom: isNearBottom,
            isUserScrolling: hasReceivedScrollEvent,
            scrollOffsetY: safeAnchorMinY,
            contentHeight: nil,
            viewportHeight: safeViewportHeight,
            isNearBottom: isNearBottom,
            hasReceivedScrollEvent: hasReceivedScrollEvent,
            isPaginationInFlight: isPaginationInFlight,
            suppressionReason: isSuppressingBottomScroll ? "bottomScrollSuppressed" : nil,
            anchorMessageId: anchorMessageId?.uuidString,
            highlightedMessageId: highlightedMessageId?.uuidString,
            anchorMinY: safeAnchorMinY,
            tailAnchorY: safeTailAnchorY,
            scrollViewportHeight: safeViewportHeight,
            containerWidth: safeContainerWidth,
            scrollLoopGuardCounts: guardCountsStringKeyed,
            nonFiniteFields: sanitizer.nonFiniteFields
        ))
    }

    /// Logs a one-time warning when scroll geometry first becomes non-finite
    /// during a render pass. Uses the MessageListView logger so the condition
    /// is visible even if the JSONL session log later fails for another reason.
    private func logNonFiniteGeometryOnce(sanitizer: NumericSanitizer) {
        guard !hasLoggedNonFiniteGeometry, let fields = sanitizer.nonFiniteFields else { return }
        hasLoggedNonFiniteGeometry = true
        log.warning("Non-finite scroll geometry detected — sanitized fields: \(fields.joined(separator: ", "))")
    }

    /// Routes an automatic bottom-follow request through the coordinator.
    /// The coordinator decides whether to suppress (user is detached), coalesce
    /// (duplicate request within an active session), or start a new bounded
    /// retry session. Anchor-message jumps and pagination restoration bypass
    /// this helper entirely — they are higher-priority flows.
    /// Sentinel UUID used for pin requests before the daemon assigns a real
    /// conversation ID. Lets bootstrap-window requests coalesce normally.
    private static let bootstrapConversationId = UUID(uuidString: "00000000-0000-0000-0000-000000000000")!

    private func requestBottomPin(
        reason: BottomPinRequestReason,
        proxy: ScrollViewProxy,
        animated: Bool = false
    ) {
        let convId = conversationId ?? Self.bootstrapConversationId
        bottomPinCoordinator.requestPin(
            reason: reason,
            conversationId: convId,
            animated: animated
        )
    }

    /// Configures the coordinator's callbacks to wire pin requests back to
    /// the scroll view proxy and follow-state changes back to `isNearBottom`.
    private func configureBottomPinCoordinator(proxy: ScrollViewProxy) {
        bottomPinCoordinator.onPinRequested = { [self] reason, animated in
            guard !isSuppressingBottomScroll else { return false }
            // Circuit breaker: suppress scroll-to when a scroll loop was detected.
            // The guard re-arms after a quiet cooldown window elapses.
            let convIdString = conversationId?.uuidString ?? "unknown"
            if scrollLoopGuard.isTripped(conversationId: convIdString) {
                os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested",
                            "target=bottomAnchor reason=circuitBreakerSuppressed")
                return false
            }
            os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested",
                        "target=bottomAnchor reason=coordinator-%{public}s", reason.rawValue)
            recordScrollLoopEvent(.scrollToRequested)
            if animated {
                withAnimation(VAnimation.fast) {
                    proxy.scrollTo("scroll-bottom-anchor", anchor: .bottom)
                }
            } else {
                proxy.scrollTo("scroll-bottom-anchor", anchor: .bottom)
            }
            // Check if the pin succeeded (anchor within viewport).
            // Use `verify()` so that `geometryUnavailable` returns false
            // (wait for the next finite preference update) instead of being
            // treated as an immediate failed pin that triggers retry churn.
            let outcome = MessageListBottomAnchorPolicy.verify(
                anchorMinY: anchorTracker.lastMinY,
                viewportHeight: scrollViewportHeight
            )
            return outcome == .anchored
        }
        bottomPinCoordinator.onFollowStateChanged = { isFollowing in
            isNearBottom = isFollowing
        }

        // If detach() was called before this callback was wired up (e.g. a
        // scroll-wheel event fired between makeNSView and onAppear), sync
        // isNearBottom now so it isn't stuck at true permanently.
        if !bottomPinCoordinator.isFollowingBottom {
            isNearBottom = false
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
                            if !hasReceivedScrollEvent {
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
                expandSuppressionTask?.cancel()
                if isNearBottom {
                    // Clear any stale suppression left by a canceled off-bottom expansion,
                    // but only when the resize guard isn't actively suppressing scroll.
                    let resizeActive = resizeScrollTask != nil && !resizeScrollTask!.isCancelled
                    if !resizeActive {
                        isSuppressingBottomScroll = false
                    }
                    // Route expansion bottom-follow through the coordinator for
                    // bounded staged retries instead of per-frame repinning.
                    os_signpost(.event, log: PerfSignposts.log, name: "scrollSuppressionChanged", "on reason=expansionPinning")
                    recordScrollLoopEvent(.suppressionFlip)
                    requestBottomPin(reason: .expansion, proxy: proxy, animated: false)
                } else {
                    // When scrolled away from bottom, suppress auto-scroll so the
                    // expansion doesn't yank the viewport to the bottom.
                    isSuppressingBottomScroll = true
                    os_signpost(.event, log: PerfSignposts.log, name: "scrollSuppressionChanged", "on reason=offBottomExpansion")
                    recordScrollLoopEvent(.suppressionFlip)
                    expandSuppressionTask = Task { @MainActor in
                        try? await Task.sleep(nanoseconds: 200_000_000)
                        guard !Task.isCancelled else { return }
                        // Only clear if no other mechanism (resize, pagination) still needs suppression.
                        let resizeActive = resizeScrollTask != nil && !resizeScrollTask!.isCancelled
                        let paginationActive = isPaginationInFlight
                        if !resizeActive && !paginationActive {
                            isSuppressingBottomScroll = false
                            os_signpost(.event, log: PerfSignposts.log, name: "scrollSuppressionChanged", "off reason=expansionExpired")
                        }
                    }
                }
            })
            .background {
                GeometryReader { geo in
                    Color.clear.preference(key: ScrollViewportHeightKey.self, value: geo.size.height)
                }
                ScrollWheelDetector(
                    onScrollUp: {

                        scrollRestoreTask?.cancel()
                        scrollRestoreTask = nil
                        expandSuppressionTask?.cancel()
                        expandSuppressionTask = nil
                        isSuppressingBottomScroll = false
                        // Signal the coordinator to detach — this sets isNearBottom
                        // to false and cancels any active pin session.
                        bottomPinCoordinator.handleUserAction(.scrollUp)
                        hasReceivedScrollEvent = true
                    },
                    onScrollToBottom: {
                        scrollRestoreTask?.cancel()
                        scrollRestoreTask = nil
                        isSuppressingBottomScroll = false
                        // Signal the coordinator to reattach — this sets isNearBottom
                        // to true and allows future pin requests.
                        bottomPinCoordinator.handleUserAction(.scrollToBottom)
                        hasReceivedScrollEvent = true
                    },
                    conversationId: conversationId
                )
                ConversationScrollbarVisibilityController(isAppActive: isAppActive, suppressScrollbar: suppressScrollbarDuringConversationSwitch)
            }
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
                let viewportChanged = anchorTracker.updateViewport(
                    height: accepted,
                    storedViewportHeight: &scrollViewportHeight
                )
                if viewportChanged, scrollTracking.lastTailAnchorY.isFinite {
                    // Reconcile the avatar follower on resize so a hidden target
                    // is refreshed before a later visibility transition reveals it.
                    updateAvatarFollower(anchorY: scrollTracking.lastTailAnchorY)
                }
                os_signpost(.end, log: PerfSignposts.log, name: "viewportHeightPreferenceChange")
            }
            .transaction { $0.disablesAnimations = true }
            .onPreferenceChange(AnchorMinYKey.self) { minY in
                // Filter non-finite anchor values and apply 2pt dead-zone to
                // reduce layout invalidation cascades during rapid scroll.
                let decision = PreferenceGeometryFilter.evaluate(
                    newValue: minY,
                    previous: anchorTracker.lastMinY
                )
                switch decision {
                case .rejectNonFinite:
                    // The anchor was deallocated by the LazyVStack (no child reports
                    // a finite value, so the preference reduces to its .infinity default).
                    // Mark the anchor as off-screen so the "Scroll to latest" button can appear.
                    // Also reset lastMinY to .infinity so the button condition
                    // (!isNearBottom && !isVisible && lastMinY > viewportHeight + 20) is satisfied.
                    // .infinity is safe: updateViewport() guards isFinite, evaluate() treats
                    // it as a skip for the dead-zone check, and verify() returns .geometryUnavailable.
                    if anchorTracker.isVisible {
                        anchorTracker.isVisible = false
                        log.debug("Anchor preference non-finite — marking anchor invisible (deallocated by LazyVStack)")
                    }
                    anchorTracker.lastMinY = .infinity
                    return
                case .rejectDeadZone:
                    return
                case .accept(let accepted):
                    os_signpost(.begin, log: PerfSignposts.log, name: "anchorMinYPreferenceChange")
                    recordScrollLoopEvent(.anchorPreferenceChange)
                    anchorTracker.update(minY: accepted, viewportHeight: scrollViewportHeight)
                    if !hasFreshAnchorMeasurement {
                        hasFreshAnchorMeasurement = true
                        // First finite anchor measurement after a conversation switch.
                        // LazyVStack may report the anchor as "within viewport" before
                        // materializing message cells, causing the coordinator to skip
                        // the scrollTo. Bypass the coordinator and scroll directly so
                        // messages are visible without user interaction.
                        if !hasReceivedScrollEvent && anchorMessageId == nil {
                            proxy.scrollTo("scroll-bottom-anchor", anchor: .bottom)
                        }
                    }
                    scheduleTranscriptSnapshot()
                    // Geometry tracking only — no per-frame scrollTo calls here.
                    // All bottom-follow work is handled by the ChatBottomPinCoordinator
                    // via bounded staged retries, not inline on every anchor change.
                    os_signpost(.end, log: PerfSignposts.log, name: "anchorMinYPreferenceChange")
                }
            }
            .transaction { $0.disablesAnimations = true }
            .onPreferenceChange(ConversationTailAnchorYKey.self) { anchorY in
                // Filter non-finite tail anchor values and apply 2pt dead-zone
                // to reduce layout invalidation cascades during rapid scroll.
                let decision = PreferenceGeometryFilter.evaluate(
                    newValue: anchorY,
                    previous: scrollTracking.lastTailAnchorY
                )
                guard case .accept(let accepted) = decision else { return }
                recordScrollLoopEvent(.tailAnchorPreferenceChange)
                scrollTracking.lastTailAnchorY = accepted
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
                // Filter non-finite sentinel values to prevent transient layout
                // data from corrupting pagination trigger state. No dead-zone —
                // every finite position change matters for edge-transition detection.
                guard PreferenceGeometryFilter.evaluate(
                    newValue: sentinelMinY,
                    previous: .infinity,
                    deadZone: 0
                ) != .rejectNonFinite else { return }

                let isInRange = MessageListPaginationTriggerPolicy.isInTriggerBand(
                    sentinelMinY: sentinelMinY,
                    viewportHeight: scrollViewportHeight
                )
                let shouldFire = MessageListPaginationTriggerPolicy.shouldTrigger(
                    sentinelMinY: sentinelMinY,
                    viewportHeight: scrollViewportHeight,
                    wasInRange: wasPaginationTriggerInRange
                )
                wasPaginationTriggerInRange = isInRange

                log.debug("[pagination] sentinel minY=\(sentinelMinY, privacy: .public) inRange=\(isInRange) shouldFire=\(shouldFire) hasMore=\(hasMoreMessages) loading=\(isLoadingMoreMessages) inFlight=\(isPaginationInFlight)")

                guard shouldFire,
                      hasMoreMessages,
                      !isLoadingMoreMessages,
                      !isPaginationInFlight
                else { return }

                log.debug("[pagination] sentinel entered range — triggering pagination")
                triggerPagination(proxy: proxy)
            }
            .overlay(alignment: .topLeading) {
                conversationTailAvatar
            }
            .overlay(alignment: .bottom) {
                if !isNearBottom && !anchorTracker.isVisible
                    && anchorTracker.lastMinY > scrollViewportHeight + 20
                {
                    Button(action: {
                        os_signpost(.event, log: PerfSignposts.log, name: "scrollToLatestPressed")
                        hasReceivedScrollEvent = true
                        // Signal the coordinator to reattach and scroll to bottom.
                        bottomPinCoordinator.handleUserAction(.jumpToLatest)
                        requestBottomPin(reason: .initialRestore, proxy: proxy, animated: true)
                    }) {
                        HStack(spacing: VSpacing.xs) {
                            VIconView(.arrowDown, size: 10)
                            Text("Scroll to latest")
                                .font(VFont.monoSmall)
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
                isAppActive = NSApp.isActive
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
                            bottomPinCoordinator.reattach()
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
                conversationSwitchSuppressionTask?.cancel()
                conversationSwitchSuppressionTask = nil
                suppressScrollbarDuringConversationSwitch = false
                anchorTimeoutTask?.cancel()
                anchorTimeoutTask = nil
                resizeScrollTask?.cancel()
                resizeScrollTask = nil
                expandSuppressionTask?.cancel()
                expandSuppressionTask = nil
                scrollRestoreTask?.cancel()
                scrollRestoreTask = nil
                paginationTask?.cancel()
                paginationTask = nil
                isPaginationInFlight = false
                avatarSmoothingTask?.cancel()
                avatarSmoothingTask = nil
                highlightDismissTask?.cancel()
                highlightDismissTask = nil
                scrollTracking.snapshotDebounceTask?.cancel()
                scrollTracking.snapshotDebounceTask = nil
                highlightedMessageId = nil
                // Cancel any active pin session to prevent the coordinator's
                // sessionTask from calling scrollTo on a stale ScrollViewProxy.
                bottomPinCoordinator.cancelActiveSession(reason: .conversationSwitch)
                bottomPinCoordinator.onPinRequested = nil
            }
            .onChange(of: isSending) {
                if isSending {
                    hasReceivedScrollEvent = true
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
                    if isDaemonConfirmationResume && !bottomPinCoordinator.isFollowingBottom {
                        // Daemon resumed from confirmation while user was scrolled up.
                    } else {
                        bottomPinCoordinator.reattach()
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
                    updateAvatarFollower(anchorY: scrollTracking.pendingAvatarY ?? scrollTracking.avatarTargetY)
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
                    bottomPinCoordinator.cancelActiveSession(reason: .deepLinkAnchorHandoff)
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
                        bottomPinCoordinator.reattach()
                        requestBottomPin(reason: .messageCount, proxy: proxy, animated: true)
                        return
                    }
                }
                if isNearBottom && !isSuppressingBottomScroll && anchorMessageId == nil {
                    requestBottomPin(reason: .messageCount, proxy: proxy, animated: true)
                } else if !hasReceivedScrollEvent && anchorMessageId == nil && !messages.isEmpty {
                    // History just loaded but the coordinator's initial-restore session
                    // may have already expired (500ms timeout). Force a fresh scroll-to-bottom
                    // so messages are visible without requiring user scroll interaction.
                    requestBottomPin(reason: .initialRestore, proxy: proxy)
                } else if isSuppressingBottomScroll {
                    log.debug("Auto-scroll suppressed (bottom-scroll suppression active)")
                }
            }
            .onChange(of: containerWidth) {
                // Ignore sub-pixel jitter and initial zero value.
                // Use a tight 2pt threshold so scroll suppression activates on
                // any meaningful width change during divider drag — the previous
                // 20pt dead-zone let intermediate reflows through without suppression,
                // causing scroll position desync and disappearing messages.
                guard containerWidth > 0, abs(containerWidth - lastHandledContainerWidth) > 2 else { return }
                lastHandledContainerWidth = containerWidth

                // Cancel competing scroll tasks to prevent jitter during resize
                resizeScrollTask?.cancel()

                resizeScrollTask = Task { @MainActor in
                    // Temporarily suppress bottom auto-scroll so streaming/message-count
                    // handlers don't fight with the resize stabilization.
                    isSuppressingBottomScroll = true
                    os_signpost(.event, log: PerfSignposts.log, name: "scrollSuppressionChanged", "on reason=resize")
                    defer {
                        if !Task.isCancelled {
                            isSuppressingBottomScroll = false
                            os_signpost(.event, log: PerfSignposts.log, name: "scrollSuppressionChanged", "off reason=resizeDone")
                            resizeScrollTask = nil
                        }
                    }
                    // Wait for layout to settle (~100ms ≈ 6 frames)
                    try? await Task.sleep(nanoseconds: 100_000_000)
                    guard !Task.isCancelled else { return }

                    if isNearBottom && anchorMessageId == nil {
                        // Pin to bottom without animation to avoid visual bounce.
                        // Skip when an anchor is pending (deep-link / notification)
                        // to avoid yanking the viewport away from the target message.
                        // Only repin for genuinely off-screen anchors — transient
                        // missing geometry waits for the next finite preference update.
                        let resizeOutcome = MessageListBottomAnchorPolicy.verify(
                            anchorMinY: anchorTracker.lastMinY,
                            viewportHeight: scrollViewportHeight
                        )
                        if resizeOutcome == .needsRepin {
                            requestBottomPin(reason: .resize, proxy: proxy)
                        }
                    }
                    // If not near bottom or anchor is set, preserve viewport.
                }
            }
            .onChange(of: conversationId) { oldConversationId, _ in
                // Keep the underlying NSScrollView instance stable across conversation
                // switches (prevents default-scroller flash), and reset view-local
                // scroll state explicitly instead of remounting the whole view.
                resizeScrollTask?.cancel()
                resizeScrollTask = nil
                expandSuppressionTask?.cancel()
                expandSuppressionTask = nil
                avatarSmoothingTask?.cancel()
                avatarSmoothingTask = nil
                scrollTracking.snapshotDebounceTask?.cancel()
                scrollTracking.snapshotDebounceTask = nil
                paginationTask?.cancel()
                paginationTask = nil
                isPaginationInFlight = false
                wasPaginationTriggerInRange = false
                isSuppressingBottomScroll = false
                // Reset the coordinator for the new conversation — cancels any
                // active pin session and resets to following state.
                bottomPinCoordinator.reset(newConversationId: conversationId)
                isNearBottom = true
                highlightedMessageId = nil
                highlightDismissTask?.cancel()
                highlightDismissTask = nil
                anchorTracker.isVisible = true
                // Reset lastMinY to .infinity so the AnchorMinYKey preference
                // handler's 2pt dead-zone doesn't filter out the first real
                // measurement after a conversation switch. A value of 0 could
                // collide with the actual anchor position and prevent
                // hasFreshAnchorMeasurement from becoming true.
                anchorTracker.lastMinY = .infinity
                hasReceivedScrollEvent = false
                // Capture the new conversation's activity phase so a conversation
                // already paused in awaiting_confirmation is correctly tracked.
                phaseWhenSendingStopped = isSending ? "" : assistantActivityPhase
                // Reset the OLD conversation's scroll-loop guard state so it
                // doesn't leak into future sessions for that conversation.
                if let oldConvId = oldConversationId {
                    scrollLoopGuard.reset(conversationId: oldConvId.uuidString)
                }
                lastHandledContainerWidth = containerWidth
                anchorTimeoutTask?.cancel()
                anchorTimeoutTask = nil
                conversationSwitchSuppressionTask?.cancel()
                suppressScrollbarDuringConversationSwitch = true
                conversationSwitchSuppressionTask = Task { @MainActor in
                    // Let the newly-selected conversation finish its first layout pass so
                    // the scroller style/metrics settle before allowing re-show.
                    do {
                        try await Task.sleep(nanoseconds: 150_000_000)
                    } catch {
                        return
                    }
                    guard !Task.isCancelled else { return }
                    suppressScrollbarDuringConversationSwitch = false
                    conversationSwitchSuppressionTask = nil
                }
                hasPlayedTailEntryAnimation = false
                // Avatar state (scrollTracking.avatarTargetY, avatarDisplayY, scrollTracking)
                // is reset inside
                // restoreScrollToBottom so the reset is shared with onAppear.
                restoreScrollToBottom(proxy: proxy)
            }
            .onChange(of: anchorMessageId) {
                // Only cancel scroll restore when a new anchor is set (non-nil).
                // The nil transition fires during conversation switches (stale anchor
                // cleanup) and must not cancel the restore just started.
                if anchorMessageId != nil {
                    scrollRestoreTask?.cancel()
                    scrollRestoreTask = nil
                    // Anchor jumps are higher priority — cancel any active pin session.
                    bottomPinCoordinator.cancelActiveSession(reason: .deepLinkAnchorHandoff)
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
                        bottomPinCoordinator.reattach()
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
            .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
                isAppActive = true
            }
            .onReceive(NotificationCenter.default.publisher(for: NSApplication.didResignActiveNotification)) { _ in
                isAppActive = false
                conversationSwitchSuppressionTask?.cancel()
                conversationSwitchSuppressionTask = nil
                suppressScrollbarDuringConversationSwitch = false
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

/// Controls scrollbar visibility using AppKit's NSTrackingArea for hover detection
/// instead of SwiftUI's `.onHover`. This avoids feeding hover state through the
/// SwiftUI state graph, which would trigger expensive body re-evaluations and
/// hover hit-testing through the entire message list on every mouse move.
private struct ConversationScrollbarVisibilityController: NSViewRepresentable, Equatable {
    let isAppActive: Bool
    let suppressScrollbar: Bool

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async {
            context.coordinator.install(from: view)
            context.coordinator.update(isAppActive: isAppActive, suppressScrollbar: suppressScrollbar)
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        // If the initial async install in makeNSView ran before the view was in
        // the hierarchy, findEnclosingScrollView would have returned nil and the
        // controller stays permanently uninstalled. Retry here — but only when
        // still unresolved, to avoid the render loop that unconditional
        // re-installation would cause.
        if context.coordinator.lastResolvedScrollView == nil {
            context.coordinator.install(from: nsView)
        }
        context.coordinator.update(isAppActive: isAppActive, suppressScrollbar: suppressScrollbar)
    }

    static func dismantleNSView(_ nsView: NSView, coordinator: Coordinator) {
        coordinator.cleanup()
    }

    final class Coordinator: NSObject {
        weak var lastResolvedScrollView: NSScrollView?
        private var trackingArea: NSTrackingArea?
        private var isMouseInside: Bool = false
        private var isAppActive: Bool = true
        private var suppressScrollbar: Bool = false
        private var hoverExitWorkItem: DispatchWorkItem?
        private var isInstalled: Bool = false

        func install(from markerView: NSView) {
            guard !isInstalled else { return }
            guard let scrollView = findEnclosingScrollView(from: markerView) else { return }
            lastResolvedScrollView = scrollView
            isInstalled = true

            // Configure scroll view once
            scrollView.hasVerticalScroller = true
            scrollView.hasHorizontalScroller = false
            scrollView.autohidesScrollers = false
            scrollView.scrollerStyle = .overlay
            scrollView.scrollerInsets = NSEdgeInsets(top: 0, left: 0, bottom: 0, right: 0)
            scrollView.automaticallyAdjustsContentInsets = false
            scrollView.verticalScroller?.controlSize = .small

            // Install tracking area on the scroll view. `.inVisibleRect` auto-updates
            // the rect on resize; `.activeInActiveApp` stops tracking when the app
            // is in the background.
            let area = NSTrackingArea(
                rect: .zero,
                options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect],
                owner: self,
                userInfo: nil
            )
            scrollView.addTrackingArea(area)
            trackingArea = area

            // Check if the mouse is already inside
            if let window = scrollView.window {
                let mouseLocation = window.mouseLocationOutsideOfEventStream
                let pointInScrollView = scrollView.convert(mouseLocation, from: nil)
                isMouseInside = scrollView.bounds.contains(pointInScrollView)
            }

            updateVisibility()
        }

        func update(isAppActive: Bool, suppressScrollbar: Bool) {
            guard isAppActive != self.isAppActive || suppressScrollbar != self.suppressScrollbar else { return }
            let wasActive = self.isAppActive
            self.isAppActive = isAppActive
            self.suppressScrollbar = suppressScrollbar

            // When app deactivates, clear hover state so scrollbar hides.
            // NSTrackingArea with .activeInActiveApp stops sending events
            // but doesn't emit mouseExited, so we reset manually.
            if wasActive && !isAppActive {
                hoverExitWorkItem?.cancel()
                hoverExitWorkItem = nil
                isMouseInside = false
            }

            updateVisibility()
        }

        @objc func mouseEntered(with event: NSEvent) {
            hoverExitWorkItem?.cancel()
            hoverExitWorkItem = nil
            isMouseInside = true
            updateVisibility()
        }

        @objc func mouseExited(with event: NSEvent) {
            // Debounce exit to avoid scrollbar flicker during rapid
            // enter/exit transitions across nested subviews.
            hoverExitWorkItem?.cancel()
            let workItem = DispatchWorkItem { [weak self] in
                self?.isMouseInside = false
                self?.updateVisibility()
                self?.hoverExitWorkItem = nil
            }
            hoverExitWorkItem = workItem
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.12, execute: workItem)
        }

        func cleanup() {
            hoverExitWorkItem?.cancel()
            hoverExitWorkItem = nil
            if let area = trackingArea, let scrollView = lastResolvedScrollView {
                scrollView.removeTrackingArea(area)
            }
            trackingArea = nil
        }

        private func updateVisibility() {
            guard let scrollView = lastResolvedScrollView else { return }
            let shouldShow = isMouseInside && isAppActive && !suppressScrollbar
            scrollView.verticalScroller?.isEnabled = shouldShow
            scrollView.verticalScroller?.isHidden = !shouldShow
            scrollView.verticalScroller?.alphaValue = shouldShow ? 1 : 0
            scrollView.reflectScrolledClipView(scrollView.contentView)
        }

        private func findEnclosingScrollView(from view: NSView) -> NSScrollView? {
            if let scrollView = view.enclosingScrollView { return scrollView }
            var current: NSView? = view.superview
            while let ancestor = current {
                if let scrollView = ancestor as? NSScrollView {
                    return scrollView
                }
                current = ancestor.superview
            }
            guard let window = view.window, let contentView = window.contentView else { return nil }
            let probeInWindow = view.convert(
                NSPoint(x: view.bounds.midX, y: view.bounds.midY),
                to: nil
            )
            return deepestScrollView(in: contentView, containing: probeInWindow)
        }

        private func deepestScrollView(in view: NSView, containing windowPoint: NSPoint) -> NSScrollView? {
            let localPoint = view.convert(windowPoint, from: nil)
            guard view.bounds.contains(localPoint) else { return nil }

            for subview in view.subviews.reversed() {
                if let nested = deepestScrollView(in: subview, containing: windowPoint) {
                    return nested
                }
            }

            if let scrollView = view as? NSScrollView {
                return scrollView
            }
            return nil
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
