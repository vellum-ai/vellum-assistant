import Foundation
import os
import SwiftUI
import VellumAssistantShared

// MARK: - ScrollMode

/// Explicit scroll behavior mode. Every scroll decision flows through the
/// current mode, eliminating implicit priority races between scattered
/// handlers. Inspired by ChatViewportKit's `ViewportMode` pattern.
///
/// References:
/// - ChatViewportKit: https://github.com/danielraffel/ChatViewportKit
/// - ScrollPosition: https://developer.apple.com/documentation/swiftui/scrollposition
/// - ScrollAnchorRole: https://developer.apple.com/documentation/swiftui/scrollanchorrole
enum ScrollMode: Equatable, CustomStringConvertible {
    /// Initial render — content starts at bottom, no user interaction yet.
    case initialLoad

    /// User is at the bottom. Auto-scroll on new content, streaming, etc.
    case followingBottom

    /// User scrolled away from bottom. No auto-scroll.
    /// "Scroll to latest" CTA is visible.
    case freeBrowsing

    /// User sent a message — anchor their message to viewport top.
    /// The tail spacer provides space below for the assistant's response.
    case pushToTop(messageId: UUID)

    /// A programmatic scroll is in flight (deep-link anchor, etc.).
    /// Prevents other scroll operations from interfering until complete.
    case programmaticScroll(reason: ProgrammaticScrollReason)

    /// Temporarily stabilizing after a layout change.
    /// Auto-scroll is paused until the stabilization window completes.
    case stabilizing(previousMode: StabilizedMode, reason: StabilizationReason)

    var description: String {
        switch self {
        case .initialLoad: "initialLoad"
        case .followingBottom: "followingBottom"
        case .freeBrowsing: "freeBrowsing"
        case .pushToTop(let id): "pushToTop(\(id))"
        case .programmaticScroll(let reason): "programmaticScroll(\(reason))"
        case .stabilizing(let prev, let reason): "stabilizing(\(prev), \(reason))"
        }
    }

    /// Whether the mode allows automatic bottom-pinning on new content.
    /// Both `initialLoad` and `followingBottom` allow auto-scroll —
    /// the only difference is `initialLoad` marks that no user interaction
    /// has occurred yet (used by `hasBeenInteracted`).
    /// Note: `stabilizing` returns `false` even when the previous mode was
    /// `followingBottom` — stabilization explicitly suppresses auto-scroll
    /// until the layout mutation completes.
    var allowsAutoScroll: Bool {
        switch self {
        case .initialLoad, .followingBottom: true
        default: false
        }
    }

    /// Whether the "Scroll to latest" CTA should be visible.
    var showsScrollToLatest: Bool {
        switch self {
        case .freeBrowsing: true
        default: false
        }
    }

    /// Whether the tail spacer should be rendered for push-to-top.
    var showsTailSpacer: Bool {
        switch self {
        case .pushToTop: true
        default: false
        }
    }

    /// The push-to-top message ID, if in push-to-top mode.
    var pushToTopMessageId: UUID? {
        if case .pushToTop(let id) = self { return id }
        return nil
    }
}

enum ProgrammaticScrollReason: Equatable, CustomStringConvertible {
    case deepLinkAnchor(id: UUID)
    case conversationSwitch
    case scrollRestore

    var description: String {
        switch self {
        case .deepLinkAnchor(let id): "deepLinkAnchor(\(id))"
        case .conversationSwitch: "conversationSwitch"
        case .scrollRestore: "scrollRestore"
        }
    }
}

enum StabilizationReason: Equatable, CustomStringConvertible {
    case resize
    case expansion
    case pagination

    var description: String {
        switch self {
        case .resize: "resize"
        case .expansion: "expansion"
        case .pagination: "pagination"
        }
    }
}

/// The mode the scroll was in before entering `stabilizing`.
/// Only tracks modes that can transition into stabilizing.
enum StabilizedMode: Equatable, CustomStringConvertible {
    case followingBottom
    case freeBrowsing

    var description: String {
        switch self {
        case .followingBottom: "followingBottom"
        case .freeBrowsing: "freeBrowsing"
        }
    }
}

private let scrollLog = Logger(subsystem: Bundle.appBundleIdentifier, category: "ScrollState")

// MARK: - MessageListScrollState

/// Centralized scroll state machine with `@Observable` fine-grained tracking.
/// Each UI-facing property (`showTailSpacer`, `showScrollToLatest`,
/// `scrollIndicatorsHidden`) is individually tracked by the Observation
/// framework, so SwiftUI only re-evaluates views that read the specific
/// property that changed. The `mode` enum drives all scroll behavior
/// decisions through explicit transitions rather than scattered handler logic.
///
/// References:
/// - [WWDC23 — Discover Observation in SwiftUI](https://developer.apple.com/videos/play/wwdc2023/10149/)
/// - [Observation framework](https://developer.apple.com/documentation/observation)
@Observable @MainActor
final class MessageListScrollState {

    // MARK: - Mode (single source of truth for scroll behavior)

    /// The current scroll behavior mode. All scroll decisions check this
    /// before executing. Transitions are logged for debugging.
    @ObservationIgnored private(set) var mode: ScrollMode = .initialLoad

    // MARK: - UI State (fine-grained per-property observation)

    /// Internal counter for debounce tracking and diagnostics.
    /// Not observed by any view — individual properties below are tracked
    /// independently by the Observation framework.
    @ObservationIgnored private(set) var uiVersion: UInt64 = 0

    /// Whether the "Scroll to latest" CTA should be visible.
    /// Tracked independently — only views reading this property re-evaluate.
    private(set) var showScrollToLatest = false

    /// Whether the tail spacer should render for push-to-top.
    /// Tracked independently — only `TailSpacerView` re-evaluates on change.
    private(set) var showTailSpacer = false

    /// Whether scroll indicators should be hidden.
    /// Tracked independently — only the scroll indicator modifier re-evaluates.
    private(set) var scrollIndicatorsHidden = false

    // MARK: - Scroll Indicator Visibility

    /// Whether scroll indicators should be temporarily hidden during a
    /// conversation switch. LazyVStack content size estimation causes the
    /// scrollbar to visibly resize as views materialize with varying heights;
    /// hiding the indicators during the initial layout window masks this.
    @ObservationIgnored private var _hideScrollIndicators = false

    var hideScrollIndicators: Bool {
        get { _hideScrollIndicators }
        set { _hideScrollIndicators = newValue; scheduleUISync() }
    }

    // MARK: - Pagination

    /// Guards the pagination sentinel against re-entry during the brief window
    /// between Task launch and the first `await`.
    @ObservationIgnored private var _isPaginationInFlight = false

    var isPaginationInFlight: Bool {
        get { _isPaginationInFlight }
        set { _isPaginationInFlight = newValue }
    }

    // MARK: - Computed Properties

    /// Height of the tail spacer when visible during push-to-top.
    /// Subtracted from content height for overflow and bottom detection
    /// so those computations operate on effective content height.
    var tailSpacerHeight: CGFloat {
        guard mode.pushToTopMessageId != nil else { return 0 }
        let h = viewportHeight
        // Account for LazyVStack inter-item spacing so the spacer
        // doesn't overshoot by one spacing unit.
        return h.isFinite ? max(0, h - VSpacing.md) : 0
    }

    // MARK: - Geometry State (never trigger re-evaluation)

    /// Current scroll phase from `onScrollPhaseChange`.
    @ObservationIgnored var scrollPhase: ScrollPhase = .idle

    /// Last content offset Y observed by onScrollGeometryChange.
    @ObservationIgnored var lastContentOffsetY: CGFloat = 0

    /// Whether the user is within the bottom dead-zone of the conversation.
    @ObservationIgnored var isAtBottom: Bool = true

    /// The most recent scroll viewport height.
    @ObservationIgnored var viewportHeight: CGFloat = .infinity

    /// Tracks whether the pagination sentinel was previously inside the trigger band.
    @ObservationIgnored var wasPaginationTriggerInRange: Bool = false

    /// Timestamp of the last pagination completion, used to enforce a 500ms
    /// cooldown between successive pagination fires.
    @ObservationIgnored var lastPaginationCompletedAt: Date = .distantPast

    /// The conversation ID currently being displayed.
    @ObservationIgnored var currentConversationId: UUID?

    /// Captures the `assistantActivityPhase` at the moment `isSending` goes false.
    @ObservationIgnored var lastActivityPhaseWhenIdle: String = ""

    /// Last container width that triggered a resize scroll handler.
    @ObservationIgnored var lastHandledContainerWidth: CGFloat = 0

    /// Tracks the last pending confirmation request ID that triggered an
    /// auto-focus handoff.
    @ObservationIgnored var lastAutoFocusedRequestId: String?

    /// Content height from scroll geometry.
    @ObservationIgnored var scrollContentHeight: CGFloat = 0

    /// Container (viewport) height from scroll geometry.
    @ObservationIgnored var scrollContainerHeight: CGFloat = 0

    // MARK: - Layout Cache Fields

    /// Memoization state intentionally lives outside the observed object so
    /// `MessageListView` can update caches during body evaluation without
    /// tripping SwiftUI's "Modifying state during view update" runtime guard.
    @ObservationIgnored let derivedStateCache = MessageListDerivedStateCache()

    @ObservationIgnored var cachedLayoutKey: PrecomputedCacheKey? {
        get { derivedStateCache.cachedLayoutKey }
        set { derivedStateCache.cachedLayoutKey = newValue }
    }

    @ObservationIgnored var cachedLayoutMetadata: CachedMessageLayoutMetadata? {
        get { derivedStateCache.cachedLayoutMetadata }
        set { derivedStateCache.cachedLayoutMetadata = newValue }
    }

    @ObservationIgnored var messageListVersion: Int {
        get { derivedStateCache.messageListVersion }
        set { derivedStateCache.messageListVersion = newValue }
    }

    @ObservationIgnored var lastKnownRawMessageCount: Int {
        get { derivedStateCache.lastKnownRawMessageCount }
        set { derivedStateCache.lastKnownRawMessageCount = newValue }
    }

    @ObservationIgnored var lastKnownVisibleMessageCount: Int {
        get { derivedStateCache.lastKnownVisibleMessageCount }
        set { derivedStateCache.lastKnownVisibleMessageCount = newValue }
    }

    @ObservationIgnored var lastKnownLastMessageStreaming: Bool {
        get { derivedStateCache.lastKnownLastMessageStreaming }
        set { derivedStateCache.lastKnownLastMessageStreaming = newValue }
    }

    @ObservationIgnored var lastKnownIncompleteToolCallCount: Int {
        get { derivedStateCache.lastKnownIncompleteToolCallCount }
        set { derivedStateCache.lastKnownIncompleteToolCallCount = newValue }
    }

    @ObservationIgnored var lastKnownVisibleIdFingerprint: Int {
        get { derivedStateCache.lastKnownVisibleIdFingerprint }
        set { derivedStateCache.lastKnownVisibleIdFingerprint = newValue }
    }

    @ObservationIgnored var cachedFirstVisibleMessageId: UUID? {
        get { derivedStateCache.cachedFirstVisibleMessageId }
        set { derivedStateCache.cachedFirstVisibleMessageId = newValue }
    }

    // MARK: - Scroll Action Closures

    /// Closure that performs a programmatic scroll to the given item ID and
    /// anchor point. Set once during view configuration and captures the
    /// view-owned `ScrollPosition` binding.
    @ObservationIgnored var scrollTo: ((_ id: any Hashable, _ anchor: UnitPoint?) -> Void)?

    /// Closure that scrolls to a given edge (e.g. `.bottom`).
    @ObservationIgnored var scrollToEdge: ((_ edge: Edge) -> Void)?

    // MARK: - Circuit Breaker

    @ObservationIgnored var isThrottled: Bool {
        get { derivedStateCache.isThrottled }
        set { derivedStateCache.isThrottled = newValue }
    }

    /// Called once per MessageListView body evaluation. Trips the circuit
    /// breaker when >100 evaluations occur in 2 seconds, suppressing
    /// `scheduleUISync()` for 500ms to break the loop.
    func recordBodyEvaluation() {
        let cache = derivedStateCache
        let now = CFAbsoluteTimeGetCurrent()
        cache.bodyEvalTimestamps.append(now)
        let cutoff = now - 2.0
        if let firstValid = cache.bodyEvalTimestamps.firstIndex(where: { $0 >= cutoff }) {
            cache.bodyEvalTimestamps.removeFirst(firstValid)
        }

        if cache.bodyEvalTimestamps.count > 100 && !cache.isThrottled {
            cache.isThrottled = true
            os_log(.fault, "Scroll re-evaluation loop detected: %d evals in 2s — throttling for 500ms",
                   cache.bodyEvalTimestamps.count)
            cache.throttleRecoveryTask?.cancel()
            cache.throttleRecoveryTask = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 500_000_000)
                guard let self, !Task.isCancelled else { return }
                self.derivedStateCache.isThrottled = false
                self.derivedStateCache.bodyEvalTimestamps.removeAll()
                self.derivedStateCache.throttleRecoveryTask = nil
                self.scheduleUISync()
            }
        }
    }

    // MARK: - Debounced UI Sync

    @ObservationIgnored private var uiSyncTask: Task<Void, Never>?

    /// Debounces observed-property updates so rapid mode changes coalesce
    /// into at most one view re-evaluation per frame.
    func scheduleUISync() {
        guard !derivedStateCache.isThrottled else { return }
        uiSyncTask?.cancel()
        uiSyncTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 16_000_000)
            guard let self, !Task.isCancelled else { return }
            self.syncUISnapshots()
            self.uiSyncTask = nil
        }
    }

    /// Syncs snapshot properties from the current mode. Each property is
    /// individually tracked by `@Observable`, so SwiftUI only re-evaluates
    /// views that read the specific property that changed.
    private func syncUISnapshots() {
        let newShowScrollToLatest = mode.showsScrollToLatest
        let newShowTailSpacer = mode.showsTailSpacer
        let newScrollIndicatorsHidden = _hideScrollIndicators

        let tailSpacerWasShowing = showTailSpacer
        var changed = false

        if showScrollToLatest != newShowScrollToLatest {
            showScrollToLatest = newShowScrollToLatest
            changed = true
        }
        if showTailSpacer != newShowTailSpacer {
            showTailSpacer = newShowTailSpacer
            changed = true
        }
        if scrollIndicatorsHidden != newScrollIndicatorsHidden {
            scrollIndicatorsHidden = newScrollIndicatorsHidden
            changed = true
        }

        if changed { uiVersion &+= 1 }

        // Re-enter push-to-top: tail spacer was already rendered, so consume
        // the pending target immediately without waiting for onAppear.
        if tailSpacerWasShowing && newShowTailSpacer {
            consumePendingPushToTop()
        }
    }

    /// Synchronous UI sync — bypasses debounce for instant state transitions.
    func syncUIImmediately() {
        uiSyncTask?.cancel()
        uiSyncTask = nil
        syncUISnapshots()
    }

    // MARK: - Task References

    @ObservationIgnored var paginationTask: Task<Void, Never>?
    @ObservationIgnored var scrollRestoreTask: Task<Void, Never>?
    @ObservationIgnored var highlightDismissTask: Task<Void, Never>?
    @ObservationIgnored var scrollIndicatorRestoreTask: Task<Void, Never>?
    @ObservationIgnored var anchorTimeoutTask: Task<Void, Never>?
    @ObservationIgnored var pendingScrollGeometrySnapshot: ScrollGeometrySnapshot?
    @ObservationIgnored var scrollGeometryDispatchTask: Task<Void, Never>?

    /// The message ID awaiting a deferred scroll-to-top. Set when entering
    /// `pushToTop` mode and consumed by `TailSpacerView.onAppear` (fresh
    /// push-to-top) or `syncUISnapshots` (re-enter when spacer is already
    /// rendered).
    @ObservationIgnored var pendingPushToTopTarget: UUID?

    /// Timeout task for expansion stabilization — auto-ends after 200ms.
    @ObservationIgnored private var expansionTimeoutTask: Task<Void, Never>?

    /// Tracks overlapping stabilization windows. Stabilization only ends
    /// when all active windows have completed, so concurrent reasons
    /// (e.g. resize during pagination) don't prematurely restore the mode.
    /// Re-entering the same reason increments the count like any other entry.
    /// Callers are structured so that each `beginStabilization` has a matching
    /// `endStabilization` (cancelled task cleanup for resize, preceding
    /// `endStabilization` in `suppressAutoScroll` for expansion).
    @ObservationIgnored private var activeStabilizationCount = 0

    // MARK: - Deep-Link Anchor Tracking

    @ObservationIgnored var anchorSetTime: Date?

    // MARK: - Mode Transitions

    /// Transitions to a new scroll mode. Performs exit actions for the
    /// old mode and entry actions for the new mode.
    func transition(to newMode: ScrollMode) {
        let oldMode = mode
        guard oldMode != newMode else { return }

        scrollLog.debug("Scroll mode: \(oldMode.description) → \(newMode.description)")

        // Exit actions
        switch oldMode {
        case .stabilizing:
            cancelStabilizationTasks()
        case .pushToTop:
            pendingPushToTopTarget = nil
        default:
            break
        }

        mode = newMode
        scheduleUISync()
    }

    /// Enters push-to-top mode for the given message ID. Sets up the
    /// deferred scroll target that will fire after the tail spacer renders
    /// (via `TailSpacerView.onAppear`) or immediately if already showing
    /// (via `syncUISnapshots`).
    func enterPushToTop(messageId: UUID) {
        transition(to: .pushToTop(messageId: messageId))
        pendingPushToTopTarget = messageId
        syncUIImmediately()
    }

    /// Consumes a pending push-to-top scroll target. Called from
    /// `TailSpacerView.onAppear` (fresh push-to-top, guaranteeing the spacer
    /// is in the view tree) or from `syncUISnapshots` (re-enter case where
    /// the spacer was already rendered).
    func consumePendingPushToTop() {
        guard let targetId = pendingPushToTopTarget,
              mode.pushToTopMessageId != nil else { return }
        pendingPushToTopTarget = nil
        withAnimation(VAnimation.fast) {
            performScrollTo(targetId, anchor: .top)
        }
    }

    /// Exits push-to-top and transitions to followingBottom with a
    /// bottom-pin scroll.
    func exitPushToTop(animated: Bool = true) {
        let wasPushToTop = mode.pushToTopMessageId != nil
        transition(to: .followingBottom)
        if wasPushToTop {
            executeScrollToBottom(animated: animated)
        }
    }

    /// Enters stabilizing mode, remembering the previous mode to restore
    /// after all stabilization windows have ended.
    func beginStabilization(_ reason: StabilizationReason) {
        let previousMode: StabilizedMode
        switch mode {
        case .followingBottom, .initialLoad:
            previousMode = .followingBottom
        case .freeBrowsing:
            previousMode = .freeBrowsing
        case .stabilizing(let prev, let activeReason):
            previousMode = prev
            if activeReason == reason {
                if reason == .expansion {
                    scheduleExpansionTimeout()
                }
                return
            }
        case .pushToTop, .programmaticScroll:
            return
        }

        activeStabilizationCount += 1
        transition(to: .stabilizing(previousMode: previousMode, reason: reason))

        if reason == .expansion {
            scheduleExpansionTimeout()
        }
    }

    /// Ends one stabilization window. Only restores the previous mode
    /// when all overlapping windows have completed.
    func endStabilization() {
        guard case .stabilizing(let previousMode, _) = mode else { return }
        activeStabilizationCount = max(0, activeStabilizationCount - 1)
        guard activeStabilizationCount == 0 else { return }
        cancelStabilizationTasks()
        switch previousMode {
        case .followingBottom:
            transition(to: .followingBottom)
        case .freeBrowsing:
            transition(to: .freeBrowsing)
        }
    }

    private func cancelStabilizationTasks() {
        expansionTimeoutTask?.cancel()
        expansionTimeoutTask = nil
    }

    private func scheduleExpansionTimeout() {
        expansionTimeoutTask?.cancel()
        expansionTimeoutTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 200_000_000)
            guard !Task.isCancelled, let self else { return }
            self.endStabilization()
        }
    }

    // MARK: - Scroll Execution

    /// Executes a bottom-pin scroll if the current mode allows it.
    /// Returns `true` if the scroll was performed.
    ///
    /// `userInitiated: true` bypasses mode checks — user intent always wins.
    @discardableResult
    func requestPinToBottom(animated: Bool = false, userInitiated: Bool = false) -> Bool {
        if userInitiated {
            transition(to: .followingBottom)
            executeScrollToBottom(animated: animated)
            return true
        }

        guard mode.allowsAutoScroll else { return false }
        executeScrollToBottom(animated: animated)
        return true
    }

    /// Low-level scroll-to-bottom execution. Does not check mode.
    private func executeScrollToBottom(animated: Bool) {
        if animated {
            withAnimation(VAnimation.fast) {
                performScrollTo("scroll-bottom-anchor", anchor: .bottom)
            }
        } else {
            performScrollTo("scroll-bottom-anchor", anchor: .bottom)
        }
    }

    /// Performs a programmatic scroll to the given item ID and anchor point.
    func performScrollTo(_ id: any Hashable, anchor: UnitPoint? = nil) {
        scrollTo?(id, anchor)
    }

    // MARK: - Scroll Event Handling

    /// Handles user scrolling up — transitions to freeBrowsing if appropriate.
    func handleUserScrollUp() {
        switch mode {
        case .initialLoad, .followingBottom:
            transition(to: .freeBrowsing)
        case .stabilizing:
            transition(to: .freeBrowsing)
        case .freeBrowsing, .pushToTop, .programmaticScroll:
            break
        }
    }

    /// Handles the user arriving at the bottom of the scroll view.
    func handleReachedBottom() {
        switch mode {
        case .freeBrowsing, .pushToTop, .initialLoad, .programmaticScroll:
            transition(to: .followingBottom)
        case .stabilizing:
            break
        case .followingBottom:
            break
        }
        scrollRestoreTask?.cancel()
        scrollRestoreTask = nil
    }

    /// Handles push-to-top overflow detection.
    @discardableResult
    func handlePushToTopOverflow() -> Bool {
        guard mode.pushToTopMessageId != nil else { return false }
        exitPushToTop(animated: true)
        return true
    }

    // MARK: - Convenience Queries

    /// Whether the mode allows automatic bottom-pinning.
    var isFollowingBottom: Bool {
        switch mode {
        case .followingBottom: true
        case .stabilizing(let prev, _): prev == .followingBottom
        default: false
        }
    }

    /// Whether the scroll system has received initial interaction.
    var hasBeenInteracted: Bool {
        if case .initialLoad = mode { return false }
        return true
    }

    /// Whether auto-scroll is currently suppressed (stabilizing mode).
    var isSuppressed: Bool {
        if case .stabilizing = mode { return true }
        return false
    }

    // MARK: - Lifecycle Methods

    /// Resets state for a conversation switch.
    func reset(for newConversationId: UUID?) {
        cancelStabilizationTasks()
        paginationTask?.cancel()
        paginationTask = nil
        scrollGeometryDispatchTask?.cancel()
        scrollGeometryDispatchTask = nil
        pendingScrollGeometrySnapshot = nil
        if _isPaginationInFlight { _isPaginationInFlight = false }
        wasPaginationTriggerInRange = false
        lastPaginationCompletedAt = .distantPast
        derivedStateCache.reset()
        currentConversationId = newConversationId
        mode = .initialLoad
        activeStabilizationCount = 0
        pendingPushToTopTarget = nil
        // False: scroll geometry hasn't updated for the new content yet.
        isAtBottom = false
        lastContentOffsetY = 0
        scrollIndicatorRestoreTask?.cancel()
        if !_hideScrollIndicators { _hideScrollIndicators = true }
        syncUIImmediately()
        scrollIndicatorRestoreTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard !Task.isCancelled, let self else { return }
            if self._hideScrollIndicators { self._hideScrollIndicators = false }
            self.syncUIImmediately()
            self.scrollIndicatorRestoreTask = nil
        }
    }

    /// Cancel all tasks and reset mode. Called from `onDisappear`.
    func cancelAll() {
        cancelStabilizationTasks()
        uiSyncTask?.cancel()
        uiSyncTask = nil
        scrollRestoreTask?.cancel()
        scrollRestoreTask = nil
        paginationTask?.cancel()
        paginationTask = nil
        scrollGeometryDispatchTask?.cancel()
        scrollGeometryDispatchTask = nil
        pendingScrollGeometrySnapshot = nil
        anchorTimeoutTask?.cancel()
        anchorTimeoutTask = nil
        highlightDismissTask?.cancel()
        highlightDismissTask = nil
        scrollIndicatorRestoreTask?.cancel()
        scrollIndicatorRestoreTask = nil
        derivedStateCache.reset()
        if _hideScrollIndicators { _hideScrollIndicators = false }
        pendingPushToTopTarget = nil
        if _isPaginationInFlight { _isPaginationInFlight = false }
        mode = .initialLoad
        activeStabilizationCount = 0
        lastPaginationCompletedAt = .distantPast
        syncUIImmediately()
    }
}
