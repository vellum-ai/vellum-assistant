import AppKit
import Combine
import Foundation
import os
import SwiftUI
import VellumAssistantShared

let scrollCoordinatorLog = Logger(subsystem: "com.vellum.vellum-assistant", category: "MessageListScrollCoordinator")

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
/// - `anchorLastMinY` — last-known anchor minY, updated on every scroll tick.
/// - `hasReceivedScrollEvent`, `hasFreshAnchorMeasurement`, `wasPaginationTriggerInRange`,
///   `hasLoggedNonFiniteGeometry` — bookkeeping flags that don't drive UI.
/// - `ChatBottomPinCoordinator`, `ChatScrollLoopGuard` — stateful helpers that
///   never need to trigger view re-evaluation themselves.
/// - All in-flight `Task` references.
///
/// **Reactive (`@Published`):**
/// - `anchorIsVisible` — boundary-crossing only (visible <-> invisible), drives
///   the "Scroll to latest" button.
/// - `suppression` / `isSuppressed`, `isPaginationInFlight` — change
///   infrequently and legitimately require view updates.
@MainActor
final class MessageListScrollCoordinator: ObservableObject {

    // MARK: - Reactive State (@Published)

    /// Whether the scroll-bottom-anchor is physically within the scroll view's
    /// visible viewport. Only publishes on boundary crossings (visible <-> invisible).
    @Published var anchorIsVisible: Bool = true

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

    /// Last-known anchor minY without triggering SwiftUI re-renders.
    /// Only `anchorIsVisible` is @Published so re-renders happen only when
    /// the visible/invisible boundary is crossed — not on every scroll tick.
    var anchorLastMinY: CGFloat = .infinity

    /// Coordinates bounded scroll-to-bottom retry sessions and manages the
    /// follow/detach state machine.
    var bottomPinCoordinator = ChatBottomPinCoordinator()

    /// Detects runaway scroll-loop patterns and emits one aggregate warning
    /// per cooldown window instead of per-frame log spam.
    var scrollLoopGuard = ChatScrollLoopGuard()

    /// Whether a physical scroll event (wheel/trackpad) has been received since
    /// the current conversation loaded.
    var hasReceivedScrollEvent: Bool = false

    /// Whether the distance-from-bottom scroll geometry has fired since the
    /// last scroll restore began.
    var hasFreshAnchorMeasurement: Bool = false

    /// Tracks whether the pagination sentinel was previously inside the trigger band.
    var wasPaginationTriggerInRange: Bool = false

    /// One-shot flag: logs a warning the first time anchor, tail, or viewport
    /// geometry is non-finite during a render pass.
    var hasLoggedNonFiniteGeometry: Bool = false

    /// The conversation ID currently being displayed. Updated in
    /// `conversationSwitched` so closures that capture `[weak self]`
    /// always read the live value instead of a stale capture.
    var currentConversationId: UUID?

    /// The most recent scroll viewport height. Stored so closures (e.g.
    /// pin coordinator callbacks) read the live value instead of a stale
    /// capture from configure time.
    var currentScrollViewportHeight: CGFloat = 0

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

    /// In-flight auto-recovery task scheduled after the loop guard trips.
    /// Fires a single deferred re-pin attempt after the cooldown drains.
    var loopGuardRecoveryTask: Task<Void, Never>?

    // MARK: - Anchor Visibility

    /// Updates the tracked distance-from-bottom and recalculates visibility.
    /// Only publishes `anchorIsVisible` when the boundary is actually crossed
    /// (visible <-> invisible), not on every scroll tick.
    ///
    /// `distanceFromBottom` is 0 when the scroll view is pinned to the bottom
    /// and grows as the user scrolls up. The anchor is considered "visible"
    /// (i.e. the bottom of the content is within the viewport) when the
    /// distance is at most 20pt.
    func updateAnchor(distanceFromBottom: CGFloat, viewportHeight: CGFloat) {
        anchorLastMinY = distanceFromBottom
        let newVisible = BottomVisibilityPolicy.evaluate(
            currentlyVisible: anchorIsVisible,
            distanceFromBottom: distanceFromBottom
        )
        if anchorIsVisible != newVisible { anchorIsVisible = newVisible }
    }

    /// Returns `true` when the viewport height actually changed, so callers
    /// can refresh any state tied to the visible geometry.
    @discardableResult
    func updateAnchorViewport(height: CGFloat, storedViewportHeight: inout CGFloat) -> Bool {
        guard storedViewportHeight != height else { return false }
        storedViewportHeight = height
        currentScrollViewportHeight = height
        // Don't recompute visibility before the distance-from-bottom has been
        // measured — anchorLastMinY starts at .infinity, and .infinity <= 20
        // evaluates to false, incorrectly flipping anchorIsVisible to false and
        // flashing the "Scroll to latest" button on short conversations.
        guard anchorLastMinY.isFinite else { return true }
        let newVisible = BottomVisibilityPolicy.evaluate(
            currentlyVisible: anchorIsVisible,
            distanceFromBottom: anchorLastMinY
        )
        if anchorIsVisible != newVisible { anchorIsVisible = newVisible }
        return true
    }

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

    // MARK: - Diagnostics

    /// Records a scroll-related event into the loop guard and emits a
    /// diagnostic warning if the guard trips.
    func recordScrollLoopEvent(
        _ kind: ChatScrollLoopGuard.EventKind,
        conversationId: UUID?,
        isNearBottom: Bool = false,
        scrollViewportHeight: CGFloat = .infinity,
        anchorMessageId: UUID? = nil
    ) {
        let convId = conversationId?.uuidString ?? "unknown"
        let timestamp = ProcessInfo.processInfo.systemUptime

        if let snapshot = scrollLoopGuard.record(kind, conversationId: convId, timestamp: timestamp) {
            // Log the full event histogram (all event kinds, including zeros)
            // for post-mortem analysis — not just the kinds with non-zero counts.
            let fullHistogram = ChatScrollLoopGuard.EventKind.allCases
                .map { "\($0.rawValue)=\(snapshot.counts[$0] ?? 0)" }
                .joined(separator: " ")
            scrollCoordinatorLog.warning(
                "Scroll loop detected — trippedBy=\(snapshot.trippedBy.rawValue) window=\(snapshot.windowDuration)s \(fullHistogram) isNearBottom=\(isNearBottom) hasReceivedScrollEvent=\(self.hasReceivedScrollEvent) anchorMessageId=\(String(describing: anchorMessageId)) anchorLastMinY=\(self.anchorLastMinY) viewportHeight=\(scrollViewportHeight)"
            )
            var sanitizer = NumericSanitizer()
            let safeScrollOffsetY = sanitizer.sanitize(anchorLastMinY, field: "scrollOffsetY")
            let safeViewportHeight = sanitizer.sanitize(scrollViewportHeight, field: "viewportHeight")
            logNonFiniteGeometryOnce(sanitizer: sanitizer)
            ChatDiagnosticsStore.shared.record(ChatDiagnosticEvent(
                kind: .scrollLoopDetected,
                conversationId: convId,
                reason: "trippedBy=\(snapshot.trippedBy.rawValue) \(fullHistogram)",
                isPinnedToBottom: isNearBottom,
                isUserScrolling: hasReceivedScrollEvent,
                scrollOffsetY: safeScrollOffsetY,
                viewportHeight: safeViewportHeight,
                nonFiniteFields: sanitizer.nonFiniteFields
            ))
        }
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
        scrollTracking.snapshotDebounceTask?.cancel()
        scrollTracking.snapshotDebounceTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(150))
            guard !Task.isCancelled, let self else { return }
            self.updateTranscriptSnapshot(
                conversationId: conversationId,
                messages: messages,
                isNearBottom: isNearBottom,
                scrollViewportHeight: scrollViewportHeight,
                containerWidth: containerWidth,
                anchorMessageId: anchorMessageId,
                highlightedMessageId: highlightedMessageId
            )
        }
    }

    /// Captures a point-in-time transcript snapshot into `ChatDiagnosticsStore`.
    private func updateTranscriptSnapshot(
        conversationId: UUID?,
        messages: [ChatMessage],
        isNearBottom: Bool,
        scrollViewportHeight: CGFloat,
        containerWidth: CGFloat,
        anchorMessageId: UUID?,
        highlightedMessageId: UUID?
    ) {
        guard let convId = conversationId else { return }
        let totalToolCalls = messages.reduce(0) { $0 + $1.toolCalls.count }

        var sanitizer = NumericSanitizer()
        let safeAnchorMinY = sanitizer.sanitize(anchorLastMinY, field: "anchorMinY")
        let safeViewportHeight = sanitizer.sanitize(scrollViewportHeight, field: "scrollViewportHeight")
        let safeContainerWidth = sanitizer.sanitize(containerWidth, field: "containerWidth")
        logNonFiniteGeometryOnce(sanitizer: sanitizer)

        let guardCounts = scrollLoopGuard.currentCounts(conversationId: convId.uuidString)
        let guardCountsStringKeyed: [String: Int]? = guardCounts.isEmpty ? nil : Dictionary(
            uniqueKeysWithValues: guardCounts.map { ($0.key.rawValue, $0.value) }
        )

        ChatDiagnosticsStore.shared.updateSnapshot(ChatTranscriptSnapshot(
            conversationId: convId.uuidString,
            capturedAt: Date(),
            messageCount: messages.count,
            toolCallCount: totalToolCalls,
            isPinnedToBottom: isNearBottom,
            isUserScrolling: hasReceivedScrollEvent,
            scrollOffsetY: safeAnchorMinY,
            contentHeight: nil,
            viewportHeight: safeViewportHeight,
            isNearBottom: isNearBottom,
            hasReceivedScrollEvent: hasReceivedScrollEvent,
            isPaginationInFlight: isPaginationInFlight,
            suppressionReason: isSuppressed ? suppression.reasonDescriptions.joined(separator: ",") : nil,
            anchorMessageId: anchorMessageId?.uuidString,
            highlightedMessageId: highlightedMessageId?.uuidString,
            anchorMinY: safeAnchorMinY,
            scrollViewportHeight: safeViewportHeight,
            containerWidth: safeContainerWidth,
            scrollLoopGuardCounts: guardCountsStringKeyed,
            nonFiniteFields: sanitizer.nonFiniteFields
        ))
    }

    /// Logs a one-time warning when scroll geometry first becomes non-finite.
    func logNonFiniteGeometryOnce(sanitizer: NumericSanitizer) {
        guard !hasLoggedNonFiniteGeometry, let fields = sanitizer.nonFiniteFields else { return }
        hasLoggedNonFiniteGeometry = true
        scrollCoordinatorLog.warning("Non-finite scroll geometry detected — sanitized fields: \(fields.joined(separator: ", "))")
    }

    // MARK: - Cleanup

    /// Cancels all in-flight tasks. Called from `onDisappear`.
    func cancelAllTasks() {
        clearAllSuppression()
        scrollRestoreTask?.cancel()
        scrollRestoreTask = nil
        paginationTask?.cancel()
        paginationTask = nil
        loopGuardRecoveryTask?.cancel()
        loopGuardRecoveryTask = nil
        anchorTimeoutTask?.cancel()
        anchorTimeoutTask = nil
        highlightDismissTask?.cancel()
        highlightDismissTask = nil
        isPaginationInFlight = false
        scrollTracking.snapshotDebounceTask?.cancel()
        scrollTracking.snapshotDebounceTask = nil
        bottomPinCoordinator.cancelActiveSession(reason: .conversationSwitch)
        bottomPinCoordinator.onPinRequested = nil
        scrollLoopGuard.onRecoveryNeeded = nil
    }

    /// Resets state for a conversation switch.
    func resetForConversationSwitch(
        oldConversationId: UUID?,
        newConversationId: UUID?
    ) {
        clearAllSuppression()
        scrollTracking.snapshotDebounceTask?.cancel()
        scrollTracking.snapshotDebounceTask = nil
        paginationTask?.cancel()
        paginationTask = nil
        loopGuardRecoveryTask?.cancel()
        loopGuardRecoveryTask = nil
        isPaginationInFlight = false
        wasPaginationTriggerInRange = false
        // Update the live conversation ID so closures read the new value.
        currentConversationId = newConversationId
        // Reset the coordinator for the new conversation.
        bottomPinCoordinator.reset(newConversationId: newConversationId)
        anchorIsVisible = true
        anchorLastMinY = .infinity
        hasReceivedScrollEvent = false
        // Reset the OLD conversation's scroll-loop guard state.
        if let oldConvId = oldConversationId {
            scrollLoopGuard.reset(conversationId: oldConvId.uuidString)
        }
    }
}
