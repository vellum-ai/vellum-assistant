import AppKit
import Combine
import Foundation
import os
import SwiftUI
import VellumAssistantShared

let scrollCoordinatorLog = Logger(subsystem: "com.vellum.vellum-assistant", category: "MessageListScrollCoordinator")

// MARK: - Bottom Pin Types

/// Reasons the system may request a scroll-to-bottom pin.
enum BottomPinRequestReason: String, Sendable {
    /// Initial conversation load / restore from disk.
    case initialRestore
    /// A new message was appended to the conversation.
    case messageCount
    /// An inline element (progress card, tool output) expanded its height.
    case expansion
    /// The chat container was resized (sidebar toggle, window drag).
    case resize
}

/// Consolidates all scroll-related state from `MessageListView` into a single
/// `ObservableObject` that preserves the reactive / non-reactive split.
///
/// **Non-reactive (plain stored properties, NOT `@Published`):**
/// - All fields on `ScrollTrackingState` (dead-zone guards, smoothing state,
///   precomputed cache) — updated every scroll tick, must never trigger
///   `objectWillChange`.
/// - `hasReceivedScrollEvent`, `wasPaginationTriggerInRange` — bookkeeping
///   flags that don't drive UI.
/// - `isFollowingBottom` — follow/detach state for bottom-pin logic.
/// - `ScrollDiagnosticsRecorder` — owns loop guard, snapshot capture,
///   and non-finite geometry logging. Never triggers view re-evaluation.
/// - All in-flight `Task` references.
/// - `isResizeSuppressed`, `isPaginationSuppressed`, `isExpansionSuppressed` —
///   plain boolean flags for scroll suppression. NOT `@Published` because the
///   view never reads suppression state directly for rendering; making them
///   `@Published` would trigger unnecessary `objectWillChange` on every
///   suppression flip. Managed via per-reason `begin`/`end` helpers.
///
/// **Reactive (`@Published`):**
/// - `isAtBottom` — drives "Scroll to latest" CTA button visibility and
///   reattach-on-idle logic.
/// - `isPaginationInFlight` — changes infrequently and legitimately requires
///   view updates.
@MainActor
final class MessageListScrollCoordinator: ObservableObject {

    // MARK: - Scroll Position

    /// Closure that performs a programmatic scroll to the given item ID and
    /// anchor point. Set once during `configureScrollPosition` and captures
    /// the view-owned `ScrollPosition` binding.
    var scrollTo: ((_ id: any Hashable, _ anchor: UnitPoint?) -> Void)?

    /// Closure that scrolls to a given edge (e.g. `.bottom`). Used for
    /// conversation switches where we need to position at the bottom
    /// without relying on `.defaultScrollAnchor`.
    var scrollToEdge: ((_ edge: Edge) -> Void)?

    /// Returns `true` when the user is within 20pt of the conversation bottom.
    /// Computed from scroll geometry in the onScrollGeometryChange handler.
    /// @Published so the "Scroll to latest" CTA button and avatar visibility
    /// react immediately when the user scrolls to/from the bottom.
    @Published var isAtBottom: Bool = true

    /// The message ID whose top edge should be pinned to the viewport top
    /// after the user sends a message (push-to-top pattern). `nil` when
    /// push-to-top is inactive. `@Published` so the conditional tail spacer
    /// in MessageListView re-renders when push-to-top starts/ends.
    @Published var pushToTopMessageId: (any Hashable)?

    /// Height of the tail spacer when it is visible during push-to-top.
    /// Subtracted from content height for overflow and bottom detection
    /// so those computations operate on effective content height.
    var tailSpacerHeight: CGFloat {
        guard pushToTopMessageId != nil else { return 0 }
        let h = currentScrollViewportHeight
        // Account for LazyVStack inter-item spacing so the spacer
        // doesn't overshoot by one spacing unit.
        return h.isFinite ? max(0, h - VSpacing.md) : 0
    }

    // MARK: - Reactive State (@Published)

    /// Guards the pagination sentinel against re-entry during the brief window
    /// between Task launch and the first `await`.
    @Published var isPaginationInFlight: Bool = false

    // MARK: - Suppression Flags (non-reactive)

    /// Whether resize suppression is currently active. Plain stored `var`
    /// (not `@Published`) — the view never reads suppression state for
    /// rendering; only `hideScrollIndicators` is `@Published`.
    var isResizeSuppressed: Bool = false

    /// Whether pagination suppression is currently active. Plain stored `var`
    /// (not `@Published`) for the same reason as `isResizeSuppressed`.
    var isPaginationSuppressed: Bool = false

    /// Whether expansion suppression is currently active. Plain stored `var`
    /// (not `@Published`) for the same reason as `isResizeSuppressed`.
    var isExpansionSuppressed: Bool = false

    /// Timeout task for expansion suppression — the only suppression reason
    /// that uses an auto-timeout (200ms). Resize and pagination manage their
    /// lifecycle manually within their respective task bodies.
    var expansionTimeoutTask: Task<Void, Never>?

    /// Whether any scroll suppression reason is currently active.
    var isSuppressed: Bool { isResizeSuppressed || isPaginationSuppressed || isExpansionSuppressed }

    /// Human-readable names of currently active suppression reasons, for
    /// diagnostics and transcript snapshots.
    var activeSuppressionReasons: [String] {
        var reasons: [String] = []
        if isResizeSuppressed     { reasons.append("resize") }
        if isPaginationSuppressed { reasons.append("pagination") }
        if isExpansionSuppressed  { reasons.append("expansion") }
        return reasons
    }


    // MARK: - Non-Reactive State (plain stored properties)

    /// Non-reactive scroll tracking state (dead-zone guards, smoothing).
    /// Stored on a class so mutations never trigger body re-evaluations.
    /// Keeping this as a plain `var` (not `@Published`) ensures mutations
    /// bypass `objectWillChange`, preserving the existing perf-critical pattern.
    var scrollTracking = ScrollTrackingState()

    /// Whether the viewport is logically following the bottom of the transcript.
    /// When false (detached), background pin requests are suppressed.
    var isFollowingBottom: Bool = true

    /// Binding to the view's `isNearBottom` state, updated when follow/detach
    /// state changes. Stored so `detachFromBottom` / `reattachToBottom` can
    /// update the view directly without callback indirection.
    var isNearBottomBinding: Binding<Bool>?

    /// Owns diagnostic recording — loop detection and non-finite geometry
    /// logging. Extracted to keep the coordinator focused on scroll mechanics.
    var diagnostics = ScrollDiagnosticsRecorder()

    /// Whether a physical scroll event (wheel/trackpad) has been received since
    /// the current conversation loaded.
    var hasReceivedScrollEvent: Bool = false

    /// Whether scroll indicators should be temporarily hidden during a
    /// conversation switch. LazyVStack content size estimation causes the
    /// scrollbar to visibly resize as views materialize with varying heights;
    /// hiding the indicators during the initial layout window masks this.
    @Published var hideScrollIndicators: Bool = false

    /// Task that restores scroll indicator visibility after the grace period.
    var scrollIndicatorRestoreTask: Task<Void, Never>?

    /// Tracks whether the pagination sentinel was previously inside the trigger band.
    var wasPaginationTriggerInRange: Bool = false

    /// The conversation ID currently being displayed. Updated in
    /// `conversationSwitched` so closures that capture `[weak self]`
    /// always read the live value instead of a stale capture.
    var currentConversationId: UUID?

    /// The most recent scroll viewport height. Stored so closures (e.g.
    /// pin coordinator callbacks) read the live value instead of a stale
    /// capture from configure time.
    ///
    /// **Non-reactive**: updated from `onScrollGeometryChange` on every
    /// scroll tick. Stored here (not `@State`) so mutations never trigger
    /// body re-evaluations — the viewport height is only consumed by
    /// imperative event handlers, not by the view body for rendering.
    var currentScrollViewportHeight: CGFloat = .infinity

    /// Current scroll phase from `onScrollPhaseChange`. Only read inside
    /// the `onScrollGeometryChange` action closure to decide whether a
    /// scroll-up should trigger detach. **Non-reactive**: stored here
    /// (not `@State`) because it is never read during body evaluation
    /// for rendering purposes — only in event-handler closures.
    var scrollPhase: ScrollPhase = .idle

    // MARK: - Reaction State (moved from view @State to avoid cascading onChange)

    /// Captures the `assistantActivityPhase` at the moment `isSending` goes false.
    /// Used to distinguish mid-turn tool-confirmation pauses (phase == "awaiting_confirmation")
    /// from genuine turn endings, so the `sendingStateChanged` reaction can decide
    /// whether to reattach the scroll position on the next `isSending = true` transition.
    var phaseWhenSendingStopped: String = ""

    /// Last container width that triggered a resize scroll handler, used to
    /// detect meaningful width changes (>2pt) and avoid sub-pixel jitter.
    var lastHandledContainerWidth: CGFloat = 0

    /// Timestamp when anchorMessageId was set. Used together with pagination
    /// exhaustion to decide when a stale anchor should be cleared.
    var anchorSetTime: Date?

    /// Independent timer task that clears a stale anchor after 10 seconds,
    /// regardless of whether messages.count changes.
    var anchorTimeoutTask: Task<Void, Never>?

    /// Tracks the last pending confirmation request ID that triggered an
    /// auto-focus handoff. Used to detect nil->non-nil transitions so we
    /// resign first responder exactly once per new confirmation appearance.
    var lastAutoFocusedRequestId: String?

    // MARK: - Tasks

    /// In-flight pagination load task.
    var paginationTask: Task<Void, Never>?

    /// In-flight staged scroll-to-bottom task used after conversation switches
    /// and app restarts.
    var scrollRestoreTask: Task<Void, Never>?

    /// Task that clears the highlight flash after the animation duration.
    var highlightDismissTask: Task<Void, Never>?

    // MARK: - Suppression Management

    /// Begins resize suppression. Managed manually by the resize task body.
    func beginResizeSuppression() {
        isResizeSuppressed = true
        logSuppressionChange(started: "resize")
    }

    /// Ends resize suppression. No-op if already inactive.
    func endResizeSuppression() {
        guard isResizeSuppressed else { return }
        isResizeSuppressed = false
        logSuppressionChange(ended: "resize")
    }

    /// Begins pagination suppression. Managed manually by the pagination task body.
    func beginPaginationSuppression() {
        isPaginationSuppressed = true
        logSuppressionChange(started: "pagination")
    }

    /// Ends pagination suppression. No-op if already inactive.
    func endPaginationSuppression() {
        guard isPaginationSuppressed else { return }
        isPaginationSuppressed = false
        logSuppressionChange(ended: "pagination")
    }

    /// Begins expansion suppression with a 200ms auto-timeout. If expansion
    /// suppression is already active, the timeout is reset. This is the only
    /// suppression reason that uses an auto-timeout — resize and pagination
    /// manage their lifecycle manually within their task bodies.
    func beginExpansionSuppression() {
        isExpansionSuppressed = true
        logSuppressionChange(started: "expansion")
        expansionTimeoutTask?.cancel()
        expansionTimeoutTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 200_000_000)
            guard !Task.isCancelled, let self else { return }
            self.endExpansionSuppression()
        }
    }

    /// Ends expansion suppression and cancels any pending auto-timeout.
    /// No-op if already inactive.
    func endExpansionSuppression() {
        expansionTimeoutTask?.cancel()
        expansionTimeoutTask = nil
        guard isExpansionSuppressed else { return }
        isExpansionSuppressed = false
        logSuppressionChange(ended: "expansion")
    }

    /// Clears all suppression flags and cancels the expansion timeout task.
    /// Directly resets flags instead of calling the per-reason `end*` helpers
    /// to avoid emitting N+1 log entries (one per helper + one here).
    func clearAllSuppression() {
        let wasActive = isSuppressed
        let reasons = activeSuppressionReasons.joined(separator: ",")
        // Clear flags directly — bypass end helpers to avoid per-reason logging.
        isResizeSuppressed = false
        isPaginationSuppressed = false
        isExpansionSuppressed = false
        expansionTimeoutTask?.cancel()
        expansionTimeoutTask = nil
        if wasActive {
            scrollCoordinatorLog.debug("Scroll suppression cleared: clearAll (was: \(reasons))")
            os_signpost(.event, log: PerfSignposts.log, name: "scrollSuppressionChanged",
                        "off reason=clearAll(was:%{public}s)", reasons)
        }
    }

    /// Shared logging for suppression state transitions.
    private func logSuppressionChange(started reason: String) {
        scrollCoordinatorLog.debug("Scroll suppression started: \(reason) — active: \(self.activeSuppressionReasons.joined(separator: ", "))")
        os_signpost(.event, log: PerfSignposts.log, name: "scrollSuppressionChanged",
                    "on reason=%{public}s", reason)
    }

    /// Shared logging for suppression state transitions.
    private func logSuppressionChange(ended reason: String) {
        scrollCoordinatorLog.debug("Scroll suppression ended: \(reason) — active: \(self.activeSuppressionReasons.joined(separator: ", "))")
        os_signpost(.event, log: PerfSignposts.log, name: "scrollSuppressionChanged",
                    "off reason=%{public}s", reason)
    }

    // MARK: - Follow/Detach State

    /// Transitions to the detached state, suppressing all background pin requests.
    func detachFromBottom() {
        let wasFollowing = isFollowingBottom
        isFollowingBottom = false
        if wasFollowing {
            scrollCoordinatorLog.debug("[BottomPin] detach isFollowingBottom=false")
            isNearBottomBinding?.wrappedValue = false
        }
    }

    /// Transitions to the following state, allowing pin requests to proceed.
    func reattachToBottom() {
        let wasDetached = !isFollowingBottom
        isFollowingBottom = true
        if wasDetached {
            scrollCoordinatorLog.debug("[BottomPin] reattach isFollowingBottom=true")
            isNearBottomBinding?.wrappedValue = true
        }
    }

    // MARK: - Diagnostics (forwarded to ScrollDiagnosticsRecorder)

    /// Records a scroll-related event into the loop guard and emits a
    /// diagnostic warning if the guard trips.
    func recordScrollLoopEvent(
        _ kind: ChatScrollLoopGuard.EventKind,
        conversationId: UUID?,
        isNearBottom: Bool = false,
        scrollViewportHeight: CGFloat = .infinity,
        anchorMessageId: UUID? = nil
    ) {
        diagnostics.recordScrollLoopEvent(
            kind,
            conversationId: conversationId,
            isNearBottom: isNearBottom,
            scrollViewportHeight: scrollViewportHeight,
            anchorMessageId: anchorMessageId,
            hasReceivedScrollEvent: hasReceivedScrollEvent,
            isAtBottom: isAtBottom
        )
    }

    // MARK: - Cleanup

    /// Cancels all in-flight tasks. Called from `onDisappear`.
    func cancelAllTasks() {
        clearAllSuppression()
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
        hideScrollIndicators = false
        isPaginationInFlight = false
        diagnostics.cancel()
        isNearBottomBinding = nil
    }

    /// Resets state for a conversation switch.
    func resetForConversationSwitch(
        oldConversationId: UUID?,
        newConversationId: UUID?
    ) {
        clearAllSuppression()
        diagnostics.reset(oldConversationId: oldConversationId)
        paginationTask?.cancel()
        paginationTask = nil
        isPaginationInFlight = false
        wasPaginationTriggerInRange = false
        // Update the live conversation ID so closures read the new value.
        currentConversationId = newConversationId
        // Reset follow state for the new conversation.
        isFollowingBottom = true
        isNearBottomBinding?.wrappedValue = true
        pushToTopMessageId = nil
        isAtBottom = true
        hasReceivedScrollEvent = false
        // Hide scroll indicators during the conversation switch grace period
        // to mask LazyVStack content size estimation changes.
        scrollIndicatorRestoreTask?.cancel()
        hideScrollIndicators = true
        scrollIndicatorRestoreTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 300_000_000) // 300ms
            guard !Task.isCancelled, let self else { return }
            self.hideScrollIndicators = false
            self.scrollIndicatorRestoreTask = nil
        }
    }
}
