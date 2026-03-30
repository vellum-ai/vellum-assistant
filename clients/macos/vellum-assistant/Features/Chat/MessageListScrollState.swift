import Foundation
import os
import SwiftUI
import VellumAssistantShared

// MARK: - MessageListScrollState

/// Replaces `MessageListScrollCoordinator` (ObservableObject) with an
/// `@Observable` class that only triggers SwiftUI view re-evaluations for
/// 4 properties that legitimately drive UI changes. All scroll-frequency
/// state is `@ObservationIgnored` to prevent the cascading re-render
/// feedback loops that caused the old coordinator to freeze the app.
@Observable @MainActor
final class MessageListScrollState {

    // MARK: - Observed Properties (trigger view updates)

    /// Whether the viewport is logically following the bottom of the transcript.
    /// When false (detached), background pin requests are suppressed.
    var isFollowingBottom = true

    /// The message ID whose top edge should be pinned to the viewport top
    /// after the user sends a message (push-to-top pattern). `nil` when
    /// push-to-top is inactive.
    var pushToTopMessageId: (any Hashable)? = nil

    /// Guards the pagination sentinel against re-entry during the brief window
    /// between Task launch and the first `await`.
    var isPaginationInFlight = false

    /// Whether scroll indicators should be temporarily hidden during a
    /// conversation switch. LazyVStack content size estimation causes the
    /// scrollbar to visibly resize as views materialize with varying heights;
    /// hiding the indicators during the initial layout window masks this.
    var hideScrollIndicators = false

    // MARK: - Computed Properties

    /// Whether the "Scroll to latest" CTA should be visible. Replaces the
    /// `isNearBottom` binding chain from the old coordinator.
    var showScrollToLatest: Bool { !isFollowingBottom }

    /// Height of the tail spacer when it is visible during push-to-top.
    /// Subtracted from content height for overflow and bottom detection
    /// so those computations operate on effective content height.
    var tailSpacerHeight: CGFloat {
        guard pushToTopMessageId != nil else { return 0 }
        let h = viewportHeight
        // Account for LazyVStack inter-item spacing so the spacer
        // doesn't overshoot by one spacing unit.
        return h.isFinite ? max(0, h - VSpacing.md) : 0
    }

    // MARK: - ObservationIgnored Properties (never trigger re-evaluation)

    /// Current scroll phase from `onScrollPhaseChange`. Only read inside
    /// the `onScrollGeometryChange` action closure to decide whether a
    /// scroll-up should trigger detach.
    @ObservationIgnored var scrollPhase: ScrollPhase = .idle

    /// Last content offset Y observed by onScrollGeometryChange, used to
    /// determine scroll direction (increasing offset = scrolling toward older content).
    @ObservationIgnored var lastContentOffsetY: CGFloat = 0

    /// Whether the user is within the bottom dead-zone of the conversation.
    /// Computed from scroll geometry in the `onScrollGeometryChange` handler.
    @ObservationIgnored var isAtBottom: Bool = true

    /// Whether a physical scroll event (wheel/trackpad) has been received since
    /// the current conversation loaded.
    @ObservationIgnored var hasReceivedScrollEvent: Bool = false

    /// The most recent scroll viewport height. Stored so closures read the
    /// live value instead of a stale capture.
    @ObservationIgnored var viewportHeight: CGFloat = .infinity

    /// Whether any scroll suppression reason is currently active. Single
    /// unified flag computed from `suppressionReasons`.
    @ObservationIgnored var isSuppressed: Bool = false

    /// Tracks whether the pagination sentinel was previously inside the trigger band.
    @ObservationIgnored var wasPaginationTriggerInRange: Bool = false

    /// The conversation ID currently being displayed. Updated in `reset(for:)`
    /// so closures always read the live value.
    @ObservationIgnored var currentConversationId: UUID?

    /// Captures the `assistantActivityPhase` at the moment `isSending` goes false.
    /// Used to distinguish mid-turn tool-confirmation pauses from genuine turn endings.
    @ObservationIgnored var phaseWhenSendingStopped: String = ""

    /// Last container width that triggered a resize scroll handler, used to
    /// detect meaningful width changes (>2pt) and avoid sub-pixel jitter.
    @ObservationIgnored var lastHandledContainerWidth: CGFloat = 0

    /// Tracks the last pending confirmation request ID that triggered an
    /// auto-focus handoff. Used to detect nil->non-nil transitions.
    @ObservationIgnored var lastAutoFocusedRequestId: String?

    // MARK: - Layout Cache Fields

    /// Cache key for the last computed `CachedMessageLayoutMetadata`.
    @ObservationIgnored var cachedLayoutKey: PrecomputedCacheKey?

    /// Cached structural metadata, returned on cache hit.
    @ObservationIgnored var cachedLayoutMetadata: CachedMessageLayoutMetadata?

    /// Monotonically increasing counter that replaces O(n) per-body-eval hash.
    @ObservationIgnored var messageListVersion: Int = 0

    /// Cached raw (unfiltered) message count.
    @ObservationIgnored var lastKnownRawMessageCount: Int = 0

    /// Cached visible (paginated) message count.
    @ObservationIgnored var lastKnownVisibleMessageCount: Int = 0

    /// Cached streaming state of the last visible message.
    @ObservationIgnored var lastKnownLastMessageStreaming: Bool = false

    /// Cached count of incomplete tool calls across visible messages.
    @ObservationIgnored var lastKnownIncompleteToolCallCount: Int = 0

    /// Lightweight identity fingerprint of visible message IDs.
    @ObservationIgnored var lastKnownVisibleIdFingerprint: Int = 0

    /// Cached ID of the first visible message, updated during body evaluation.
    @ObservationIgnored var cachedFirstVisibleMessageId: UUID?

    /// Content height from scroll geometry.
    @ObservationIgnored var scrollContentHeight: CGFloat = 0

    /// Container (viewport) height from scroll geometry.
    @ObservationIgnored var scrollContainerHeight: CGFloat = 0

    // MARK: - Suppression

    /// Structured reasons for scroll suppression, replacing individual booleans.
    struct SuppressionReasons: OptionSet {
        let rawValue: Int
        static let resize    = SuppressionReasons(rawValue: 1 << 0)
        static let pagination = SuppressionReasons(rawValue: 1 << 1)
        static let expansion = SuppressionReasons(rawValue: 1 << 2)
    }

    /// Currently active suppression reasons.
    @ObservationIgnored private var suppressionReasons: SuppressionReasons = []

    /// Timeout task for expansion suppression — the only suppression reason
    /// that uses an auto-timeout (200ms). Resize and pagination manage their
    /// lifecycle manually within their respective task bodies.
    @ObservationIgnored private var expansionTimeoutTask: Task<Void, Never>?

    /// Begins suppression for the given reason(s). Starts a 200ms auto-timeout
    /// for `.expansion`; resize and pagination are managed manually.
    func beginSuppression(_ reason: SuppressionReasons) {
        suppressionReasons.insert(reason)
        isSuppressed = !suppressionReasons.isEmpty
        if reason.contains(.expansion) {
            expansionTimeoutTask?.cancel()
            expansionTimeoutTask = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 200_000_000)
                guard !Task.isCancelled, let self else { return }
                self.endSuppression(.expansion)
            }
        }
    }

    /// Ends suppression for the given reason(s). Cancels expansion timeout
    /// if `.expansion` is being cleared.
    func endSuppression(_ reason: SuppressionReasons) {
        if reason.contains(.expansion) {
            expansionTimeoutTask?.cancel()
            expansionTimeoutTask = nil
        }
        suppressionReasons.remove(reason)
        isSuppressed = !suppressionReasons.isEmpty
    }

    /// Clears all suppression flags and cancels the expansion timeout task.
    func clearSuppression() {
        suppressionReasons = []
        isSuppressed = false
        expansionTimeoutTask?.cancel()
        expansionTimeoutTask = nil
    }

    // MARK: - Scroll Action Closures

    /// Closure that performs a programmatic scroll to the given item ID and
    /// anchor point. Set once during view configuration and captures the
    /// view-owned `ScrollPosition` binding.
    @ObservationIgnored var scrollTo: ((_ id: any Hashable, _ anchor: UnitPoint?) -> Void)?

    /// Closure that scrolls to a given edge (e.g. `.bottom`). Used for
    /// conversation switches where we need to position at the bottom
    /// without relying on `.defaultScrollAnchor`.
    @ObservationIgnored var scrollToEdge: ((_ edge: Edge) -> Void)?

    // MARK: - Task References

    /// In-flight pagination load task.
    @ObservationIgnored var paginationTask: Task<Void, Never>?

    /// In-flight staged scroll-to-bottom task used after conversation switches
    /// and app restarts.
    @ObservationIgnored var scrollRestoreTask: Task<Void, Never>?

    /// Task that clears the highlight flash after the animation duration.
    @ObservationIgnored var highlightDismissTask: Task<Void, Never>?

    /// Task that restores scroll indicator visibility after the grace period.
    @ObservationIgnored var scrollIndicatorRestoreTask: Task<Void, Never>?

    /// Independent timer task that clears a stale anchor after 10 seconds,
    /// regardless of whether messages.count changes.
    @ObservationIgnored var anchorTimeoutTask: Task<Void, Never>?

    // MARK: - Deep-Link Anchor Tracking

    /// Timestamp when anchorMessageId was set. Used together with pagination
    /// exhaustion to decide when a stale anchor should be cleared.
    @ObservationIgnored var anchorSetTime: Date?

    // MARK: - Core Methods

    /// Requests a scroll-to-bottom pin. Returns `true` if the pin was performed.
    /// Pass `userInitiated: true` for explicit user actions (e.g. "Scroll to latest"
    /// button) to bypass both follow-state and suppression checks.
    @discardableResult
    func pinToBottom(animated: Bool = false, userInitiated: Bool = false) -> Bool {
        // User-initiated scrolls bypass both the follow-state and suppression
        // checks entirely — user intent always wins over defensive guards.
        if userInitiated {
            if animated {
                withAnimation(VAnimation.fast) {
                    performScrollTo("scroll-bottom-anchor", anchor: .bottom)
                }
            } else {
                performScrollTo("scroll-bottom-anchor", anchor: .bottom)
            }
            return true
        }

        // Non-user-initiated requests are gated on follow-state and suppression.
        guard isFollowingBottom else { return false }
        guard !isSuppressed else { return false }

        if animated {
            withAnimation(VAnimation.fast) {
                performScrollTo("scroll-bottom-anchor", anchor: .bottom)
            }
        } else {
            performScrollTo("scroll-bottom-anchor", anchor: .bottom)
        }
        return true
    }

    /// Transitions to the detached state, suppressing all background pin requests.
    func detach() {
        guard isFollowingBottom else { return }
        isFollowingBottom = false
    }

    /// Transitions to the following state, allowing pin requests to proceed.
    func reattach() {
        guard !isFollowingBottom else { return }
        isFollowingBottom = true
    }

    /// Performs a programmatic scroll to the given item ID and anchor point,
    /// using the `scrollTo` closure configured during setup.
    func performScrollTo(_ id: any Hashable, anchor: UnitPoint? = nil) {
        scrollTo?(id, anchor)
    }

    // MARK: - Lifecycle Methods

    /// Resets state for a conversation switch. Cancels in-flight tasks, clears
    /// suppression, invalidates layout cache, and prepares for the new conversation.
    func reset(for newConversationId: UUID?) {
        clearSuppression()
        paginationTask?.cancel()
        paginationTask = nil
        if isPaginationInFlight { isPaginationInFlight = false }
        wasPaginationTriggerInRange = false
        // Invalidate the layout cache so the new conversation doesn't
        // hit a stale cache from the previous conversation.
        cachedLayoutKey = nil
        cachedLayoutMetadata = nil
        messageListVersion = 0
        lastKnownRawMessageCount = 0
        lastKnownVisibleMessageCount = 0
        lastKnownLastMessageStreaming = false
        lastKnownIncompleteToolCallCount = 0
        lastKnownVisibleIdFingerprint = 0
        // Update the live conversation ID so closures read the new value.
        currentConversationId = newConversationId
        // Reset follow state for the new conversation.
        if !isFollowingBottom { isFollowingBottom = true }
        if pushToTopMessageId != nil { pushToTopMessageId = nil }
        isAtBottom = true
        hasReceivedScrollEvent = false
        lastContentOffsetY = 0
        // Hide scroll indicators during the conversation switch grace period
        // to mask LazyVStack content size estimation changes.
        scrollIndicatorRestoreTask?.cancel()
        if !hideScrollIndicators { hideScrollIndicators = true }
        scrollIndicatorRestoreTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 300_000_000) // 300ms
            guard !Task.isCancelled, let self else { return }
            if self.hideScrollIndicators { self.hideScrollIndicators = false }
            self.scrollIndicatorRestoreTask = nil
        }
    }

    /// Cancel all tasks and clear suppression. Called from `onDisappear`.
    func cancelAll() {
        clearSuppression()
        scrollRestoreTask?.cancel()
        scrollRestoreTask = nil
        paginationTask?.cancel()
        paginationTask = nil
        anchorTimeoutTask?.cancel()
        anchorTimeoutTask = nil
        highlightDismissTask?.cancel()
        highlightDismissTask = nil
        scrollIndicatorRestoreTask?.cancel()
        scrollIndicatorRestoreTask = nil
        if hideScrollIndicators { hideScrollIndicators = false }
        if isPaginationInFlight { isPaginationInFlight = false }
    }
}
