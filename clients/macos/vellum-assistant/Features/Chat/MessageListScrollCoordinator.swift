import Combine
import Foundation
import os
import SwiftUI
import VellumAssistantShared

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "MessageListScrollCoordinator")

/// Holds the last-known distance-from-bottom without triggering SwiftUI
/// re-renders. Only `isVisible` is @Published so re-renders happen only when
/// the visible/invisible boundary is crossed — not on every scroll tick.
///
/// Retained as a standalone type for testability. The coordinator delegates
/// anchor tracking to this class internally but exposes `anchorIsVisible`
/// and `anchorLastMinY` as top-level properties for convenience.
///
/// `lastMinY` stores the distance-from-bottom (0 at the bottom, positive when
/// scrolled up). The anchor is considered "visible" when the distance is at
/// most 20pt.
@MainActor final class AnchorVisibilityTracker: ObservableObject {
    var lastMinY: CGFloat = .infinity  // NOT @Published — no re-render on scroll
    @Published var isVisible: Bool = true

    /// Updates the tracked distance-from-bottom and recalculates visibility.
    /// Only publishes `isVisible` when the boundary is actually crossed
    /// (visible ↔ invisible), not on every scroll tick — this prevents
    /// SwiftUI re-renders during continuous scrolling.
    func update(distanceFromBottom: CGFloat, viewportHeight: CGFloat) {
        lastMinY = distanceFromBottom
        let newVisible = distanceFromBottom >= -20 && distanceFromBottom <= 20
        if isVisible != newVisible { isVisible = newVisible }
    }

    /// Returns `true` when the viewport height actually changed, so callers
    /// can refresh any state tied to the visible geometry.
    @discardableResult
    func updateViewport(height: CGFloat, storedViewportHeight: inout CGFloat) -> Bool {
        guard storedViewportHeight != height else { return false }
        storedViewportHeight = height
        // Don't recompute visibility before the distance-from-bottom has been
        // measured — lastMinY starts at .infinity, and .infinity <= 20
        // evaluates to false, incorrectly flipping isVisible to false and
        // flashing the "Scroll to latest" button on short conversations.
        guard lastMinY.isFinite else { return true }
        let newVisible = lastMinY >= -20 && lastMinY <= 20
        if isVisible != newVisible { isVisible = newVisible }
        return true
    }
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
/// - `anchorLastMinY` — last-known anchor minY, updated on every scroll tick.
/// - `hasReceivedScrollEvent`, `hasFreshAnchorMeasurement`, `wasPaginationTriggerInRange`,
///   `hasLoggedNonFiniteGeometry` — bookkeeping flags that don't drive UI.
/// - `ChatBottomPinCoordinator`, `ChatScrollLoopGuard` — stateful helpers that
///   never need to trigger view re-evaluation themselves.
/// - All in-flight `Task` references.
///
/// **Reactive (`@Published`):**
/// - `anchorIsVisible` — boundary-crossing only (visible ↔ invisible), drives
///   the "Scroll to latest" button.
/// - `suppression` / `isSuppressed`, `isPaginationInFlight` — change
///   infrequently and legitimately require view updates.
@MainActor
final class MessageListScrollCoordinator: ObservableObject {

    // MARK: - Reactive State (@Published)

    /// Whether the scroll-bottom-anchor is physically within the scroll view's
    /// visible viewport. Only publishes on boundary crossings (visible ↔ invisible).
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
                log.debug("Scroll suppression started: \(added.reasonDescriptions.joined(separator: ", ")) — active: \(self.suppression.reasonDescriptions.joined(separator: ", "))")
            }
            if !removed.isEmpty {
                log.debug("Scroll suppression ended: \(removed.reasonDescriptions.joined(separator: ", ")) — active: \(self.suppression.reasonDescriptions.joined(separator: ", "))")
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

    /// In-flight auto-recovery task scheduled after the loop guard trips.
    /// Fires a single deferred re-pin attempt after the cooldown drains.
    var loopGuardRecoveryTask: Task<Void, Never>?

    // MARK: - Anchor Visibility (mirrors AnchorVisibilityTracker)

    /// Updates the tracked distance-from-bottom and recalculates visibility.
    /// Only publishes `anchorIsVisible` when the boundary is actually crossed
    /// (visible ↔ invisible), not on every scroll tick.
    ///
    /// `distanceFromBottom` is 0 when the scroll view is pinned to the bottom
    /// and grows as the user scrolls up. The anchor is considered "visible"
    /// (i.e. the bottom of the content is within the viewport) when the
    /// distance is at most 20pt.
    func updateAnchor(distanceFromBottom: CGFloat, viewportHeight: CGFloat) {
        anchorLastMinY = distanceFromBottom
        let newVisible = distanceFromBottom >= -20 && distanceFromBottom <= 20
        if anchorIsVisible != newVisible { anchorIsVisible = newVisible }
    }

    /// Returns `true` when the viewport height actually changed, so callers
    /// can refresh any state tied to the visible geometry.
    @discardableResult
    func updateAnchorViewport(height: CGFloat, storedViewportHeight: inout CGFloat) -> Bool {
        guard storedViewportHeight != height else { return false }
        storedViewportHeight = height
        // Don't recompute visibility before the distance-from-bottom has been
        // measured — anchorLastMinY starts at .infinity, and .infinity <= 20
        // evaluates to false, incorrectly flipping anchorIsVisible to false and
        // flashing the "Scroll to latest" button on short conversations.
        guard anchorLastMinY.isFinite else { return true }
        let newVisible = anchorLastMinY >= -20 && anchorLastMinY <= 20
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

    // MARK: - Scroll Methods

    /// Sentinel UUID used for pin requests before the daemon assigns a real
    /// conversation ID. Lets bootstrap-window requests coalesce normally.
    static let bootstrapConversationId = UUID(uuidString: "00000000-0000-0000-0000-000000000000")!

    /// Routes an automatic bottom-follow request through the coordinator.
    /// Returns `false` when the scroll loop guard is tripped, suppressing the request.
    @discardableResult
    func requestBottomPin(
        reason: BottomPinRequestReason,
        proxy: ScrollViewProxy,
        conversationId: UUID?,
        animated: Bool = false
    ) -> Bool {
        let convIdString = (conversationId ?? Self.bootstrapConversationId).uuidString
        if scrollLoopGuard.isTripped(conversationId: convIdString) {
            os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested",
                        "target=bottomAnchor reason=circuitBreakerSuppressed-requestBottomPin")
            return false
        }
        let convId = conversationId ?? Self.bootstrapConversationId
        bottomPinCoordinator.requestPin(
            reason: reason,
            conversationId: convId,
            animated: animated
        )
        return true
    }

    /// Configures the coordinator's callbacks to wire pin requests back to
    /// the scroll view proxy and follow-state changes back to `isNearBottom`.
    func configureBottomPinCoordinator(
        proxy: ScrollViewProxy,
        scrollViewportHeight: CGFloat,
        conversationId: UUID?,
        isNearBottom: Binding<Bool>
    ) {
        bottomPinCoordinator.onPinRequested = { [weak self] reason, animated in
            guard let self else { return false }
            guard !isSuppressed else { return false }
            // Circuit breaker: suppress scroll-to when a scroll loop was detected.
            let convIdString = conversationId?.uuidString ?? "unknown"
            if scrollLoopGuard.isTripped(conversationId: convIdString) {
                os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested",
                            "target=bottomAnchor reason=circuitBreakerSuppressed")
                return false
            }
            os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested",
                        "target=bottomAnchor reason=coordinator-%{public}s", reason.rawValue)
            recordScrollLoopEvent(.scrollToRequested, conversationId: conversationId)
            if animated {
                withAnimation(VAnimation.fast) {
                    proxy.scrollTo("scroll-bottom-anchor", anchor: .bottom)
                }
            } else {
                proxy.scrollTo("scroll-bottom-anchor", anchor: .bottom)
            }
            // Check if the pin succeeded (anchor within viewport).
            let outcome = MessageListBottomAnchorPolicy.verify(
                anchorMinY: anchorLastMinY,
                viewportHeight: scrollViewportHeight
            )
            return outcome == .anchored
        }
        bottomPinCoordinator.onFollowStateChanged = { isFollowing in
            isNearBottom.wrappedValue = isFollowing
        }

        // Wire auto-recovery: when the loop guard's cooldown expires, schedule
        // a single deferred re-pin attempt so the UI doesn't get stuck.
        scrollLoopGuard.onRecoveryNeeded = { [weak self] convId in
            guard let self else { return }
            loopGuardRecoveryTask?.cancel()
            loopGuardRecoveryTask = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(ChatScrollLoopGuard.autoRecoveryDelay * 1_000_000_000))
                guard !Task.isCancelled, let self else { return }
                log.debug("Loop guard auto-recovery: attempting re-pin for \(convId)")
                os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested",
                            "target=bottomAnchor reason=loopGuardAutoRecovery")
                self.bottomPinCoordinator.reattach()
                self.requestBottomPin(reason: .initialRestore, proxy: proxy, conversationId: conversationId, animated: true)
                self.loopGuardRecoveryTask = nil
            }
        }

        // If detach() was called before this callback was wired up, sync
        // isNearBottom now so it isn't stuck at true permanently.
        if !bottomPinCoordinator.isFollowingBottom {
            isNearBottom.wrappedValue = false
        }
    }

    /// Staged scroll-to-bottom that retries after increasing delays to handle
    /// cases where SwiftUI hasn't committed the new content's layout yet.
    func restoreScrollToBottom(
        proxy: ScrollViewProxy,
        conversationId: UUID?,
        anchorMessageId: Binding<UUID?>,
        scrollViewportHeight: CGFloat
    ) {
        scrollRestoreTask?.cancel()
        hasFreshAnchorMeasurement = false

        // Route the initial restore through the coordinator for bounded retries.
        if anchorMessageId.wrappedValue == nil {
            requestBottomPin(reason: .initialRestore, proxy: proxy, conversationId: conversationId)
        }

        scrollRestoreTask = Task { @MainActor [weak self] in
            guard let self, !Task.isCancelled else { return }
            // Stage 0: immediate — the coordinator fires its first attempt above.
            os_signpost(.event, log: PerfSignposts.log, name: "scrollRestoreStage", "stage=0")
            log.debug("Scroll restore: stage 0 (immediate, coordinator-driven)")

            // Stage 1: ~3 frames — handles most conversation switches.
            try? await Task.sleep(nanoseconds: 50_000_000)
            guard !Task.isCancelled else { return }
            os_signpost(.event, log: PerfSignposts.log, name: "scrollRestoreStage", "stage=1")
            if anchorMessageId.wrappedValue == nil {
                requestBottomPin(reason: .initialRestore, proxy: proxy, conversationId: conversationId)
            }
            log.debug("Scroll restore: stage 1 (50ms)")

            // Stage 2: ~9 frames — catches slower layout/materialization.
            try? await Task.sleep(nanoseconds: 150_000_000)
            guard !Task.isCancelled else { return }
            let restoreOutcome = MessageListBottomAnchorPolicy.verify(
                anchorMinY: anchorLastMinY,
                viewportHeight: scrollViewportHeight
            )
            if anchorMessageId.wrappedValue == nil
                && !hasReceivedScrollEvent
                && restoreOutcome == .needsRepin
            {
                os_signpost(.event, log: PerfSignposts.log, name: "scrollRestoreStage", "stage=2 action=retry")
                requestBottomPin(reason: .initialRestore, proxy: proxy, conversationId: conversationId)
                log.debug("Scroll restore: stage 2 (200ms) — retrying via coordinator")
            } else {
                os_signpost(.event, log: PerfSignposts.log, name: "scrollRestoreStage", "stage=2 action=skipped")
                log.debug("Scroll restore: stage 2 skipped (anchor=\(String(describing: anchorMessageId.wrappedValue)) scrollEvent=\(self.hasReceivedScrollEvent))")
            }

            if !Task.isCancelled { scrollRestoreTask = nil }
        }
    }

    /// Fires a single pagination load, restores the scroll anchor, and
    /// manages the `isPaginationInFlight` / suppression guards.
    func triggerPagination(
        proxy: ScrollViewProxy,
        visibleMessages: [ChatMessage],
        conversationId: UUID?,
        loadPreviousMessagePage: (() async -> Bool)?
    ) {
        guard !isPaginationInFlight else { return }
        isPaginationInFlight = true
        // Pagination scroll-position restore is higher priority — cancel any
        // active pin session so the coordinator doesn't fight the restore.
        bottomPinCoordinator.cancelActiveSession(reason: .paginationRestore)
        let anchorId = visibleMessages.first?.id
        os_signpost(.event, log: PerfSignposts.log, name: "paginationSentinelFired")
        log.debug("[pagination] fired — anchorId: \(String(describing: anchorId))")
        paginationTask = Task { [weak self] in
            guard let self else { return }
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
                // Use inline suppression for pagination since we need to
                // hold suppression across the sleep + scroll restore sequence.
                // The timeout task from addSuppression is cancelled immediately
                // after the scroll restore to keep the inline timing exact.
                addSuppression(.pagination)
                // Cancel the auto-timeout — we manage the lifecycle inline.
                suppressionTimeoutTasks[ScrollSuppression.pagination.rawValue]?.cancel()
                suppressionTimeoutTasks[ScrollSuppression.pagination.rawValue] = nil
                try? await Task.sleep(nanoseconds: 100_000_000)
                guard !Task.isCancelled else {
                    removeSuppression(.pagination)
                    return
                }
                os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested", "target=paginationAnchor")
                recordScrollLoopEvent(.scrollToRequested, conversationId: conversationId)
                proxy.scrollTo(id, anchor: .top)
                log.debug("[pagination] scroll restored to anchor \(id)")
                removeSuppression(.pagination)
            }
        }
    }

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
            log.warning(
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
        log.warning("Non-finite scroll geometry detected — sanitized fields: \(fields.joined(separator: ", "))")
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
        isPaginationInFlight = false
        scrollTracking.snapshotDebounceTask?.cancel()
        scrollTracking.snapshotDebounceTask = nil
        bottomPinCoordinator.cancelActiveSession(reason: .conversationSwitch)
        bottomPinCoordinator.onPinRequested = nil
        scrollLoopGuard.onRecoveryNeeded = nil
    }

    /// Handles physical scroll-wheel/trackpad upward movement.
    func handleScrollUp() {
        scrollRestoreTask?.cancel()
        scrollRestoreTask = nil
        clearAllSuppression()
        bottomPinCoordinator.handleUserAction(.scrollUp)
        hasReceivedScrollEvent = true
    }

    /// Handles user explicitly scrolling to the bottom.
    func handleScrollToBottom() {
        scrollRestoreTask?.cancel()
        scrollRestoreTask = nil
        clearAllSuppression()
        bottomPinCoordinator.handleUserAction(.scrollToBottom)
        hasReceivedScrollEvent = true
    }

    /// Handles the suppress-auto-scroll environment action from child views.
    func handleSuppressAutoScroll(
        isNearBottom: Bool,
        isResizeActive: Bool,
        conversationId: UUID?,
        proxy: ScrollViewProxy,
        scrollViewportHeight: CGFloat
    ) {
        // Cancel any pending expansion timeout before re-evaluating.
        removeSuppression(.expansion)
        if isNearBottom {
            os_signpost(.event, log: PerfSignposts.log, name: "scrollSuppressionChanged", "on reason=expansionPinning")
            recordScrollLoopEvent(.suppressionFlip, conversationId: conversationId, isNearBottom: isNearBottom, scrollViewportHeight: scrollViewportHeight)
            requestBottomPin(reason: .expansion, proxy: proxy, conversationId: conversationId, animated: false)
        } else {
            os_signpost(.event, log: PerfSignposts.log, name: "scrollSuppressionChanged", "on reason=offBottomExpansion")
            recordScrollLoopEvent(.suppressionFlip, conversationId: conversationId, isNearBottom: isNearBottom, scrollViewportHeight: scrollViewportHeight)
            // Add expansion suppression with auto-timeout. Override the default
            // timeout task to also check resize/pagination guards.
            suppression.insert(.expansion)
            let key = ScrollSuppression.expansion.rawValue
            suppressionTimeoutTasks[key]?.cancel()
            suppressionTimeoutTasks[key] = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: ScrollSuppression.timeout(for: .expansion))
                guard !Task.isCancelled, let self else { return }
                if !isResizeActive && !self.isPaginationInFlight {
                    self.removeSuppression(.expansion)
                }
            }
        }
    }

    /// Handles a non-finite distance-from-bottom value by marking the anchor
    /// as off-screen.
    func handleNonFiniteAnchor() {
        if anchorIsVisible {
            anchorIsVisible = false
        }
        anchorLastMinY = .infinity
    }

    /// Creates a resize scroll stabilization task. The caller is responsible for
    /// assigning the returned task to the view-local `resizeScrollTask` state and
    /// cancelling any previous task before calling this.
    func makeResizeTask(
        proxy: ScrollViewProxy,
        conversationId: UUID?,
        isNearBottom: Bool,
        anchorMessageId: UUID?,
        scrollViewportHeight: CGFloat,
        onComplete: @escaping @MainActor () -> Void
    ) -> Task<Void, Never> {
        Task { @MainActor [weak self] in
            guard let self else { return }
            // Use inline suppression for resize since we manage the lifecycle
            // within this task (similar to pagination). Cancel the auto-timeout
            // from addSuppression so the defer block controls removal.
            self.addSuppression(.resize)
            self.suppressionTimeoutTasks[ScrollSuppression.resize.rawValue]?.cancel()
            self.suppressionTimeoutTasks[ScrollSuppression.resize.rawValue] = nil
            defer {
                if !Task.isCancelled {
                    self.removeSuppression(.resize)
                    onComplete()
                }
            }
            try? await Task.sleep(nanoseconds: 100_000_000)
            guard !Task.isCancelled else { return }

            if isNearBottom && anchorMessageId == nil {
                let resizeOutcome = MessageListBottomAnchorPolicy.verify(
                    anchorMinY: self.anchorLastMinY,
                    viewportHeight: scrollViewportHeight
                )
                if resizeOutcome == .needsRepin {
                    self.requestBottomPin(reason: .resize, proxy: proxy, conversationId: conversationId)
                }
            }
        }
    }

    /// Evaluates a pagination sentinel preference change and triggers pagination
    /// if the sentinel entered the trigger band. Returns true if pagination was triggered.
    @discardableResult
    func handlePaginationSentinel(
        sentinelMinY: CGFloat,
        scrollViewportHeight: CGFloat,
        hasMoreMessages: Bool,
        isLoadingMoreMessages: Bool,
        proxy: ScrollViewProxy,
        visibleMessages: [ChatMessage],
        conversationId: UUID?,
        loadPreviousMessagePage: (() async -> Bool)?
    ) -> Bool {
        guard PreferenceGeometryFilter.evaluate(
            newValue: sentinelMinY,
            previous: .infinity,
            deadZone: 0
        ) != .rejectNonFinite else { return false }

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

        guard shouldFire,
              hasMoreMessages,
              !isLoadingMoreMessages,
              !isPaginationInFlight
        else { return false }

        triggerPagination(
            proxy: proxy,
            visibleMessages: visibleMessages,
            conversationId: conversationId,
            loadPreviousMessagePage: loadPreviousMessagePage
        )
        return true
    }

    /// Handles an accepted distance-from-bottom value (finite, past dead-zone).
    /// Returns true if a direct scroll-to-bottom was issued (first measurement after conversation switch).
    @discardableResult
    func handleAcceptedAnchorMinY(
        accepted: CGFloat,
        scrollViewportHeight: CGFloat,
        anchorMessageId: UUID?,
        proxy: ScrollViewProxy,
        conversationId: UUID?,
        messages: [ChatMessage],
        isNearBottom: Bool,
        containerWidth: CGFloat,
        highlightedMessageId: UUID?
    ) -> Bool {
        recordScrollLoopEvent(.anchorPreferenceChange, conversationId: conversationId, isNearBottom: isNearBottom, scrollViewportHeight: scrollViewportHeight)
        updateAnchor(distanceFromBottom: accepted, viewportHeight: scrollViewportHeight)
        var didDirectScroll = false
        let convIdString = conversationId?.uuidString ?? "unknown"
        if !hasFreshAnchorMeasurement {
            hasFreshAnchorMeasurement = true
            if !hasReceivedScrollEvent && anchorMessageId == nil
                && !scrollLoopGuard.isTripped(conversationId: convIdString)
            {
                proxy.scrollTo("scroll-bottom-anchor", anchor: .bottom)
                didDirectScroll = true
            }
        }
        scheduleTranscriptSnapshot(
            conversationId: conversationId,
            messages: messages,
            isNearBottom: isNearBottom,
            scrollViewportHeight: scrollViewportHeight,
            containerWidth: containerWidth,
            anchorMessageId: anchorMessageId,
            highlightedMessageId: highlightedMessageId
        )
        return didDirectScroll
    }

    /// Resets state for a conversation switch.
    func resetForConversationSwitch(
        oldConversationId: UUID?,
        newConversationId: UUID?,
        isSending: Bool,
        assistantActivityPhase: String
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
