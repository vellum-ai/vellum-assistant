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

    @ObservationIgnored private var _isFollowingBottom = true

    /// Logical follow state — scroll handlers and callbacks read this.
    /// Does NOT trigger view re-evaluation (reads @ObservationIgnored backing store).
    var isFollowingBottom: Bool { _isFollowingBottom }

    /// The message ID whose top edge should be pinned to the viewport top
    /// after the user sends a message (push-to-top pattern). `nil` when
    /// push-to-top is inactive.
    @ObservationIgnored private var _pushToTopMessageId: (any Hashable)? = nil

    var pushToTopMessageId: (any Hashable)? {
        get { _pushToTopMessageId }
        set { _pushToTopMessageId = newValue; scheduleUISync() }
    }

    /// Guards the pagination sentinel against re-entry during the brief window
    /// between Task launch and the first `await`.
    @ObservationIgnored private var _isPaginationInFlight = false

    var isPaginationInFlight: Bool {
        get { _isPaginationInFlight }
        set { _isPaginationInFlight = newValue }
    }

    /// Whether scroll indicators should be temporarily hidden during a
    /// conversation switch. LazyVStack content size estimation causes the
    /// scrollbar to visibly resize as views materialize with varying heights;
    /// hiding the indicators during the initial layout window masks this.
    @ObservationIgnored private var _hideScrollIndicators = false

    var hideScrollIndicators: Bool {
        get { _hideScrollIndicators }
        set { _hideScrollIndicators = newValue; scheduleUISync() }
    }

    /// Whether the "Scroll to latest" CTA should be visible.
    /// Updated via debounced `scheduleUISync()` — at most once per frame.
    @ObservationIgnored private(set) var showScrollToLatest = false

    /// Single observed property — the ONLY thing that triggers SwiftUI view
    /// re-evaluation from scroll state. Bumped at most once per 16ms frame.
    private(set) var uiVersion: UInt64 = 0

    /// Snapshot: whether the tail spacer should render.
    @ObservationIgnored private(set) var showTailSpacer = false

    /// Snapshot: whether scroll indicators should be hidden.
    @ObservationIgnored private(set) var scrollIndicatorsHidden = false

    // MARK: - Computed Properties

    /// Height of the tail spacer when it is visible during push-to-top.
    /// Subtracted from content height for overflow and bottom detection
    /// so those computations operate on effective content height.
    var tailSpacerHeight: CGFloat {
        guard _pushToTopMessageId != nil else { return 0 }
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

    // MARK: - Circuit Breaker

    /// Rolling window of body evaluation timestamps for loop detection.
    @ObservationIgnored private var bodyEvalTimestamps: [CFAbsoluteTime] = []
    /// When true, scheduleUISync() is suppressed to break a runaway re-evaluation loop.
    @ObservationIgnored private(set) var isThrottled = false
    @ObservationIgnored private var throttleRecoveryTask: Task<Void, Never>?

    /// Called once per MessageListView body evaluation. Trips the circuit
    /// breaker when >100 evaluations occur in 2 seconds, suppressing
    /// `scheduleUISync()` for 500ms to break the loop.
    func recordBodyEvaluation() {
        let now = CFAbsoluteTimeGetCurrent()
        bodyEvalTimestamps.append(now)
        // Trim entries older than 2 seconds.
        let cutoff = now - 2.0
        if let firstValid = bodyEvalTimestamps.firstIndex(where: { $0 >= cutoff }) {
            bodyEvalTimestamps.removeFirst(firstValid)
        }

        if bodyEvalTimestamps.count > 100 && !isThrottled {
            isThrottled = true
            os_log(.fault, "Scroll re-evaluation loop detected: %d evals in 2s — throttling for 500ms",
                   bodyEvalTimestamps.count)
            throttleRecoveryTask?.cancel()
            throttleRecoveryTask = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 500_000_000)
                guard let self, !Task.isCancelled else { return }
                self.isThrottled = false
                self.bodyEvalTimestamps.removeAll()
                self.throttleRecoveryTask = nil
                self.scheduleUISync()
            }
        }
    }

    // MARK: - Debounced UI Sync

    @ObservationIgnored private var uiSyncTask: Task<Void, Never>?

    /// Debounces observed-property updates so rapid oscillation of _isFollowingBottom
    /// (e.g. during rapid scrolling near bottom) coalesces into at most one
    /// view re-evaluation per frame instead of one per scroll event.
    private func scheduleUISync() {
        guard !isThrottled else { return }
        uiSyncTask?.cancel()
        uiSyncTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 16_000_000) // ~1 frame at 60Hz
            guard let self, !Task.isCancelled else { return }
            self.syncUISnapshots()
            self.uiSyncTask = nil
        }
    }

    /// Computes all snapshot values from internal state and bumps uiVersion
    /// only if something actually changed.
    private func syncUISnapshots() {
        let newShowScrollToLatest = !_isFollowingBottom
        let newShowTailSpacer = _pushToTopMessageId != nil
        let newScrollIndicatorsHidden = _hideScrollIndicators

        var changed = false
        if showScrollToLatest != newShowScrollToLatest {
            showScrollToLatest = newShowScrollToLatest; changed = true
        }
        if showTailSpacer != newShowTailSpacer {
            showTailSpacer = newShowTailSpacer; changed = true
        }
        if scrollIndicatorsHidden != newScrollIndicatorsHidden {
            scrollIndicatorsHidden = newScrollIndicatorsHidden; changed = true
        }
        if changed { uiVersion &+= 1 }
    }

    /// Synchronous UI sync — bypasses debounce for instant state transitions
    /// like conversation switches.
    func syncUIImmediately() {
        uiSyncTask?.cancel()
        uiSyncTask = nil
        syncUISnapshots()
    }

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
        guard _isFollowingBottom else { return false }
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
        guard _isFollowingBottom else { return }
        _isFollowingBottom = false
        scheduleUISync()
    }

    /// Transitions to the following state, allowing pin requests to proceed.
    func reattach() {
        guard !_isFollowingBottom else { return }
        _isFollowingBottom = true
        scheduleUISync()
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
        if _isPaginationInFlight { _isPaginationInFlight = false }
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
        if !_isFollowingBottom { _isFollowingBottom = true }
        if _pushToTopMessageId != nil { _pushToTopMessageId = nil }
        isAtBottom = true
        hasReceivedScrollEvent = false
        lastContentOffsetY = 0
        // Clear circuit breaker state so a throttle tripped in the previous
        // conversation doesn't suppress scheduleUISync() in the new one.
        throttleRecoveryTask?.cancel()
        throttleRecoveryTask = nil
        isThrottled = false
        bodyEvalTimestamps.removeAll()
        // Hide scroll indicators during the conversation switch grace period
        // to mask LazyVStack content size estimation changes.
        scrollIndicatorRestoreTask?.cancel()
        if !_hideScrollIndicators { _hideScrollIndicators = true }
        // Sync UI immediately for conversation switch (no debounce delay).
        syncUIImmediately()
        scrollIndicatorRestoreTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 300_000_000) // 300ms
            guard !Task.isCancelled, let self else { return }
            if self._hideScrollIndicators { self._hideScrollIndicators = false }
            self.syncUIImmediately()
            self.scrollIndicatorRestoreTask = nil
        }
    }

    /// Cancel all tasks and clear suppression. Called from `onDisappear`.
    func cancelAll() {
        clearSuppression()
        uiSyncTask?.cancel()
        uiSyncTask = nil
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
        throttleRecoveryTask?.cancel()
        throttleRecoveryTask = nil
        isThrottled = false
        bodyEvalTimestamps.removeAll()
        if _hideScrollIndicators { _hideScrollIndicators = false }
        if _isPaginationInFlight { _isPaginationInFlight = false }
        syncUIImmediately()
    }
}
