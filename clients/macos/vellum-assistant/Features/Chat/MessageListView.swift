import AppKit
import Combine
import os
import SwiftUI
import VellumAssistantShared

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "MessageListView")

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

    func updateViewport(height: CGFloat, storedViewportHeight: inout CGFloat) {
        guard storedViewportHeight != height else { return }
        storedViewportHeight = height
        // Don't recompute visibility before the anchor position has been
        // measured — lastMinY starts at .infinity, and .infinity <= height + 20
        // evaluates to false, incorrectly flipping isVisible to false and
        // flashing the "Scroll to latest" button on short conversations.
        guard lastMinY.isFinite else { return }
        let newVisible = lastMinY >= -20 && lastMinY <= height + 20
        if isVisible != newVisible { isVisible = newVisible }
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
    /// When true, the AnchorMinYKey preference handler re-pins to bottom
    /// on every frame — used during content expansion while bottom-pinned.
    var isPinningDuringExpansion: Bool = false
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
    let onReportMessage: ((String?) -> Void)?
    let mediaEmbedSettings: MediaEmbedResolverSettings?
    /// Resolves the daemon HTTP port at call time so lazy-loaded video
    /// attachments always use the latest port after daemon restarts.
    var resolveHttpPort: (() -> Int?) = { nil }
    var onModelPickerSelect: ((UUID, String) -> Void)?
    var onAbortSubagent: ((String) -> Void)?
    var onSubagentTap: ((String) -> Void)?
    /// Called to rehydrate truncated message content on demand.
    var onRehydrateMessage: ((UUID) -> Void)?
    /// Called when a stripped surface scrolls into view and needs its data re-fetched.
    var onSurfaceRefetch: ((String, String) -> Void)?
    /// Called when the user taps "Retry" on a per-message send failure.
    var onRetryFailedMessage: ((UUID) -> Void)?
    /// Called when the user taps "Retry" on an inline conversation error.
    var onRetryConversationError: (() -> Void)?
    var subagentDetailStore: SubagentDetailStore

    // MARK: - Credits Exhausted (inline banner)

    /// Non-nil when the conversation ended due to credits exhaustion.
    var creditsExhaustedError: ConversationError? = nil
    /// Opens the billing / add-funds flow.
    var onAddFunds: (() -> Void)? = nil
    /// Dismisses the credits-exhausted banner.
    var onDismissCreditsExhausted: (() -> Void)? = nil

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
    @Environment(\.conversationZoomScale) private var conversationZoomScale
    @AppStorage("hasEverSentMessage") private var hasEverSentMessage: Bool = false
    @AppStorage("completedConversationCount") private var completedConversationCount: Int = 0
    @State private var identity: IdentityInfo? = IdentityInfo.load()
    @State private var appearance = AvatarAppearanceManager.shared
    /// Read once at the list level and passed down to each ChatBubble so that
    /// individual bubbles don't each subscribe to the shared ObservableObject.
    @State private var scrollDebounceTask: Task<Void, Never>?
    /// Only the active surface ID is needed here (to suppress inline rendering).
    /// Observing the full TaskProgressOverlayManager would cause the entire
    /// message list to re-render on every frequent `data` progress tick.
    @State private var activeSurfaceId: String?
    /// Guards the pagination sentinel against re-entry during the brief window
    /// between Task launch and the first `await` (before isLoadingMoreMessages is set).
    @State private var isPaginationInFlight: Bool = false
    /// Suppresses bottom auto-scroll for the ~32ms layout window after pagination
    /// restores scroll position, preventing a jump back to the bottom.
    @State private var isSuppressingBottomScroll: Bool = false
    @State private var isConversationContentHovered: Bool = false
    @State private var isAppActive: Bool = NSApp.isActive
    @State private var hoverExitDebounceTask: Task<Void, Never>?
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
    /// the current conversation loaded. Before any scroll event, `isNearBottom`
    /// (which defaults to `true`) is not trusted; the button relies solely on
    /// `anchorTracker.isVisible` to decide visibility.
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
    /// detect meaningful width changes (>20pt) and avoid sub-pixel jitter.
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
    @State private var avatarTargetY: CGFloat = .infinity
    @State private var avatarDisplayY: CGFloat = .infinity
    @State private var avatarSmoothingTask: Task<Void, Never>?
    @State private var hasPlayedTailEntryAnimation = false
    /// Non-reactive scroll tracking state (dead-zone guards, smoothing).
    /// Stored on a class so mutations never trigger body re-evaluations.
    @State private var scrollTracking = ScrollTrackingState()

    /// The subset of messages actually shown, honoring the pagination window.
    private var visibleMessages: [ChatMessage] {
        let all = messages.filter { !$0.isSubagentNotification }
        // When displayedMessageCount covers all messages (or is Int.max / show-all mode),
        // return everything so new incoming messages don't collapse visible history.
        guard displayedMessageCount < all.count else { return all }
        return Array(all.suffix(displayedMessageCount))
    }

    /// The active pending confirmation request ID, derived from the visible
    /// messages. Used by onChange to detect new confirmation appearances.
    private var currentPendingRequestId: String? {
        PendingConfirmationFocusSelector.activeRequestId(from: visibleMessages)
    }

    /// Triggers auto-scroll when the last message's content changes (text streaming,
    /// tool call output, inline surface updates). Combines text byte count, tool call
    /// count, inline surface count, and tool call partial-output revisions so that any
    /// content growth — including tool output streaming between text segments — produces
    /// a new value and fires onChange.
    private var streamingScrollTrigger: Int {
        let last = messages.last(where: { if case .queued = $0.status { return false }; return true })
        let textLen = last?.textSegments.reduce(0) { $0 + $1.utf8.count } ?? 0
        let toolCallFingerprint = last?.toolCalls.reduce(0) {
            $0 + ($1.isComplete ? 1 : 0) + $1.partialOutputRevision + $1.claudeCodeSteps.count
        } ?? 0
        return textLen + (last?.toolCalls.count ?? 0) + (last?.inlineSurfaces.count ?? 0) + toolCallFingerprint
    }

    /// Computes all expensive derived values once per body evaluation.
    /// Moving these out of the LazyVStack closure ensures O(n) scans
    /// (timestamp indices, subagent grouping, turn detection) run once
    /// per body evaluation rather than being re-evaluated on layout passes.
    private var precomputedState: PrecomputedMessageListState {
        let displayMessages = visibleMessages
        let activePendingRequestId = PendingConfirmationFocusSelector.activeRequestId(from: displayMessages)
        let latestAssistantId = displayMessages.last(where: { $0.role == .assistant })?.id
        let anchoredThinkingIndex = resolvedThinkingAnchorIndex(for: displayMessages)
        let subagentsByParent: [UUID: [SubagentInfo]] = Dictionary(
            grouping: activeSubagents.filter { $0.parentMessageId != nil },
            by: { $0.parentMessageId! }
        )
        let orphanSubagents = activeSubagents.filter { $0.parentMessageId == nil }
        let showTimestamp = timestampIndices(for: displayMessages)
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

        return PrecomputedMessageListState(
            displayMessages: displayMessages,
            activePendingRequestId: activePendingRequestId,
            latestAssistantId: latestAssistantId,
            anchoredThinkingIndex: anchoredThinkingIndex,
            subagentsByParent: subagentsByParent,
            orphanSubagents: orphanSubagents,
            showTimestamp: showTimestamp,
            lastVisible: lastVisible,
            currentTurnMessages: currentTurnMessages,
            hasActiveToolCall: hasActiveToolCall,
            wouldShowThinking: wouldShowThinking,
            lastVisibleIsAssistant: lastVisibleIsAssistant,
            canInlineProcessing: canInlineProcessing,
            shouldShowThinkingIndicator: shouldShowThinkingIndicator,
            effectiveStatusText: effectiveStatusText
        )
    }

    /// Pre-compute which message indices should show a timestamp divider.
    /// Avoids creating a Calendar instance per-message inside the ForEach body.
    private func timestampIndices(for list: [ChatMessage]) -> Set<Int> {
        guard !list.isEmpty else { return [] }
        var result: Set<Int> = [0]
        var calendar = Calendar.current
        calendar.timeZone = ChatTimestampTimeZone.resolve()
        for i in 1..<list.count {
            let current = list[i].timestamp
            let previous = list[i - 1].timestamp
            if !calendar.isDate(current, inSameDayAs: previous) || current.timeIntervalSince(previous) > 300 {
                result.insert(i)
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
        return ConversationAvatarFollower.shouldShow(
            anchorY: avatarTargetY,
            viewportHeight: scrollViewportHeight
        )
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
        let y = anchorY + ConversationAvatarFollower.verticalOffset
        // Dead-zone: skip @State update when position hasn't moved meaningfully.
        // Each avatarDisplayY change triggers a MessageListView body re-evaluation;
        // sub-pixel jitter during scroll would otherwise cause continuous re-renders.
        guard abs(avatarDisplayY - y) > 2 else { return }
        withAnimation(ConversationAvatarFollower.spring) {
            avatarDisplayY = y
        }
    }

    private func updateAvatarFollower(anchorY: CGFloat) {
        // Only update @State when the visibility boundary is crossed, finitude
        // changes, or the stored value drifts too far from reality. The relaxed
        // threshold (20pt) keeps avatarTargetY fresh enough that the coalescing
        // flush path (onChange of shouldCoalesceAvatarUpdates) won't see a large
        // stale jump, while still avoiding the ~60 @State updates/sec that the
        // original 1pt threshold caused during scroll.
        let visibilityChanged: Bool = {
            let wasVisible = avatarTargetY.isFinite
                && ConversationAvatarFollower.shouldShow(anchorY: avatarTargetY, viewportHeight: scrollViewportHeight)
            let nowVisible = anchorY.isFinite
                && ConversationAvatarFollower.shouldShow(anchorY: anchorY, viewportHeight: scrollViewportHeight)
            return wasVisible != nowVisible
        }()
        if visibilityChanged || abs(avatarTargetY - anchorY) > 20 || !avatarTargetY.isFinite != !anchorY.isFinite {
            avatarTargetY = anchorY
        }

        guard anchorY.isFinite else {
            avatarSmoothingTask?.cancel()
            avatarSmoothingTask = nil
            scrollTracking.pendingAvatarY = nil
            scrollTracking.avatarLastAppliedAt = nil
            if avatarDisplayY != .infinity { avatarDisplayY = .infinity }
            return
        }

        // Skip position tracking when the avatar is off-screen. The avatar
        // overlay is hidden via shouldShowConversationTailAvatar, so updating
        // avatarDisplayY for an invisible element just wastes layout passes.
        let nowVisible = ConversationAvatarFollower.shouldShow(
            anchorY: anchorY, viewportHeight: scrollViewportHeight
        )
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
            scrollTracking.avatarLastAppliedAt = now
            applyAvatarDisplayY(forAnchorY: anchorY)
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
            scrollTracking.avatarLastAppliedAt = Date()
            applyAvatarDisplayY(forAnchorY: pending)
            avatarSmoothingTask = nil
        }
    }

    @ViewBuilder
    private var conversationTailAvatar: some View {
        if shouldShowConversationTailAvatar {
            if let body = appearance.characterBodyShape,
               let eyes = appearance.characterEyeStyle,
               let color = appearance.characterColor {
                AnimatedAvatarView(bodyShape: body, eyeStyle: eyes, color: color,
                                   size: ConversationAvatarFollower.avatarSize,
                                   entryAnimationEnabled: shouldPlayTailEntryAnimation)
                    .frame(width: ConversationAvatarFollower.avatarSize,
                           height: ConversationAvatarFollower.avatarSize)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, VSpacing.xl)
                    .frame(maxWidth: VSpacing.chatColumnMaxWidth)
                    .frame(maxWidth: .infinity)
                    .offset(y: avatarDisplayY)
                    .accessibilityHidden(true)
                    .onAppear {
                        if shouldPlayTailEntryAnimation {
                            hasPlayedTailEntryAnimation = true
                        }
                    }
            } else {
                HStack {
                    VAvatarImage(image: appearance.chatAvatarImage, size: ConversationAvatarFollower.avatarSize)
                    Spacer()
                }
                .padding(.horizontal, VSpacing.xl)
                .frame(maxWidth: VSpacing.chatColumnMaxWidth)
                .frame(maxWidth: .infinity)
                .offset(y: avatarDisplayY)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
        }
    }

    private var shouldShowConversationScrollbar: Bool {
        isAppActive && isConversationContentHovered && !suppressScrollbarDuringConversationSwitch
    }

    private func handleConversationContentHover(_ hovering: Bool) {
        if hovering {
            hoverExitDebounceTask?.cancel()
            hoverExitDebounceTask = nil
            isConversationContentHovered = true
            return
        }

        // SwiftUI/AppKit can emit rapid hover false/true transitions while moving
        // across nested subviews; delay hide slightly to avoid visible flicker.
        hoverExitDebounceTask?.cancel()
        hoverExitDebounceTask = Task { @MainActor in
            do {
                try await Task.sleep(nanoseconds: 120_000_000)
            } catch {
                return
            }
            guard !Task.isCancelled else { return }
            isConversationContentHovered = false
            hoverExitDebounceTask = nil
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
        avatarTargetY = .infinity
        avatarDisplayY = .infinity
        scrollTracking.pendingAvatarY = nil
        scrollTracking.avatarLastAppliedAt = nil
        scrollTracking.lastTailAnchorY = .infinity
        scrollTracking.isPinningDuringExpansion = false

        scrollRestoreTask = Task { @MainActor in
            guard !Task.isCancelled else { return }
            // Stage 0: immediate — covers the happy path where layout is already ready.
            log.debug("Scroll restore: stage 0 (immediate)")
            if anchorMessageId == nil {
                proxy.scrollTo("scroll-bottom-anchor", anchor: .bottom)
            }

            // Stage 1: ~3 frames — handles most conversation switches.
            try? await Task.sleep(nanoseconds: 50_000_000)
            guard !Task.isCancelled else { return }
            if anchorMessageId == nil {
                proxy.scrollTo("scroll-bottom-anchor", anchor: .bottom)
            }
            log.debug("Scroll restore: stage 1 (50ms)")

            // Stage 2: ~9 frames — catches slower layout/materialization.
            // scrollLanded is computed after the full wait so it reflects
            // the latest geometry, not a stale snapshot from before the delay.
            try? await Task.sleep(nanoseconds: 150_000_000)
            guard !Task.isCancelled else { return }
            let scrollLanded = hasFreshAnchorMeasurement && anchorTracker.isVisible
            log.debug("Scroll restore: stage 2 check — scrollLanded=\(scrollLanded) hasReceivedScrollEvent=\(hasReceivedScrollEvent)")
            if anchorMessageId == nil && !hasReceivedScrollEvent && !scrollLanded {
                proxy.scrollTo("scroll-bottom-anchor", anchor: .bottom)
                log.debug("Scroll restore: stage 2 (200ms) — retrying scrollTo")
            } else {
                log.debug("Scroll restore: stage 2 skipped")
            }
            if !Task.isCancelled { scrollRestoreTask = nil }
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
    private func thinkingIndicatorRow(displayMessages: [ChatMessage]) -> some View {
        RunningIndicator(
            label: !hasEverSentMessage && displayMessages.contains(where: { $0.role == .user })
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
                    let _ = os_signpost(.event, log: PerfSignposts.log, name: "messageListBodyEvaluated",
                                        "count=%d", messages.count)
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
                        // Invisible sentinel: fires when the user scrolls to the top,
                        // triggering the next-older page of messages to be revealed.
                        Color.clear
                            .frame(height: 1)
                            .id("page-load-trigger")
                            .onAppear {
                                guard !isPaginationInFlight else { return }
                                isPaginationInFlight = true
                                let anchorId = visibleMessages.first?.id
                                log.debug("Pagination triggered — anchorId: \(String(describing: anchorId))")
                                Task {
                                    defer { isPaginationInFlight = false }
                                    let hadMore = await loadPreviousMessagePage?() ?? false
                                    log.debug("loadPreviousMessagePage returned hadMore=\(hadMore)")
                                    if hadMore, let id = anchorId {
                                        // Suppress bottom auto-scroll for the brief layout window so the
                                        // restored anchor position is not immediately overridden.
                                        isSuppressingBottomScroll = true
                                        // Wait ~6 frames for SwiftUI to complete layout before restoring position.
                                        // 100ms gives video embed cards (which animate height over 0.25s) enough
                                        // time to settle so the scroll restoration lands at the right position.
                                        try? await Task.sleep(nanoseconds: 100_000_000)
                                        proxy.scrollTo(id, anchor: .top)
                                        log.debug("Scroll restored to anchor \(id)")
                                        isSuppressingBottomScroll = false
                                    }
                                }
                            }
                    }

                    let state = precomputedState
                    ForEach(Array(zip(state.displayMessages.indices, state.displayMessages)), id: \.1.id) { index, message in
                        MessageCellView(
                            message: message,
                            index: index,
                            displayMessages: state.displayMessages,
                            showTimestamp: state.showTimestamp,
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
                            resolveHttpPort: resolveHttpPort,
                            onConfirmationAllow: onConfirmationAllow,
                            onConfirmationDeny: onConfirmationDeny,
                            onAlwaysAllow: onAlwaysAllow,
                            onTemporaryAllow: onTemporaryAllow,
                            onGuardianAction: onGuardianAction,
                            onSurfaceAction: onSurfaceAction,
                            onDismissDocumentWidget: onDismissDocumentWidget,
                            onReportMessage: onReportMessage,
                            onRehydrateMessage: onRehydrateMessage,
                            onSurfaceRefetch: onSurfaceRefetch,
                            onRetryFailedMessage: onRetryFailedMessage,
                            onRetryConversationError: onRetryConversationError,
                            onAbortSubagent: onAbortSubagent,
                            onSubagentTap: onSubagentTap,
                            onModelPickerSelect: onModelPickerSelect,
                            subagentDetailStore: subagentDetailStore,
                            selectedModel: selectedModel,
                            configuredProviders: configuredProviders
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
                            thinkingIndicatorRow(displayMessages: state.displayMessages)
                        }
                    } else if isCompacting && !state.shouldShowThinkingIndicator && !state.canInlineProcessing {
                        compactingIndicatorRow()
                    }

                    // Inline credits-exhausted recovery banner
                    if let exhaustedError = creditsExhaustedError, exhaustedError.isCreditsExhausted {
                        CreditsExhaustedBanner(
                            onAddFunds: { onAddFunds?() },
                            onDismiss: { onDismissCreditsExhausted?() }
                        )
                        .frame(maxWidth: VSpacing.chatBubbleMaxWidth)
                        .transition(.opacity.combined(with: .move(edge: .bottom)))
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
            .coordinateSpace(name: "chatScrollView")
            .scrollDisabled(messages.isEmpty && !isSending)
            .environment(\.suppressAutoScroll, { [self] in
                expandSuppressionTask?.cancel()
                if isNearBottom {
                    // When pinned to bottom, continuously re-pin on every frame
                    // of the expansion animation via the AnchorMinYKey handler.
                    scrollTracking.isPinningDuringExpansion = true
                    expandSuppressionTask = Task { @MainActor in
                        // Clear after the animation settles (VAnimation.fast ≈ 0.15s + buffer).
                        try? await Task.sleep(nanoseconds: 250_000_000)
                        guard !Task.isCancelled else { return }
                        scrollTracking.isPinningDuringExpansion = false
                        // Refresh avatar position now that layout has settled.
                        updateAvatarFollower(anchorY: scrollTracking.lastTailAnchorY)
                    }
                } else {
                    // When scrolled away from bottom, suppress auto-scroll so the
                    // expansion doesn't yank the viewport to the bottom.
                    isSuppressingBottomScroll = true
                    expandSuppressionTask = Task { @MainActor in
                        try? await Task.sleep(nanoseconds: 200_000_000)
                        guard !Task.isCancelled else { return }
                        // Only clear if no other mechanism (resize, pagination) still needs suppression.
                        let resizeActive = resizeScrollTask != nil && !resizeScrollTask!.isCancelled
                        let paginationActive = isPaginationInFlight
                        if !resizeActive && !paginationActive {
                            isSuppressingBottomScroll = false
                        }
                    }
                }
            })
            .onHover { hovering in
                handleConversationContentHover(hovering)
            }
            .background {
                GeometryReader { geo in
                    Color.clear.preference(key: ScrollViewportHeightKey.self, value: geo.size.height)
                }
                ScrollWheelDetector(
                    onScrollUp: {
                        scrollDebounceTask?.cancel()
                        scrollDebounceTask = nil
                        scrollRestoreTask?.cancel()
                        scrollRestoreTask = nil
                        isNearBottom = false
                        hasReceivedScrollEvent = true
                    },
                    onScrollToBottom: {
                        scrollRestoreTask?.cancel()
                        scrollRestoreTask = nil
                        isNearBottom = true
                        hasReceivedScrollEvent = true
                    }
                )
                ConversationScrollbarVisibilityController(shouldShow: shouldShowConversationScrollbar)
            }
            .onPreferenceChange(ScrollViewportHeightKey.self) { height in
                os_signpost(.begin, log: PerfSignposts.log, name: "anchorPreferenceChange")
                anchorTracker.updateViewport(height: height, storedViewportHeight: &scrollViewportHeight)
                os_signpost(.end, log: PerfSignposts.log, name: "anchorPreferenceChange")
            }
            .transaction { $0.disablesAnimations = true }
            .onPreferenceChange(AnchorMinYKey.self) { minY in
                // 2pt dead-zone: skip update when value hasn't meaningfully changed,
                // reducing layout invalidation cascades during rapid scroll.
                guard abs(minY - anchorTracker.lastMinY) > 2 else { return }
                os_signpost(.begin, log: PerfSignposts.log, name: "anchorPreferenceChange")
                anchorTracker.update(minY: minY, viewportHeight: scrollViewportHeight)
                if !hasFreshAnchorMeasurement { hasFreshAnchorMeasurement = true }
                // During content expansion while bottom-pinned, re-anchor to bottom
                // on every frame so the viewport follows the growing content.
                if scrollTracking.isPinningDuringExpansion {
                    proxy.scrollTo("scroll-bottom-anchor", anchor: .bottom)
                }
                os_signpost(.end, log: PerfSignposts.log, name: "anchorPreferenceChange")
            }
            .transaction { $0.disablesAnimations = true }
            .onPreferenceChange(ConversationTailAnchorYKey.self) { anchorY in
                // 2pt dead-zone: skip update when value hasn't meaningfully changed,
                // reducing layout invalidation cascades during rapid scroll.
                guard abs(anchorY - scrollTracking.lastTailAnchorY) > 2 else { return }
                scrollTracking.lastTailAnchorY = anchorY
                // Skip avatar updates during expansion pinning — the rapid scrollTo
                // calls cause the tail anchor to momentarily leave the viewport,
                // which would hide the avatar for a frame. Position is refreshed
                // when the pinning flag clears.
                guard !scrollTracking.isPinningDuringExpansion else { return }
                updateAvatarFollower(anchorY: anchorY)
            }
            .transaction { $0.disablesAnimations = true }
            .overlay(alignment: .topLeading) {
                conversationTailAvatar
            }
            .overlay(alignment: .bottom) {
                if (!isNearBottom || !hasReceivedScrollEvent) && !anchorTracker.isVisible {
                    Button(action: {
                        hasReceivedScrollEvent = true
                        isNearBottom = true
                        withAnimation(VAnimation.fast) {
                            proxy.scrollTo("scroll-bottom-anchor", anchor: .bottom)
                        }
                    }) {
                        HStack(spacing: VSpacing.xs) {
                            VIconView(.arrowDown, size: 10)
                            Text("Scroll to latest")
                                .font(VFont.monoSmall)
                        }
                        .padding(.horizontal, VSpacing.md)
                        .padding(.vertical, VSpacing.sm)
                        .background(.ultraThinMaterial)
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
                if let id = anchorMessageId, messages.contains(where: { $0.id == id }) {
                    // Anchor is already set and the target message is loaded —
                    // scroll to it immediately instead of falling through to bottom.
                    proxy.scrollTo(id, anchor: .center)
                    flashHighlight(messageId: id)
                    anchorMessageId = nil
                    anchorSetTime = nil
                } else if anchorMessageId != nil {
                    // Anchor is set but the target message isn't loaded yet.
                    // Record the timestamp so the elapsed-time guard starts
                    // counting from view appearance (onChange may not fire for
                    // the initial value).
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
                            log.debug("Anchor message not found (timed out) — clearing stale anchor")
                            anchorMessageId = nil
                            anchorSetTime = nil
                            anchorTimeoutTask = nil
                            isNearBottom = true
                            withAnimation(VAnimation.fast) {
                                proxy.scrollTo("scroll-bottom-anchor", anchor: .bottom)
                            }
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
                hoverExitDebounceTask?.cancel()
                hoverExitDebounceTask = nil
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
                avatarSmoothingTask?.cancel()
                avatarSmoothingTask = nil
                highlightDismissTask?.cancel()
                highlightDismissTask = nil
            }
            .onChange(of: isSending) {
                if isSending {
                    hasReceivedScrollEvent = true
                    isNearBottom = true
                    withAnimation(VAnimation.standard) {
                        proxy.scrollTo("scroll-bottom-anchor", anchor: .bottom)
                    }
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
                    updateAvatarFollower(anchorY: scrollTracking.pendingAvatarY ?? avatarTargetY)
                }
            }
            .onChange(of: streamingScrollTrigger) {
                if isNearBottom && !isSuppressingBottomScroll {
                    // Throttle pattern: fire immediately then suppress for 200ms.
                    // Unlike debounce (cancel+recreate), this guarantees scrolls
                    // execute during active streaming, not only after the last token.
                    if scrollDebounceTask == nil {
                        scrollDebounceTask = Task {
                            defer { if !Task.isCancelled { scrollDebounceTask = nil } }
                            guard isNearBottom && !isSuppressingBottomScroll else { return }
                            if isLastMessageStreaming {
                                proxy.scrollTo("scroll-bottom-anchor", anchor: .bottom)
                            } else {
                                withAnimation(VAnimation.fast) {
                                    proxy.scrollTo("scroll-bottom-anchor", anchor: .bottom)
                                }
                            }
                            try? await Task.sleep(nanoseconds: 200_000_000)
                            // If the task was cancelled during the sleep (user scrolled up), do not fire trailing-edge scroll.
                            guard !Task.isCancelled else { return }
                            if isNearBottom && !isSuppressingBottomScroll {
                                if isLastMessageStreaming {
                                    proxy.scrollTo("scroll-bottom-anchor", anchor: .bottom)
                                } else {
                                    withAnimation(VAnimation.fast) {
                                        proxy.scrollTo("scroll-bottom-anchor", anchor: .bottom)
                                    }
                                }
                            }
                        }
                    }
                }
            }
            .onChange(of: messages.count) {
                // Anchor scroll takes priority: when a notification deep-link
                // set anchorMessageId, retry scrolling to it as messages load
                // (e.g., history arrives after a conversation switch). This must run
                // before the bottom-scroll branch to avoid competing scrollTo calls.
                if let id = anchorMessageId, messages.contains(where: { $0.id == id }) {
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
                        log.debug("Anchor message not found (pagination exhausted) — clearing stale anchor")
                        anchorMessageId = nil
                        anchorSetTime = nil
                        anchorTimeoutTask?.cancel()
                        anchorTimeoutTask = nil
                        isNearBottom = true
                        withAnimation(VAnimation.fast) {
                            proxy.scrollTo("scroll-bottom-anchor", anchor: .bottom)
                        }
                        return
                    }
                }
                if isNearBottom && !isSuppressingBottomScroll && anchorMessageId == nil {
                    withAnimation(VAnimation.fast) {
                        proxy.scrollTo("scroll-bottom-anchor", anchor: .bottom)
                    }
                } else if isSuppressingBottomScroll {
                    log.debug("Auto-scroll suppressed (bottom-scroll suppression active)")
                }
            }
            .onChange(of: conversationZoomScale) {
                if isNearBottom {
                    proxy.scrollTo("scroll-bottom-anchor", anchor: .bottom)
                }
                // When mid-scroll, do nothing — let SwiftUI handle the text reflow naturally.
            }
            .onChange(of: containerWidth) {
                // Ignore sub-pixel jitter and initial zero value
                guard containerWidth > 0, abs(containerWidth - lastHandledContainerWidth) > 20 else { return }
                lastHandledContainerWidth = containerWidth

                // Cancel competing scroll tasks to prevent jitter during resize
                scrollDebounceTask?.cancel()
                scrollDebounceTask = nil
                resizeScrollTask?.cancel()

                resizeScrollTask = Task { @MainActor in
                    // Temporarily suppress bottom auto-scroll so streaming/message-count
                    // handlers don't fight with the resize stabilization.
                    isSuppressingBottomScroll = true
                    defer {
                        if !Task.isCancelled {
                            isSuppressingBottomScroll = false
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
                        proxy.scrollTo("scroll-bottom-anchor", anchor: .bottom)
                    }
                    // If not near bottom or anchor is set, preserve viewport.
                }
            }
            .onChange(of: conversationId) {
                // Keep the underlying NSScrollView instance stable across conversation
                // switches (prevents default-scroller flash), and reset view-local
                // scroll state explicitly instead of remounting the whole view.
                scrollDebounceTask?.cancel()
                scrollDebounceTask = nil
                resizeScrollTask?.cancel()
                resizeScrollTask = nil
                expandSuppressionTask?.cancel()
                expandSuppressionTask = nil
                avatarSmoothingTask?.cancel()
                avatarSmoothingTask = nil
                isPaginationInFlight = false
                isSuppressingBottomScroll = false
                isNearBottom = true
                highlightedMessageId = nil
                highlightDismissTask?.cancel()
                highlightDismissTask = nil
                anchorTracker.isVisible = true
                anchorTracker.lastMinY = 0
                hasReceivedScrollEvent = false
                lastHandledContainerWidth = containerWidth
                hoverExitDebounceTask?.cancel()
                hoverExitDebounceTask = nil
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
                isConversationContentHovered = false
                hasPlayedTailEntryAnimation = false
                // Avatar state (avatarTargetY, avatarDisplayY, scrollTracking)
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
                }
                // Record the timestamp when a new anchor is set so the
                // pagination-exhaustion guard can measure elapsed time.
                anchorSetTime = anchorMessageId != nil ? Date() : nil
                // Cancel any previous timeout task.
                anchorTimeoutTask?.cancel()
                anchorTimeoutTask = nil
                guard let id = anchorMessageId else { return }
                // Only scroll and clear if the target message is already loaded;
                // otherwise leave the anchor set so the messages-change handler
                // can retry once history finishes loading.
                if messages.contains(where: { $0.id == id }) {
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
                        log.debug("Anchor message not found (timed out) — clearing stale anchor")
                        anchorMessageId = nil
                        anchorSetTime = nil
                        anchorTimeoutTask = nil
                        isNearBottom = true
                        withAnimation(VAnimation.fast) {
                            proxy.scrollTo("scroll-bottom-anchor", anchor: .bottom)
                        }
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
                hoverExitDebounceTask?.cancel()
                hoverExitDebounceTask = nil
                conversationSwitchSuppressionTask?.cancel()
                conversationSwitchSuppressionTask = nil
                suppressScrollbarDuringConversationSwitch = false
                isConversationContentHovered = false
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
    }

    let message: ChatMessage
    let index: Int
    let displayMessages: [ChatMessage]
    let showTimestamp: Set<Int>
    let activePendingRequestId: String?
    let latestAssistantId: UUID?
    let anchoredThinkingIndex: Int?
    let subagentsByParent: [UUID: [SubagentInfo]]
    let canInlineProcessing: Bool
    let shouldShowThinkingIndicator: Bool
    let assistantStatusText: String?
    let dismissedDocumentSurfaceIds: Set<String>
    let activeSurfaceId: String?
    /// When true, the cell renders a brief highlight flash.
    let isHighlighted: Bool
    let mediaEmbedSettings: MediaEmbedResolverSettings?
    let resolveHttpPort: () -> Int?
    let onConfirmationAllow: (String) -> Void
    let onConfirmationDeny: (String) -> Void
    let onAlwaysAllow: (String, String, String, String) -> Void
    var onTemporaryAllow: ((String, String) -> Void)?
    var onGuardianAction: ((String, String) -> Void)?
    let onSurfaceAction: (String, String, [String: AnyCodable]?) -> Void
    let onDismissDocumentWidget: ((String) -> Void)?
    let onReportMessage: ((String?) -> Void)?
    var onRehydrateMessage: ((UUID) -> Void)?
    /// Called when a stripped surface scrolls into view and needs its data re-fetched.
    var onSurfaceRefetch: ((String, String) -> Void)?
    /// Called when the user taps "Retry" on a per-message send failure.
    var onRetryFailedMessage: ((UUID) -> Void)?
    /// Called when the user taps "Retry" on an inline conversation error.
    var onRetryConversationError: (() -> Void)?
    var onAbortSubagent: ((String) -> Void)?
    var onSubagentTap: ((String) -> Void)?
    var onModelPickerSelect: ((UUID, String) -> Void)?
    var subagentDetailStore: SubagentDetailStore
    let selectedModel: String
    let configuredProviders: Set<String>

    @AppStorage("hasEverSentMessage") private var hasEverSentMessage: Bool = false

    private func modelPickerView(for msg: ChatMessage) -> some View {
        ModelPickerBubble(
            models: SettingsStore.availableModels.map { id in
                (id: id, name: SettingsStore.modelDisplayNames[id] ?? id)
            },
            selectedModelId: selectedModel,
            onSelect: { modelId in
                onModelPickerSelect?(msg.id, modelId)
            }
        )
    }

    private func modelListView(for msg: ChatMessage) -> some View {
        ModelListBubble(currentModel: selectedModel, configuredProviders: configuredProviders)
    }

    @ViewBuilder
    private func thinkingIndicatorRow() -> some View {
        RunningIndicator(
            label: !hasEverSentMessage && displayMessages.contains(where: { $0.role == .user })
                ? "Waking up..."
                : assistantStatusText ?? "Thinking",
            showIcon: false
        )
        .frame(maxWidth: VSpacing.chatBubbleMaxWidth, alignment: .leading)
        .id("thinking-indicator")
    }

    /// Returns true when the given pending confirmation is already rendered inline
    /// under a preceding assistant message's tool step (via AssistantProgressView),
    /// so the standalone ToolConfirmationBubble row should be suppressed.
    ///
    /// Falls back to `false` when `pendingConfirmation` is not populated on any
    /// tool call (e.g. history restore, missing `toolUseId`), which correctly
    /// causes the standalone bubble to render as a fallback.
    private func isConfirmationRenderedInline(
        confirmation: ToolConfirmationData,
        messages: [ChatMessage],
        at index: Int
    ) -> Bool {
        guard let confirmationToolUseId = confirmation.toolUseId, !confirmationToolUseId.isEmpty else {
            return false
        }
        for i in (0..<index).reversed() {
            let msg = messages[i]
            guard msg.role == .assistant, msg.confirmation == nil else { continue }
            return msg.toolCalls.contains { tc in
                tc.toolUseId == confirmationToolUseId && tc.pendingConfirmation != nil
            }
        }
        return false
    }

    var body: some View {
        if showTimestamp.contains(index) {
            TimestampDivider(date: message.timestamp)
        }

        if let confirmation = message.confirmation {
            if confirmation.state == .pending {
                // Check if this confirmation is already rendered inline under the
                // preceding assistant message's tool step (via AssistantProgressView).
                // If so, skip the standalone bubble to avoid duplication.
                let isRenderedInline = isConfirmationRenderedInline(
                    confirmation: confirmation,
                    messages: displayMessages,
                    at: index
                )

                if !isRenderedInline {
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
                let hasPrecedingAssistant: Bool = {
                    guard index > 0 else { return false }
                    return displayMessages[index - 1].role == .assistant
                }()

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
        } else if message.modelPicker != nil {
            modelPickerView(for: message)
                .id(message.id)
        } else if message.modelList != nil {
            modelListView(for: message)
                .id(message.id)
        } else if message.commandList != nil {
            CommandListBubble()
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
            let nextDecidedConfirmation: ToolConfirmationData? = {
                guard index + 1 < displayMessages.count,
                      let conf = displayMessages[index + 1].confirmation,
                      conf.state != .pending else { return nil }
                return conf
            }()


            ChatBubble(
                message: message,
                decidedConfirmation: nextDecidedConfirmation,
                onSurfaceAction: onSurfaceAction,
                onDismissDocumentWidget: { surfaceId in
                    onDismissDocumentWidget?(surfaceId)
                },
                dismissedDocumentSurfaceIds: dismissedDocumentSurfaceIds,
                onReportMessage: onReportMessage,
                onSurfaceRefetch: onSurfaceRefetch,
                onRehydrate: (message.wasTruncated || message.isContentStripped) ? { onRehydrateMessage?(message.id) } : nil,
                mediaEmbedSettings: mediaEmbedSettings,
                resolveHttpPort: resolveHttpPort,
                onConfirmationAllow: onConfirmationAllow,
                onConfirmationDeny: onConfirmationDeny,
                onAlwaysAllow: onAlwaysAllow,
                onTemporaryAllow: onTemporaryAllow,
                activeConfirmationRequestId: activePendingRequestId,
                onRetryFailedMessage: onRetryFailedMessage,
                onRetryConversationError: message.isError && index == displayMessages.count - 1 ? onRetryConversationError : nil,
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

private struct ConversationScrollbarVisibilityController: NSViewRepresentable, Equatable {
    let shouldShow: Bool

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async {
            context.coordinator.update(from: view, shouldShow: shouldShow)
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        DispatchQueue.main.async {
            context.coordinator.update(from: nsView, shouldShow: shouldShow)
        }
    }

    final class Coordinator {
        weak var lastResolvedScrollView: NSScrollView?
        private var lastShouldShow: Bool?

        func update(from markerView: NSView, shouldShow: Bool) {
            guard let scrollView = findEnclosingScrollView(from: markerView) ?? lastResolvedScrollView else { return }
            // Skip redundant reconfiguration
            if scrollView === lastResolvedScrollView && lastShouldShow == shouldShow { return }
            lastResolvedScrollView = scrollView
            lastShouldShow = shouldShow
            // Keep the scroller instantiated and styled consistently; only toggle
            // visibility. Toggling `hasVerticalScroller` can recreate scroller
            // internals, which causes visible flicker and brief legacy-style flashes.
            scrollView.hasVerticalScroller = true
            scrollView.hasHorizontalScroller = false
            scrollView.autohidesScrollers = false
            scrollView.scrollerStyle = .overlay
            scrollView.scrollerInsets = NSEdgeInsets(top: 0, left: 0, bottom: 0, right: 0)
            scrollView.automaticallyAdjustsContentInsets = false
            scrollView.verticalScroller?.controlSize = .small
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

// MARK: - Precomputed Message List State

/// Holds derived values computed once per body evaluation so they are not
/// redundantly recalculated inside the LazyVStack ForEach body.
/// Note: `LazyVStack` already gates child view evaluation, so each cell is
/// only built when it scrolls into the prefetch window. The primary gain here
/// is avoiding repeated O(n) scans (timestamp indices, subagent grouping,
/// current-turn detection) on every layout pass.
struct PrecomputedMessageListState {
    let displayMessages: [ChatMessage]
    let activePendingRequestId: String?
    let latestAssistantId: UUID?
    let anchoredThinkingIndex: Int?
    let subagentsByParent: [UUID: [SubagentInfo]]
    let orphanSubagents: [SubagentInfo]
    let showTimestamp: Set<Int>
    let lastVisible: ChatMessage?
    let currentTurnMessages: ArraySlice<ChatMessage>
    let hasActiveToolCall: Bool
    let wouldShowThinking: Bool
    let lastVisibleIsAssistant: Bool
    let canInlineProcessing: Bool
    let shouldShowThinkingIndicator: Bool
    let effectiveStatusText: String?
}
