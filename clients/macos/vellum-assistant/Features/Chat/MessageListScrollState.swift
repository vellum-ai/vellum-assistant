import Foundation
import SwiftUI
import VellumAssistantShared

// MARK: - MessageListScrollState

/// Flat scroll coordinator — tracks geometry, distance-based scroll-to-latest
/// visibility, pagination sentinel, and deep-link anchor state. No mode
/// transitions, stabilization, or recovery logic.
@Observable @MainActor
final class MessageListScrollState {

    // MARK: - Observed (drives view updates)

    /// Whether the "Scroll to latest" CTA should be visible.
    /// Driven by distance from bottom (>400pt).
    private(set) var showScrollToLatest: Bool = false

    /// Whether scroll indicators should be temporarily hidden.
    private(set) var scrollIndicatorsHidden: Bool = false

    /// The newest non-queued user message that anchors the pinned latest-turn
    /// section. The spacer layout keeps this row at the top of the viewport
    /// while newer assistant content grows below it.
    var pinnedLatestTurnAnchorMessageId: UUID?

    // MARK: - Geometry (not observed, updated by scroll handler)

    @ObservationIgnored var scrollContentHeight: CGFloat = 0
    @ObservationIgnored var scrollContainerHeight: CGFloat = 0
    @ObservationIgnored var lastContentOffsetY: CGFloat = 0
    @ObservationIgnored var viewportHeight: CGFloat = .infinity

    // MARK: - State

    @ObservationIgnored var currentConversationId: UUID?
    @ObservationIgnored var lastMessageId: UUID?
    @ObservationIgnored var lastActivityPhaseWhenIdle: String = ""
    // MARK: - Deep-link anchor

    @ObservationIgnored var anchorSetTime: Date?
    @ObservationIgnored var anchorTimeoutTask: Task<Void, Never>?

    // MARK: - Pagination

    @ObservationIgnored var wasPaginationTriggerInRange: Bool = false
    @ObservationIgnored var lastPaginationCompletedAt: Date = .distantPast

    // MARK: - Scroll indicator hide

    @ObservationIgnored var scrollIndicatorRestoreTask: Task<Void, Never>?

    // MARK: - Confirmation focus

    @ObservationIgnored var lastAutoFocusedRequestId: String?

    // MARK: - Derived state cache (rendering, not scroll)

    @ObservationIgnored let derivedStateCache = ProjectionCache()

    @ObservationIgnored var cachedProjectionKey: PrecomputedCacheKey? {
        get { derivedStateCache.cachedProjectionKey }
        set { derivedStateCache.cachedProjectionKey = newValue }
    }

    @ObservationIgnored var cachedProjection: TranscriptRenderModel? {
        get { derivedStateCache.cachedProjection }
        set { derivedStateCache.cachedProjection = newValue }
    }

    @ObservationIgnored var messageListVersion: Int {
        get { derivedStateCache.messageListVersion }
        set { derivedStateCache.messageListVersion = newValue }
    }

    @ObservationIgnored var lastKnownMessagesRevision: UInt64 {
        get { derivedStateCache.lastKnownMessagesRevision }
        set { derivedStateCache.lastKnownMessagesRevision = newValue }
    }

    @ObservationIgnored var cachedFirstVisibleMessageId: UUID? {
        get { derivedStateCache.cachedFirstVisibleMessageId }
        set { derivedStateCache.cachedFirstVisibleMessageId = newValue }
    }

    // MARK: - Computed

    /// With inverted scroll (180° rotation), contentOffsetY is 0 at the visual
    /// bottom (latest messages) and increases as you scroll toward older messages.
    /// So contentOffsetY itself IS the distance from the latest messages.
    var distanceFromBottom: CGFloat {
        lastContentOffsetY
    }

    /// Distance from the visual top (oldest messages) in inverted scroll.
    /// Approaches 0 when the user scrolls to the oldest messages — used by
    /// the pagination sentinel to trigger loading older history.
    var distanceFromTop: CGFloat {
        scrollContentHeight - lastContentOffsetY - scrollContainerHeight
    }

    // MARK: - Scroll-to-latest

    // Hysteresis band: show at >400pt, hide only below 200pt. Prevents the CTA
    // from flickering when scroll-geometry jitter (avatar breathing animation,
    // layer measurement noise, periodic activity indicators) oscillates near a
    // single boundary.
    static let showScrollToLatestThreshold: CGFloat = 400
    static let hideScrollToLatestThreshold: CGFloat = 200

    func updateScrollToLatest() {
        let distance = distanceFromBottom
        let shouldShow: Bool
        if showScrollToLatest {
            shouldShow = distance >= Self.hideScrollToLatestThreshold
        } else {
            shouldShow = distance > Self.showScrollToLatestThreshold
        }
        if showScrollToLatest != shouldShow {
            showScrollToLatest = shouldShow
        }
    }

    /// Immediately hides the CTA. Called synchronously inside an animation
    /// block so the exit transition runs in sync with the scroll spring.
    func dismissScrollToLatest() {
        showScrollToLatest = false
    }

    // MARK: - Pagination sentinel

    /// Handles rising-edge detection for the pagination sentinel with a 500ms cooldown.
    /// Returns `true` when pagination should fire.
    ///
    /// With inverted scroll, callers pass `-distanceFromBottom` so values near
    /// zero mean the user is close to the visual top (oldest messages).
    func handlePaginationSentinel(sentinelMinY: CGFloat) -> Bool {
        let triggerBand: CGFloat = 200
        let isInRange = sentinelMinY > -triggerBand

        // Rising-edge: only fire on transition from out-of-range to in-range
        guard isInRange && !wasPaginationTriggerInRange else {
            wasPaginationTriggerInRange = isInRange
            return false
        }

        // 500ms cooldown between successive pagination fires
        let now = Date()
        guard now.timeIntervalSince(lastPaginationCompletedAt) >= 0.5 else { return false }

        // Only consume the rising edge when pagination actually fires
        wasPaginationTriggerInRange = isInRange
        return true
    }

    // MARK: - Scroll indicator management

    func hideScrollIndicatorsBriefly() {
        scrollIndicatorsHidden = true
        scrollIndicatorRestoreTask?.cancel()
        scrollIndicatorRestoreTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard !Task.isCancelled else { return }
            scrollIndicatorsHidden = false
        }
    }

    // MARK: - Lifecycle

    func reset(for conversationId: UUID?) {
        // Cancel queued geometry callbacks from the previous conversation
        // to prevent cross-conversation bleed-through.
        ScrollGeometryUpdateDispatcher.shared.cancel(for: self)
        currentConversationId = conversationId
        pinnedLatestTurnAnchorMessageId = nil
        lastMessageId = nil
        scrollContentHeight = 0
        scrollContainerHeight = 0
        lastContentOffsetY = 0
        viewportHeight = .infinity
        showScrollToLatest = false
        anchorSetTime = nil
        anchorTimeoutTask?.cancel()
        anchorTimeoutTask = nil
        lastAutoFocusedRequestId = nil
        wasPaginationTriggerInRange = false
        lastPaginationCompletedAt = .distantPast
        scrollIndicatorRestoreTask?.cancel()
        derivedStateCache.reset()

        isPaginationInFlight = false
        lastHandledChatColumnWidth = 0
        paginationTask?.cancel()
        paginationTask = nil
        highlightDismissTask?.cancel()
        highlightDismissTask = nil

        resetDebugMetrics()

        // Briefly hide scroll indicators during switch
        hideScrollIndicatorsBriefly()
    }

    func cancelAll() {
        ScrollGeometryUpdateDispatcher.shared.cancel(for: self)
        anchorTimeoutTask?.cancel()
        anchorTimeoutTask = nil
        scrollIndicatorRestoreTask?.cancel()
        scrollIndicatorRestoreTask = nil
        derivedStateCache.reset()
        paginationTask?.cancel()
        paginationTask = nil
        highlightDismissTask?.cancel()
        highlightDismissTask = nil
        isPaginationInFlight = false
        pinnedLatestTurnAnchorMessageId = nil
        lastMessageId = nil
        scrollContentHeight = 0
        scrollContainerHeight = 0
        lastContentOffsetY = 0
        viewportHeight = .infinity
        showScrollToLatest = false
        scrollIndicatorsHidden = false
        lastPaginationCompletedAt = .distantPast
    }

    // MARK: - Live properties (used by view layer)

    @ObservationIgnored var lastHandledChatColumnWidth: CGFloat = 0
    @ObservationIgnored var isPaginationInFlight: Bool = false
    @ObservationIgnored var paginationTask: Task<Void, Never>?
    @ObservationIgnored var highlightDismissTask: Task<Void, Never>?

    // MARK: - Debug metrics (populated only when scroll-debug-overlay is on)

    /// Incremented on every debug-metric write so the overlay's isolated
    /// observation boundary re-renders as metrics update. Kept observed; the
    /// underlying struct stays `@ObservationIgnored` so geometry ticks do not
    /// invalidate the rest of `MessageListView`.
    private(set) var debugMetricsVersion: Int = 0

    @ObservationIgnored var debugMetrics = ScrollDebugMetrics()

    /// Fold a fresh scroll snapshot into the debug metrics. Only called when
    /// the `scroll-debug-overlay` flag is on — the hot path otherwise skips this.
    func recordDebugSnapshot(offsetY: CGFloat, isLiveScrolling: Bool, at now: Date = Date()) {
        debugMetrics.recordSnapshot(offsetY: offsetY, isLiveScrolling: isLiveScrolling, at: now)
        debugMetricsVersion &+= 1
    }

    /// Record that the anchor preserver applied a non-nil offset delta. Only
    /// called when the `scroll-debug-overlay` flag is on.
    func recordDebugAnchorShift(at now: Date = Date()) {
        debugMetrics.recordAnchorShift(at: now)
        debugMetricsVersion &+= 1
    }

    /// Reset debug metrics (e.g. on conversation switch) so counters start
    /// fresh and don't carry stale data across conversations.
    func resetDebugMetrics() {
        debugMetrics = ScrollDebugMetrics()
        debugMetricsVersion &+= 1
    }

}

// MARK: - ScrollDebugMetrics

/// Live metrics surfaced by the scroll-debug overlay. Populated in the scroll
/// geometry handler only when the `scroll-debug-overlay` flag is on, so the
/// hot path pays nothing when the overlay is off.
struct ScrollDebugMetrics {
    var lastDeltaY: CGFloat = 0
    /// Signed scroll velocity in points per second, smoothed across recent
    /// samples via an EMA to damp per-tick jitter.
    var velocityPtPerSec: CGFloat = 0
    /// Mirrors `MessageListScrollObserver.Coordinator.isLiveScrolling`.
    var isLiveScrolling: Bool = false
    /// Cumulative count of non-nil `ScrollAnchorPreserver.offsetDelta(...)`
    /// returns since the last reset.
    var anchorShiftTotal: Int = 0
    /// Rolling buffer of geometry-snapshot timestamps — read once per render
    /// by the overlay to compute an updates-per-second counter.
    var recentUpdateTimes: [Date] = []
    /// Rolling buffer of anchor-shift timestamps — read once per render by the
    /// overlay to compute an anchor-shifts-per-second counter.
    var recentAnchorShiftTimes: [Date] = []

    private var lastSnapshotTime: Date?
    private var lastSnapshotOffsetY: CGFloat = 0
    /// EMA smoothing factor for velocity. Higher = more responsive, lower =
    /// smoother. 0.35 keeps the reading stable during momentum scroll while
    /// still reacting to direction flips.
    private static let velocitySmoothing: CGFloat = 0.35

    mutating func recordSnapshot(offsetY: CGFloat, isLiveScrolling: Bool, at now: Date) {
        if let prev = lastSnapshotTime {
            let dt = now.timeIntervalSince(prev)
            let delta = offsetY - lastSnapshotOffsetY
            lastDeltaY = delta
            if dt > 0.001 {
                let instantaneous = delta / CGFloat(dt)
                velocityPtPerSec += (instantaneous - velocityPtPerSec) * Self.velocitySmoothing
            }
        }
        lastSnapshotTime = now
        lastSnapshotOffsetY = offsetY
        self.isLiveScrolling = isLiveScrolling
        recentUpdateTimes.append(now)
        Self.trim(&recentUpdateTimes, at: now)
    }

    mutating func recordAnchorShift(at now: Date) {
        anchorShiftTotal += 1
        recentAnchorShiftTimes.append(now)
        Self.trim(&recentAnchorShiftTimes, at: now)
    }

    func updatesPerSecond(at now: Date = Date()) -> Int {
        let cutoff = now.addingTimeInterval(-1)
        return recentUpdateTimes.reduce(0) { $1 > cutoff ? $0 + 1 : $0 }
    }

    func anchorShiftsPerSecond(at now: Date = Date()) -> Int {
        let cutoff = now.addingTimeInterval(-1)
        return recentAnchorShiftTimes.reduce(0) { $1 > cutoff ? $0 + 1 : $0 }
    }

    /// Velocity to show in the HUD. Snaps to 0 once no snapshot has arrived
    /// for `idleThreshold` seconds — without this, the EMA stays pinned at
    /// its last value when scrolling stops and the reading looks stuck.
    func displayedVelocity(at now: Date, idleThreshold: TimeInterval = 0.1) -> CGFloat {
        guard let last = lastSnapshotTime, now.timeIntervalSince(last) <= idleThreshold else {
            return 0
        }
        return velocityPtPerSec
    }

    /// Keep a little slack past 1s so reads near a second boundary don't flap.
    /// `static` so the inout buffer access doesn't overlap with the caller's
    /// inout access to `self` via the mutating entry point.
    private static func trim(_ buffer: inout [Date], at now: Date) {
        let cutoff = now.addingTimeInterval(-1.5)
        while let first = buffer.first, first < cutoff {
            buffer.removeFirst()
        }
    }
}
