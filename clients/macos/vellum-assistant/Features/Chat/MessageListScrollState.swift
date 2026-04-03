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
    /// Preserved during `.stabilizing` when the user was already scrolled
    /// up — prevents the CTA from flashing off during expansion/resize
    /// stabilization windows.
    var showsScrollToLatest: Bool {
        switch self {
        case .freeBrowsing: true
        case .stabilizing(let prev, _) where prev == .freeBrowsing: true
        default: false
        }
    }

}

enum ProgrammaticScrollReason: Equatable, CustomStringConvertible {
    case deepLinkAnchor(id: UUID)

    var description: String {
        switch self {
        case .deepLinkAnchor(let id): "deepLinkAnchor(\(id))"
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
/// Each UI-facing property (`showScrollToLatest`, `scrollIndicatorsHidden`)
/// is individually tracked by the Observation framework, so SwiftUI only
/// re-evaluates views that read the specific property that changed. The
/// `mode` enum drives all scroll behavior decisions through explicit
/// transitions rather than scattered handler logic.
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

    // MARK: - Geometry State (never trigger re-evaluation)

    /// Current scroll phase from `onScrollPhaseChange`.
    /// Reset to `.idle` in `reset()` to prevent stale phases from a
    /// previous conversation (e.g. `.interacting`, `.decelerating`)
    /// blocking `phaseAllowsAutoFollow` during the new conversation's
    /// critical materialization window.
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

    /// The ID of the last message in the current conversation's ForEach.
    /// Used as the primary scroll-to-bottom target because ForEach items
    /// are always indexable by `ScrollPosition.scrollTo(id:)` even when
    /// not materialized — SwiftUI can locate them in the data source and
    /// compute their position. The standalone `"scroll-bottom-anchor"`
    /// view (outside ForEach) is only locatable when materialized.
    @ObservationIgnored var lastMessageId: UUID?

    /// Content height from scroll geometry.
    @ObservationIgnored var scrollContentHeight: CGFloat = 0

    /// Container (viewport) height from scroll geometry.
    @ObservationIgnored var scrollContainerHeight: CGFloat = 0

    /// Deadline until which the persistent bottom-recovery fires
    /// unconditionally (ignoring `isAtBottom`). Set by `reset()` and
    /// `handleAppear` to cover the LazyVStack materialization window
    /// where estimated content height can be wrong, making `isAtBottom`
    /// unreliable. After the deadline, the recovery falls back to the
    /// normal `!isAtBottom` check.
    @ObservationIgnored var recoveryDeadline: Date?

    /// Whether the "scroll-bottom-anchor" view has appeared in the view
    /// hierarchy since the last `reset()`. Until this is true, `isAtBottom`
    /// is unreliable because it's based on LazyVStack's estimated content
    /// height — the viewport may be at the *estimated* bottom (blank space)
    /// where `distanceFromBottom ≈ 0`. The persistent recovery fires
    /// unconditionally until this flag is set by the anchor's `onAppear`.
    @ObservationIgnored var bottomAnchorAppeared: Bool = false

    // MARK: - Layout Cache Fields

    @ObservationIgnored var cachedLayoutKey: PrecomputedCacheKey?
    @ObservationIgnored var cachedLayoutMetadata: CachedMessageLayoutMetadata?
    @ObservationIgnored var messageListVersion: Int = 0
    @ObservationIgnored var lastKnownRawMessageCount: Int = 0
    @ObservationIgnored var lastKnownVisibleMessageCount: Int = 0
    @ObservationIgnored var lastKnownLastMessageStreaming: Bool = false
    @ObservationIgnored var lastKnownIncompleteToolCallCount: Int = 0
    @ObservationIgnored var lastKnownVisibleIdFingerprint: Int = 0
    @ObservationIgnored var cachedFirstVisibleMessageId: UUID?

    // MARK: - Scroll Action Closures

    /// Closure that performs a programmatic scroll to the given item ID and
    /// anchor point. Set once during view configuration and captures the
    /// view-owned `ScrollPosition` binding.
    @ObservationIgnored var scrollTo: ((_ id: any Hashable, _ anchor: UnitPoint?) -> Void)?

    /// Closure that scrolls to a given edge (e.g. `.bottom`).
    @ObservationIgnored var scrollToEdge: ((_ edge: Edge) -> Void)?

    /// Pending ID-based scroll Task from `executeScrollToBottom`.
    /// Tracked so it can be cancelled on mode changes (user scroll-up),
    /// conversation switches (`reset`), and view teardown (`cancelAll`).
    /// Prevents accumulation of stale Tasks across rapid switches.
    @ObservationIgnored private var pendingIdScrollTask: Task<Void, Never>?

    // MARK: - Circuit Breaker

    @ObservationIgnored private var bodyEvalTimestamps: [CFAbsoluteTime] = []
    @ObservationIgnored private(set) var isThrottled = false
    @ObservationIgnored var cachedDerivedStateBox: Any?
    @ObservationIgnored private var throttleRecoveryTask: Task<Void, Never>?

    /// Called once per MessageListView body evaluation. Trips the circuit
    /// breaker when >100 evaluations occur in 2 seconds, suppressing
    /// `scheduleUISync()` for 500ms to break the loop.
    func recordBodyEvaluation() {
        let now = CFAbsoluteTimeGetCurrent()
        bodyEvalTimestamps.append(now)
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

    /// Debounces observed-property updates so rapid mode changes coalesce
    /// into at most one view re-evaluation per frame.
    func scheduleUISync() {
        guard !isThrottled else { return }
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
        let newScrollIndicatorsHidden = _hideScrollIndicators

        var changed = false

        if showScrollToLatest != newShowScrollToLatest {
            showScrollToLatest = newShowScrollToLatest
            changed = true
        }
        if scrollIndicatorsHidden != newScrollIndicatorsHidden {
            scrollIndicatorsHidden = newScrollIndicatorsHidden
            changed = true
        }

        if changed { uiVersion &+= 1 }
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

    /// Timeout task for expansion stabilization — auto-ends after 200ms.
    @ObservationIgnored private var expansionTimeoutTask: Task<Void, Never>?

    /// Tracks overlapping stabilization windows. Stabilization only ends
    /// when all active windows have completed, so concurrent reasons
    /// (e.g. resize during pagination) don't prematurely restore the mode.
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
        default:
            break
        }

        mode = newMode
        scheduleUISync()
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
        case .stabilizing(let prev, _):
            previousMode = prev
        case .programmaticScroll:
            return
        }

        activeStabilizationCount += 1
        transition(to: .stabilizing(previousMode: previousMode, reason: reason))

        if reason == .expansion {
            expansionTimeoutTask?.cancel()
            expansionTimeoutTask = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 200_000_000)
                guard !Task.isCancelled, let self else { return }
                self.endStabilization()
            }
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

    // MARK: - Scroll Execution

    /// Executes a bottom-pin scroll if the current mode allows it.
    /// Returns `true` if the scroll was performed.
    ///
    /// `userInitiated: true` bypasses mode checks — user intent always wins.
    @discardableResult
    func requestPinToBottom(animated: Bool = false, userInitiated: Bool = false) -> Bool {
        if userInitiated {
            transition(to: .followingBottom)
            // Sync UI immediately so showScrollToLatest is updated within
            // the caller's withAnimation block — this animates the CTA's
            // exit transition (.move + .opacity) in sync with the scroll.
            syncUIImmediately()
            // Start a fresh recovery window — the scroll-to-bottom might
            // miss on first attempt (e.g. lastMessageId stale, anchor not
            // materialized). Without this, no recovery fires because
            // bottomAnchorAppeared is already true (from initial load)
            // and the recovery deadline has passed.
            bottomAnchorAppeared = false
            recoveryDeadline = Date().addingTimeInterval(2.0)
            executeScrollToBottom(animated: animated, userInitiated: true)
            return true
        }

        guard mode.allowsAutoScroll else { return false }
        executeScrollToBottom(animated: animated)
        return true
    }

    /// Low-level scroll-to-bottom execution. Does not check mode.
    ///
    /// Two strategies depending on context:
    ///
    /// **User-initiated (CTA tap):** ID-based scroll primary, with
    /// edge-based correction. `scrollTo(id: lastMessageId, .bottom)`
    /// fires synchronously — targets a real ForEach item that SwiftUI
    /// can always locate (even when not materialized), so it never
    /// overshoots into blank LazyVStack estimated space. An edge-based
    /// `scrollToEdge(.bottom)` fires on the next run-loop pass to close
    /// the small gap between the last message and the absolute content
    /// bottom (padding/anchor below). If the user scrolls up before the
    /// edge correction, they start from real content. Animation is
    /// provided by the caller's `withAnimation` wrapper (spring for
    /// smooth CTA scroll). The recovery window (set in
    /// `requestPinToBottom`) handles failures.
    ///
    /// **Auto-follow / recovery:** Dual scroll strategy — edge-based
    /// fires immediately (fast for near-bottom adjustments), ID-based
    /// fires on the next run-loop pass via Task (corrects edge overshoot).
    /// The two MUST run in separate transactions — within a single
    /// synchronous block, the second ScrollPosition mutation overwrites
    /// the first.
    ///
    /// - SeeAlso: https://stackoverflow.com/q/79884780 (ScrollPosition unreliable with variable heights)
    /// - SeeAlso: https://developer.apple.com/documentation/swiftui/scrollposition/scrollto(edge:)
    private func executeScrollToBottom(animated: Bool, userInitiated: Bool = false) {
        if userInitiated {
            // ID-based primary: targets a real ForEach item that SwiftUI
            // can always locate — never overshoots into blank LazyVStack
            // estimated space. If the user scrolls up immediately after
            // tapping, they start from real content (not blank space).
            // Animated with spring from the caller's withAnimation wrapper.
            pendingIdScrollTask?.cancel()
            let target: any Hashable = lastMessageId ?? ("scroll-bottom-anchor" as any Hashable)
            scrollTo?(target, .bottom)
            // Edge-based correction on the next run loop: closes the
            // small gap between the last message and the absolute content
            // bottom (padding/anchor below the last ForEach item).
            // If the user scrolls up before this fires, it's cancelled
            // by handleUserScrollUp — but the viewport is already at
            // real content, so no blank screen.
            // The recovery window (set in requestPinToBottom) provides
            // an additional 2-second safety net for any remaining gap.
            let edgeScroll = scrollToEdge
            pendingIdScrollTask = Task { @MainActor [weak self] in
                guard let self, !Task.isCancelled else { return }
                guard self.mode.allowsAutoScroll else { return }
                edgeScroll?(.bottom)
                self.pendingIdScrollTask = nil
            }
            return
        }

        // Auto-follow / recovery: dual scroll strategy.
        // Transaction 1: edge-based (immediate)
        if animated {
            withAnimation(VAnimation.fast) {
                scrollToEdge?(.bottom)
            }
        } else {
            scrollToEdge?(.bottom)
        }
        // Transaction 2: ID-based (next run-loop pass)
        // Cancel any previously pending ID scroll to prevent accumulation
        // across rapid conversation switches or recovery-window calls.
        pendingIdScrollTask?.cancel()
        let idScroll = scrollTo
        // Prefer the last ForEach message ID — ForEach items are always
        // indexable by ScrollPosition even when not materialized, because
        // SwiftUI can locate them in the data source and compute their
        // estimated position. The standalone "scroll-bottom-anchor" view
        // (outside ForEach) is only locatable when already materialized.
        let primaryTarget: any Hashable = lastMessageId ?? ("scroll-bottom-anchor" as any Hashable)
        pendingIdScrollTask = Task { @MainActor [weak self] in
            guard let self, !Task.isCancelled else { return }
            // If the user scrolled up (freeBrowsing) between creation
            // and execution, this scroll is stale — skip it.
            guard self.mode.allowsAutoScroll else { return }
            if animated {
                withAnimation(VAnimation.fast) {
                    idScroll?(primaryTarget, .bottom)
                }
            } else {
                idScroll?(primaryTarget, .bottom)
            }
            self.pendingIdScrollTask = nil
        }
    }

    /// Performs a programmatic scroll to the given item ID and anchor point.
    func performScrollTo(_ id: any Hashable, anchor: UnitPoint? = nil) {
        scrollTo?(id, anchor)
    }

    // MARK: - Scroll Event Handling

    /// Handles user scrolling up — transitions to freeBrowsing if appropriate.
    func handleUserScrollUp() {
        // Cancel any pending ID-based scroll — user intent takes priority.
        pendingIdScrollTask?.cancel()
        pendingIdScrollTask = nil
        switch mode {
        case .initialLoad, .followingBottom:
            transition(to: .freeBrowsing)
        case .stabilizing:
            transition(to: .freeBrowsing)
        case .freeBrowsing, .programmaticScroll:
            break
        }
    }

    /// Handles the user arriving at the bottom of the scroll view.
    func handleReachedBottom() {
        switch mode {
        case .freeBrowsing, .initialLoad, .programmaticScroll:
            transition(to: .followingBottom)
        case .stabilizing:
            break
        case .followingBottom:
            break
        }
        scrollRestoreTask?.cancel()
        scrollRestoreTask = nil
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
        if _isPaginationInFlight { _isPaginationInFlight = false }
        wasPaginationTriggerInRange = false
        lastPaginationCompletedAt = .distantPast
        cachedLayoutKey = nil
        cachedLayoutMetadata = nil
        cachedDerivedStateBox = nil
        messageListVersion = 0
        lastKnownRawMessageCount = 0
        lastKnownVisibleMessageCount = 0
        lastKnownLastMessageStreaming = false
        lastKnownIncompleteToolCallCount = 0
        lastKnownVisibleIdFingerprint = 0
        currentConversationId = newConversationId
        lastMessageId = nil
        mode = .initialLoad
        activeStabilizationCount = 0
        // False: scroll geometry hasn't updated for the new content yet.
        isAtBottom = false
        lastContentOffsetY = 0
        scrollContentHeight = 0
        scrollContainerHeight = 0
        // Reset scroll phase — a stale .interacting/.decelerating from
        // the previous conversation would block phaseAllowsAutoFollow,
        // preventing all recovery and auto-follow during the new
        // conversation's critical materialization window.
        // onScrollPhaseChange may not fire for the new ScrollView's
        // initial .idle state (only fires on *changes*).
        scrollPhase = .idle
        // Reset anchor-appeared flag — the new conversation's bottom anchor
        // hasn't materialized yet. Until it does, isAtBottom is unreliable.
        bottomAnchorAppeared = false
        // Hard time limit for unconditional recovery. The primary signal
        // is bottomAnchorAppeared, but this prevents infinite recovery
        // in edge cases where the anchor never materializes.
        recoveryDeadline = Date().addingTimeInterval(2.0)
        pendingIdScrollTask?.cancel()
        pendingIdScrollTask = nil
        throttleRecoveryTask?.cancel()
        throttleRecoveryTask = nil
        isThrottled = false
        bodyEvalTimestamps.removeAll()
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
        pendingIdScrollTask?.cancel()
        pendingIdScrollTask = nil
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
        mode = .initialLoad
        activeStabilizationCount = 0
        cachedDerivedStateBox = nil
        lastPaginationCompletedAt = .distantPast
        syncUIImmediately()
    }
}
