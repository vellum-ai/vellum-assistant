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

    // MARK: - Pagination

    /// Tracks whether the pagination sentinel was previously inside the trigger band.
    /// Used as a rising-edge detector to fire pagination only on entry.
    @ObservationIgnored var wasPaginationTriggerInRange: Bool = false

    /// Timestamp of the last pagination completion, used to enforce a 500ms
    /// cooldown between successive pagination fires.
    @ObservationIgnored var lastPaginationCompletedAt: Date = .distantPast

    // MARK: - Computed Properties

    /// Distance from the bottom of the scrollable content.
    var distanceFromBottom: CGFloat {
        contentHeight - contentOffsetY - viewportHeight
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

        scrollLog.debug("Reset for conversation: \(conversationId)")
    }

    /// Handles the pagination sentinel's geometry to trigger pagination
    /// on a rising edge (sentinel enters the trigger band) with a 500ms cooldown.
    ///
    /// - Parameter sentinelMinY: The minY of the pagination sentinel in the
    ///   scroll view's coordinate space.
    func handlePaginationSentinel(sentinelMinY: CGFloat) {
        // Trigger band: sentinel minY between -120pt (above viewport top)
        // and +200pt (below viewport top).
        let isInRange = sentinelMinY >= -120 && sentinelMinY <= 200

        // Rising-edge detector: only fire when transitioning from out-of-range
        // to in-range.
        let shouldFire = isInRange && !wasPaginationTriggerInRange
        wasPaginationTriggerInRange = isInRange

        guard shouldFire else { return }

        // 500ms cooldown between successive pagination fires.
        let now = Date()
        guard now.timeIntervalSince(lastPaginationCompletedAt) >= 0.5 else {
            scrollLog.debug("Pagination sentinel: in range but cooldown active")
            return
        }

        scrollLog.debug("Pagination sentinel: triggered (sentinelMinY: \(sentinelMinY, format: .fixed(precision: 1))pt)")
        lastPaginationCompletedAt = now
    }
}
