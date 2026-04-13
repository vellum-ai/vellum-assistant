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

    // MARK: - Geometry (not observed, updated by scroll handler)

    @ObservationIgnored var scrollContentHeight: CGFloat = 0
    @ObservationIgnored var scrollContainerHeight: CGFloat = 0
    @ObservationIgnored var lastContentOffsetY: CGFloat = 0
    @ObservationIgnored var viewportHeight: CGFloat = .infinity

    // MARK: - State

    @ObservationIgnored var currentConversationId: UUID?
    @ObservationIgnored var lastMessageId: UUID?
    @ObservationIgnored var lastActivityPhaseWhenIdle: String = ""
    @ObservationIgnored var pendingSendScrollMessageId: UUID?
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

    var distanceFromBottom: CGFloat {
        scrollContentHeight - lastContentOffsetY - scrollContainerHeight
    }

    // MARK: - Scroll-to-latest

    func updateScrollToLatest() {
        let shouldShow = distanceFromBottom > 400
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
        lastMessageId = nil
        pendingSendScrollMessageId = nil
        scrollContentHeight = 0
        scrollContainerHeight = 0
        lastContentOffsetY = 0
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
        lastMessageId = nil
        scrollContentHeight = 0
        scrollContainerHeight = 0
        lastContentOffsetY = 0
        showScrollToLatest = false
        scrollIndicatorsHidden = false
        lastPaginationCompletedAt = .distantPast
    }

    // MARK: - Live properties (used by view layer)

    @ObservationIgnored var lastHandledChatColumnWidth: CGFloat = 0
    @ObservationIgnored var isPaginationInFlight: Bool = false
    @ObservationIgnored var paginationTask: Task<Void, Never>?
    @ObservationIgnored var highlightDismissTask: Task<Void, Never>?

}
