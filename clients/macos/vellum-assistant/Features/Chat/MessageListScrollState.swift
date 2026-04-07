import Foundation
import os
import SwiftUI
import VellumAssistantShared

private let scrollLog = Logger(subsystem: Bundle.appBundleIdentifier, category: "ScrollState")

// MARK: - MessageListScrollState

/// Simplified scroll coordinator with `@Observable` fine-grained tracking.
///
/// Replaces the previous mode-based state machine (ScrollMode enum,
/// stabilization windows, recovery deadlines, circuit breaker) with a
/// flat set of properties and hysteresis-based near-bottom detection.
///
/// UI-facing properties (`showScrollToLatest`, `scrollIndicatorsHidden`)
/// are individually tracked by the Observation framework, so SwiftUI only
/// re-evaluates views that read the specific property that changed. Other
/// properties are queried imperatively by scroll handlers.
///
/// References:
/// - [WWDC23 -- Discover Observation in SwiftUI](https://developer.apple.com/videos/play/wwdc2023/10149/)
/// - [Observation framework](https://developer.apple.com/documentation/observation)
@Observable @MainActor
final class MessageListScrollState {

    // MARK: - Observed UI State

    /// Whether the "Scroll to latest" CTA should be visible.
    /// Tracked independently -- only views reading this property re-evaluate.
    private(set) var showScrollToLatest: Bool = false

    /// Whether scroll indicators should be hidden.
    /// Tracked independently -- only the scroll indicator modifier re-evaluates.
    private(set) var scrollIndicatorsHidden: Bool = false

    // MARK: - Near-Bottom Detection (hysteresis)

    /// Whether the viewport is considered "near bottom".
    /// Uses hysteresis: enters at <= 10pt from bottom, leaves at > 50pt.
    @ObservationIgnored var isNearBottom: Bool = true

    // MARK: - Geometry State

    /// Current viewport height for dynamic spacer calculations.
    @ObservationIgnored var viewportHeight: CGFloat = 0

    /// Total content height from scroll geometry.
    @ObservationIgnored var contentHeight: CGFloat = 0

    /// Current content offset Y from scroll geometry.
    @ObservationIgnored var contentOffsetY: CGFloat = 0

    // MARK: - Send Cycle Anchoring

    /// Prevents re-anchoring during the same send cycle.
    /// Reset to `false` at the start of each send, set to `true` once anchored.
    @ObservationIgnored var didAnchorCurrentSendCycle: Bool = false

    // MARK: - Auto-Follow Throttle

    /// Timestamp of the last successful auto-follow, used for 80ms throttle.
    @ObservationIgnored var lastAutoFollowAt: Date = .distantPast

    // MARK: - Conversation Tracking

    /// The conversation ID currently being displayed.
    @ObservationIgnored var currentConversationId: UUID?

    // MARK: - Deep-Link / Search Anchor

    /// Message ID for a pending deep-link or search anchor scroll.
    @ObservationIgnored var pendingAnchorMessageId: UUID?

    // MARK: - Scroll Target

    /// The ID of the last message in the current conversation's ForEach.
    /// Used as the primary scroll-to-bottom target.
    @ObservationIgnored var lastMessageId: (any Hashable)?

    // MARK: - Confirmation Focus

    /// Tracks the last confirmation request ID that was auto-focused,
    /// so the same request isn't focused twice.
    @ObservationIgnored var lastAutoFocusedRequestId: String?

    // MARK: - Pagination

    /// Tracks whether the pagination sentinel was previously inside the trigger band.
    /// Used as a rising-edge detector to fire pagination only on entry.
    @ObservationIgnored var wasPaginationTriggerInRange: Bool = false

    /// Timestamp of the last pagination completion, used to enforce a 500ms
    /// cooldown between successive pagination fires.
    @ObservationIgnored var lastPaginationCompletedAt: Date = .distantPast

    // MARK: - Bottom Anchor Tracking

    /// Whether the bottom anchor element has appeared in the LazyVStack.
    /// Set by `MessageListContentView`'s `onAppear` on the bottom spacer.
    @ObservationIgnored var bottomAnchorAppeared: Bool = false

    /// Whether the user has interacted with the scroll view (scrolled away
    /// from initial position). Used to gate initial auto-scroll behavior.
    @ObservationIgnored var hasBeenInteracted: Bool = false

    /// Whether a message is currently being sent/streamed.
    /// Used to subtract the conditional spacer height from `distanceFromBottom`.
    @ObservationIgnored var isSending: Bool = false

    // MARK: - Derived State Cache

    /// Non-observable cache for memoizing derived state computations.
    /// Kept off the observation graph to avoid "modifying state during view
    /// update" warnings while still enabling memoization hot paths.
    @ObservationIgnored lazy var derivedStateCache = MessageListDerivedStateCache()

    // MARK: - Computed Properties

    /// Distance from the bottom of the scrollable content.
    /// When sending, subtracts the conditional spacer height so that
    /// near-bottom detection is based on actual content, not the spacer.
    var distanceFromBottom: CGFloat {
        let raw = contentHeight - contentOffsetY - viewportHeight
        if isSending {
            let spacerHeight = max(0, viewportHeight - 100)
            return raw - spacerHeight
        }
        return raw
    }

    /// Whether auto-follow should engage: near bottom and not yet anchored
    /// in the current send cycle.
    var shouldAutoFollow: Bool {
        isNearBottom && !didAnchorCurrentSendCycle
    }

    // MARK: - Methods

    /// Updates `isNearBottom` using hysteresis thresholds.
    ///
    /// - If currently near bottom, leave at > 50pt from bottom.
    /// - If not near bottom, enter at <= 10pt from bottom.
    ///
    /// Also updates `showScrollToLatest` based on the new value.
    func updateNearBottom() {
        let distance = distanceFromBottom

        if isNearBottom {
            // Leave near-bottom when distance exceeds 50pt
            if distance > 50 {
                isNearBottom = false
                scrollLog.debug("Near-bottom: left (distance: \(distance, format: .fixed(precision: 1))pt)")
            }
        } else {
            // Enter near-bottom when distance is 10pt or less
            if distance <= 10 {
                isNearBottom = true
                scrollLog.debug("Near-bottom: entered (distance: \(distance, format: .fixed(precision: 1))pt)")
            }
        }

        showScrollToLatest = !isNearBottom
    }

    /// Marks the beginning of a new send cycle.
    /// Resets the anchoring flag so the system can anchor once for this cycle.
    func beginSendCycle() {
        didAnchorCurrentSendCycle = false
    }

    /// Marks that the current send cycle has been anchored.
    /// Prevents additional anchoring until the next `beginSendCycle()`.
    func markSendAnchored() {
        didAnchorCurrentSendCycle = true
    }

    /// Returns `true` if auto-follow is allowed (near bottom and at least
    /// 80ms since the last auto-follow). Updates `lastAutoFollowAt` on success.
    func canAutoFollow() -> Bool {
        guard isNearBottom else { return false }

        let now = Date()
        guard now.timeIntervalSince(lastAutoFollowAt) >= 0.08 else { return false }

        lastAutoFollowAt = now
        return true
    }

    /// Called when the viewport reaches the bottom of the content.
    /// Marks the scroll state as interacted and near-bottom.
    func handleReachedBottom() {
        hasBeenInteracted = true
        isNearBottom = true
        showScrollToLatest = false
    }

    /// Records a body evaluation timestamp for circuit-breaker throttling.
    /// If more than 60 evaluations occur within 500ms, activates throttle
    /// mode to prevent runaway layout loops. Auto-recovers after 500ms.
    func recordBodyEvaluation() {
        let now = CFAbsoluteTimeGetCurrent()
        let cache = derivedStateCache
        cache.bodyEvalTimestamps.append(now)

        // Prune timestamps older than 500ms
        let cutoff = now - 0.5
        cache.bodyEvalTimestamps.removeAll { $0 < cutoff }

        if cache.bodyEvalTimestamps.count > 60 && !cache.isThrottled {
            cache.isThrottled = true
            scrollLog.warning("Circuit breaker tripped: \(cache.bodyEvalTimestamps.count) body evals in 500ms")

            cache.throttleRecoveryTask?.cancel()
            cache.throttleRecoveryTask = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 500_000_000)
                guard !Task.isCancelled else { return }
                self?.derivedStateCache.isThrottled = false
                self?.derivedStateCache.bodyEvalTimestamps.removeAll()
                scrollLog.debug("Circuit breaker recovered")
            }
        }
    }

    /// Called when the user taps "Scroll to latest". Resets near-bottom
    /// state and hides the CTA so the caller can perform the actual scroll.
    func handleScrollToLatestTapped() {
        isNearBottom = true
        showScrollToLatest = false
        scrollLog.debug("Scroll to latest tapped — resetting near-bottom state")
    }

    /// Resets all state for a conversation switch.
    func reset(for conversationId: UUID) {
        currentConversationId = conversationId
        isNearBottom = true
        viewportHeight = 0
        contentHeight = 0
        contentOffsetY = 0
        didAnchorCurrentSendCycle = false
        lastAutoFollowAt = .distantPast
        pendingAnchorMessageId = nil
        lastMessageId = nil
        wasPaginationTriggerInRange = false
        lastPaginationCompletedAt = .distantPast
        showScrollToLatest = false
        scrollIndicatorsHidden = false
        lastAutoFocusedRequestId = nil
        bottomAnchorAppeared = false
        hasBeenInteracted = false
        isSending = false
        derivedStateCache.reset()

        scrollLog.debug("Reset for conversation: \(conversationId)")
    }

    /// Handles the pagination sentinel's geometry to trigger pagination
    /// on a rising edge (sentinel enters the trigger band) with a 500ms cooldown.
    ///
    /// - Parameter sentinelMinY: The minY of the pagination sentinel in the
    ///   scroll view's coordinate space.
    @discardableResult
    func handlePaginationSentinel(sentinelMinY: CGFloat) -> Bool {
        // Trigger band: sentinel minY between -120pt (above viewport top)
        // and +200pt (below viewport top).
        let isInRange = sentinelMinY >= -120 && sentinelMinY <= 200

        // Rising-edge detector: only fire when transitioning from out-of-range
        // to in-range.
        let shouldFire = isInRange && !wasPaginationTriggerInRange
        wasPaginationTriggerInRange = isInRange

        guard shouldFire else { return false }

        // 500ms cooldown between successive pagination fires.
        let now = Date()
        guard now.timeIntervalSince(lastPaginationCompletedAt) >= 0.5 else {
            scrollLog.debug("Pagination sentinel: in range but cooldown active")
            return false
        }

        scrollLog.debug("Pagination sentinel: triggered (sentinelMinY: \(sentinelMinY, format: .fixed(precision: 1))pt)")
        lastPaginationCompletedAt = now
        return true
    }
}
