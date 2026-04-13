import Foundation
import os
import SwiftUI
import VellumAssistantShared

// MARK: - Legacy enums (referenced by external files, removed in later PRs)

/// Stub enum kept for pattern matching in external callers. Removed in PR 2.
enum ScrollMode: Equatable, CustomStringConvertible {
    case initialLoad
    case followingBottom
    case freeBrowsing
    case programmaticScroll(reason: ProgrammaticScrollReason)
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

    /// Stub — always returns true. Cleaned up in PR 2.
    var allowsAutoScroll: Bool { true }

    /// Stub — always returns false. Cleaned up in PR 2.
    var showsScrollToLatest: Bool { false }
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

/// Flat scroll coordinator — tracks geometry, distance-based scroll-to-latest
/// visibility, pagination sentinel, and deep-link anchor state. No mode
/// transitions, stabilization, or recovery logic.
///
/// The legacy `ScrollMode` enum and mode-transition methods are kept as no-op
/// stubs so external callers (MessageListView, MessageListContentView,
/// scroll handling, lifecycle handlers) continue to compile. These stubs are
/// removed in PRs 2-6.
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
    @ObservationIgnored var pendingSendScrollToTop: Bool = false

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

    // MARK: - Pagination sentinel

    /// Handles rising-edge detection for the pagination sentinel with a 500ms cooldown.
    /// Returns `true` when pagination should fire.
    func handlePaginationSentinel(sentinelMinY: CGFloat) -> Bool {
        let triggerBand: CGFloat = 200
        let isInRange = sentinelMinY > -triggerBand

        defer { wasPaginationTriggerInRange = isInRange }

        // Rising-edge: only fire on transition from out-of-range to in-range
        guard isInRange && !wasPaginationTriggerInRange else { return false }

        // 500ms cooldown between successive pagination fires
        let now = Date()
        guard now.timeIntervalSince(lastPaginationCompletedAt) >= 0.5 else { return false }

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
        currentConversationId = conversationId
        lastMessageId = nil
        pendingSendScrollToTop = false
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

        // Reset stub state
        mode = .initialLoad
        scrollPhase = .idle
        isAtBottom = false
        bottomAnchorAppeared = false
        isPaginationInFlight = false
        recoveryDeadline = nil
        lastRecoveryAttempt = .distantPast
        lastUserInitiatedPinTime = nil
        lastHandledChatColumnWidth = 0
        scrollRestoreTask?.cancel()
        scrollRestoreTask = nil
        paginationTask?.cancel()
        paginationTask = nil
        highlightDismissTask?.cancel()
        highlightDismissTask = nil

        // Briefly hide scroll indicators during switch
        hideScrollIndicatorsBriefly()
    }

    func cancelAll() {
        anchorTimeoutTask?.cancel()
        anchorTimeoutTask = nil
        scrollIndicatorRestoreTask?.cancel()
        scrollIndicatorRestoreTask = nil
        derivedStateCache.reset()

        // Cancel stub tasks
        scrollRestoreTask?.cancel()
        scrollRestoreTask = nil
        paginationTask?.cancel()
        paginationTask = nil
        highlightDismissTask?.cancel()
        highlightDismissTask = nil

        // Reset stub state
        mode = .initialLoad
        scrollPhase = .idle
        isAtBottom = false
        bottomAnchorAppeared = false
        isPaginationInFlight = false
        recoveryDeadline = nil
        lastRecoveryAttempt = .distantPast
        lastUserInitiatedPinTime = nil
        lastMessageId = nil
        scrollContentHeight = 0
        scrollContainerHeight = 0
        lastContentOffsetY = 0
        showScrollToLatest = false
        scrollIndicatorsHidden = false
        lastPaginationCompletedAt = .distantPast
    }

    // MARK: - Stubs (referenced by other files, cleaned up in later PRs)
    //
    // These properties and methods are referenced by MessageListView,
    // MessageListContentView, MessageListView+ScrollHandling,
    // MessageListView+Lifecycle, MessageListView+DerivedState, and
    // MessageListHelperViews. They will be removed in PRs 2-6.

    // --- Mode (stub, no real transitions) ---

    @ObservationIgnored var mode: ScrollMode = .initialLoad

    /// No-op stub. Cleaned up in PR 2.
    func transition(to newMode: ScrollMode) {
        mode = newMode
    }

    // --- Scroll closures (set by MessageListView+ScrollHandling, removed in PR 2) ---

    @ObservationIgnored var scrollTo: ((_ id: any Hashable, _ anchor: UnitPoint?) -> Void)?
    @ObservationIgnored var scrollToEdge: ((_ edge: Edge) -> Void)?
    @ObservationIgnored var cancelScrollAnimation: (() -> Void)?

    // --- Geometry stubs ---

    @ObservationIgnored var scrollPhase: ScrollPhase = .idle
    @ObservationIgnored var isAtBottom: Bool = false
    @ObservationIgnored var bottomAnchorAppeared: Bool = false
    @ObservationIgnored var recoveryDeadline: Date?
    @ObservationIgnored var lastRecoveryAttempt: Date = .distantPast
    @ObservationIgnored var lastUserInitiatedPinTime: Date?
    @ObservationIgnored var lastHandledChatColumnWidth: CGFloat = 0

    // --- Pagination stubs ---

    @ObservationIgnored var isPaginationInFlight: Bool = false

    var hideScrollIndicators: Bool {
        get { scrollIndicatorsHidden }
        set { scrollIndicatorsHidden = newValue }
    }

    // --- Task stubs ---

    @ObservationIgnored var paginationTask: Task<Void, Never>?
    @ObservationIgnored var scrollRestoreTask: Task<Void, Never>?
    @ObservationIgnored var highlightDismissTask: Task<Void, Never>?

    // --- Convenience stubs ---

    /// No-op stub. Cleaned up in PR 2.
    var hasBeenInteracted: Bool { true }

    /// No-op stub. Cleaned up in PR 2.
    var isFollowingBottom: Bool { false }

    /// No-op stub. Cleaned up in PR 2.
    var isSuppressed: Bool { false }

    // --- Method stubs ---

    /// No-op stub. Cleaned up in PR 2.
    func handleReachedBottom() {}

    /// No-op stub. Cleaned up in PR 2.
    func handleManualExpansionInteraction() {}

    /// No-op stub. Cleaned up in PR 2.
    func handleUserScrollUp() {}

    /// Stub — delegates to updateScrollToLatest(). Cleaned up in PR 2.
    func scheduleUISync() {
        updateScrollToLatest()
    }

    /// Stub — delegates to updateScrollToLatest(). Cleaned up in PR 2.
    func syncUIImmediately() {
        updateScrollToLatest()
    }

    /// Stub that preserves scroll-to-bottom behavior for external callers.
    /// Cleaned up in PR 2.
    @discardableResult
    func requestPinToBottom(animated: Bool = false, userInitiated: Bool = false) -> Bool {
        if userInitiated {
            showScrollToLatest = false
            let target: any Hashable = lastMessageId ?? ("scroll-bottom-anchor" as any Hashable)
            scrollTo?(target, .bottom)
            return true
        }
        if let target = lastMessageId {
            if animated {
                withAnimation(VAnimation.fast) {
                    scrollTo?(target, .bottom)
                }
            } else {
                scrollTo?(target, .bottom)
            }
        } else {
            if animated {
                withAnimation(VAnimation.fast) {
                    scrollToEdge?(.bottom)
                }
            } else {
                scrollToEdge?(.bottom)
            }
        }
        return true
    }

    /// Stub that preserves deferred bottom-pin for external callers.
    /// Cleaned up in PR 2.
    func scheduleDeferredBottomPin(
        animated: Bool = false,
        userInitiated: Bool = false,
        forceFollowingBottom: Bool = false,
        refreshRecoveryWindow: Bool = false
    ) {
        DispatchQueue.main.async { [weak self] in
            Task { @MainActor [weak self] in
                guard let self else { return }
                _ = self.requestPinToBottom(animated: animated, userInitiated: userInitiated)
            }
        }
    }

    /// No-op stub. Cleaned up in PR 2.
    func cancelDeferredBottomPin() {}

    /// Stub that preserves scroll-to-id for external callers.
    /// Cleaned up in PR 2.
    func performScrollTo(_ id: any Hashable, anchor: UnitPoint? = nil) {
        scrollTo?(id, anchor)
    }

    /// No-op stub. Cleaned up in PR 2.
    func beginStabilization(_ reason: StabilizationReason) {}

    /// No-op stub. Cleaned up in PR 2.
    func endStabilization() {}

    /// No-op stub. Cleaned up in PR 4.
    func recordBodyEvaluation() {}

    /// No-op stub. Cleaned up in PR 6.
    @ObservationIgnored var isThrottled: Bool {
        get { false }
        set {}
    }

    /// Stub counter for test compatibility. Cleaned up in PR 6.
    @ObservationIgnored private(set) var uiVersion: UInt64 = 0
}
