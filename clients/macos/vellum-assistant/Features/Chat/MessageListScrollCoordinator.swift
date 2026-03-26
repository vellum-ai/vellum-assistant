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

/// Named reasons for suppressing bottom auto-scroll. Each reason has a defined
/// timeout so callers don't need to manage independent timers.
///
/// The OptionSet design allows multiple reasons to be active simultaneously
/// (e.g., a resize and expansion can overlap). `isSuppressed` is true when
/// any reason is active.
struct ScrollSuppression: OptionSet, Sendable {
    let rawValue: Int

    /// Pagination loaded new content above the viewport — suppress for 100ms
    /// while the scroll position is restored to the pre-pagination anchor.
    static let pagination = ScrollSuppression(rawValue: 1 << 0)

    /// Content expanded off-bottom (e.g., tool call disclosure) — suppress
    /// for 200ms to prevent the view from jumping back to the bottom.
    static let expansion  = ScrollSuppression(rawValue: 1 << 1)

    /// Container width changed (window resize) — suppress for 100ms while
    /// the layout stabilizes and the scroll position is corrected.
    static let resize     = ScrollSuppression(rawValue: 1 << 2)

    /// Timeout (in nanoseconds) for each suppression reason.
    static func timeout(for reason: ScrollSuppression) -> UInt64 {
        switch reason {
        case .pagination: return 100_000_000  // 100ms
        case .expansion:  return 200_000_000  // 200ms
        case .resize:     return 100_000_000  // 100ms
        default:          return 100_000_000  // fallback
        }
    }

    /// Human-readable description of the active reasons, for diagnostics.
    var reasonDescriptions: [String] {
        var reasons: [String] = []
        if contains(.pagination) { reasons.append("pagination") }
        if contains(.expansion)  { reasons.append("expansion") }
        if contains(.resize)     { reasons.append("resize") }
        return reasons
    }
}

/// Consolidates all scroll-related state from `MessageListView` into a single
/// `ObservableObject` that preserves the reactive / non-reactive split.
///
/// **Non-reactive (plain stored properties, NOT `@Published`):**
/// - All fields on `ScrollTrackingState` (dead-zone guards, smoothing state,
///   precomputed cache) — updated every scroll tick, must never trigger
///   `objectWillChange`.
/// - `isAtBottom` — whether the bottom sentinel is the current scroll target.
/// - `hasReceivedScrollEvent`, `wasPaginationTriggerInRange` — bookkeeping
///   flags that don't drive UI.
/// - `isFollowingBottom` — follow/detach state for bottom-pin logic.
/// - `ScrollDiagnosticsRecorder` — owns loop guard, snapshot capture,
///   and non-finite geometry logging. Never triggers view re-evaluation.
/// - All in-flight `Task` references.
///
/// **Reactive (`@Published`):**
/// - `suppression` / `isSuppressed`, `isPaginationInFlight` — change
///   infrequently and legitimately require view updates.
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

    /// Active scroll suppression reasons. When non-empty, bottom auto-scroll
    /// is suppressed. Each reason has a defined timeout managed by
    /// `suppressionTimeoutTasks`. Replaces the former `isSuppressingBottomScroll`
    /// boolean with a structured OptionSet for diagnostics and correctness.
    @Published var suppression: ScrollSuppression = [] {
        didSet {
            guard suppression != oldValue else { return }
            let added = suppression.subtracting(oldValue)
            let removed = oldValue.subtracting(suppression)
            if !added.isEmpty {
                scrollCoordinatorLog.debug("Scroll suppression started: \(added.reasonDescriptions.joined(separator: ", ")) — active: \(self.suppression.reasonDescriptions.joined(separator: ", "))")
            }
            if !removed.isEmpty {
                scrollCoordinatorLog.debug("Scroll suppression ended: \(removed.reasonDescriptions.joined(separator: ", ")) — active: \(self.suppression.reasonDescriptions.joined(separator: ", "))")
            }
        }
    }

    /// Whether any scroll suppression reason is currently active.
    var isSuppressed: Bool { !suppression.isEmpty }

    /// Guards the pagination sentinel against re-entry during the brief window
    /// between Task launch and the first `await`.
    @Published var isPaginationInFlight: Bool = false


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

    /// Owns all diagnostic recording — loop detection, snapshot capture,
    /// non-finite geometry logging. Extracted to keep the coordinator focused
    /// on scroll mechanics.
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

    /// Per-reason timeout tasks that clear individual suppression bits after
    /// their defined timeout. Keyed by the raw value of the `ScrollSuppression`
    /// reason so each reason's timeout is independent.
    var suppressionTimeoutTasks: [Int: Task<Void, Never>] = [:]

    /// In-flight pagination load task.
    var paginationTask: Task<Void, Never>?

    /// In-flight staged scroll-to-bottom task used after conversation switches
    /// and app restarts.
    var scrollRestoreTask: Task<Void, Never>?

    /// Task that clears the highlight flash after the animation duration.
    var highlightDismissTask: Task<Void, Never>?

    // MARK: - Suppression Management

    /// Adds a suppression reason and schedules its automatic timeout.
    /// If the reason is already active, the existing timeout is replaced.
    func addSuppression(_ reason: ScrollSuppression) {
        suppression.insert(reason)
        os_signpost(.event, log: PerfSignposts.log, name: "scrollSuppressionChanged",
                    "on reason=%{public}s", reason.reasonDescriptions.joined(separator: ","))

        // Cancel any existing timeout for this reason before scheduling a new one.
        let key = reason.rawValue
        suppressionTimeoutTasks[key]?.cancel()
        suppressionTimeoutTasks[key] = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: ScrollSuppression.timeout(for: reason))
            guard !Task.isCancelled, let self else { return }
            self.removeSuppression(reason)
        }
    }

    /// Removes a suppression reason and cancels its timeout task.
    func removeSuppression(_ reason: ScrollSuppression) {
        let key = reason.rawValue
        suppressionTimeoutTasks[key]?.cancel()
        suppressionTimeoutTasks[key] = nil
        guard suppression.contains(reason) else { return }
        suppression.remove(reason)
        os_signpost(.event, log: PerfSignposts.log, name: "scrollSuppressionChanged",
                    "off reason=%{public}s", reason.reasonDescriptions.joined(separator: ","))
    }

    /// Clears all suppression reasons and cancels all timeout tasks.
    func clearAllSuppression() {
        for (_, task) in suppressionTimeoutTasks {
            task.cancel()
        }
        suppressionTimeoutTasks.removeAll()
        if !suppression.isEmpty {
            let reasons = suppression.reasonDescriptions.joined(separator: ",")
            suppression = []
            os_signpost(.event, log: PerfSignposts.log, name: "scrollSuppressionChanged",
                        "off reason=clearAll(was:%{public}s)", reasons)
        }
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

    /// Schedules a debounced transcript snapshot capture.
    func scheduleTranscriptSnapshot(
        conversationId: UUID?,
        messages: [ChatMessage],
        isNearBottom: Bool,
        scrollViewportHeight: CGFloat,
        containerWidth: CGFloat,
        anchorMessageId: UUID?,
        highlightedMessageId: UUID?
    ) {
        diagnostics.scheduleTranscriptSnapshot(
            conversationId: conversationId,
            messages: messages,
            isNearBottom: isNearBottom,
            scrollViewportHeight: scrollViewportHeight,
            containerWidth: containerWidth,
            anchorMessageId: anchorMessageId,
            highlightedMessageId: highlightedMessageId,
            hasReceivedScrollEvent: hasReceivedScrollEvent,
            isPaginationInFlight: isPaginationInFlight,
            isSuppressed: isSuppressed,
            suppression: suppression,
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
