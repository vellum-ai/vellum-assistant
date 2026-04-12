import Foundation

// MARK: - ScrollCoordinator

/// Pure policy object that models the scroll decisions currently spread across
/// `MessageListView`, `MessageListView+Lifecycle`, `MessageListView+ScrollHandling`,
/// and `MessageListScrollState`.
///
/// The coordinator consumes discrete input events and produces output intents
/// describing what scroll action the view layer should perform — without owning
/// `ScrollPosition`, `ScrollGeometrySnapshot`, or any SwiftUI view references.
///
/// Wired into the live message list in MessageListView, MessageListView+Lifecycle,
/// and MessageListView+ScrollHandling. Output intents are translated into concrete
/// ScrollPosition mutations by executeCoordinatorIntents().
///
/// Scroll policy domains modeled:
///   - following-bottom vs free-browsing
///   - deep-link anchor jumps
///   - search jumps
///   - resize recovery
///   - manual expansion detach
@MainActor
final class ScrollCoordinator {

    // MARK: - Types

    /// Discrete events the coordinator can receive.
    enum InputEvent: Equatable {
        /// View appeared (initial mount or conversation switch).
        case appeared

        /// The visible message count changed.
        case messageCountChanged

        /// The sending state changed.
        case sendingChanged(isSending: Bool)

        /// The scroll phase changed (idle, interacting, decelerating, animating).
        case scrollPhaseChanged(phase: Phase)

        /// The user intentionally scrolled up (manual browse gesture).
        case manualBrowseIntent

        /// The user manually expanded or collapsed inline content (e.g. tool details).
        case manualExpansion

        /// A deep-link or search anchor was requested.
        case anchorRequested(id: AnchorID)

        /// A previously-requested anchor resolved (message is now visible).
        case anchorResolved(id: AnchorID)

        /// The container width changed (sidebar resize, split-view change).
        case containerWidthChanged
    }

    /// Anchor identifier — wraps a UUID to keep the coordinator decoupled
    /// from the concrete message ID type used by the view layer.
    struct AnchorID: Hashable, Equatable {
        let rawValue: UUID

        init(_ rawValue: UUID) {
            self.rawValue = rawValue
        }
    }

    /// Scroll phase abstraction mirroring SwiftUI's `ScrollPhase` without
    /// importing SwiftUI.
    enum Phase: Equatable {
        case idle
        case interacting
        case decelerating
        case animating
    }

    /// Output intents the coordinator produces. The view layer translates
    /// these into concrete `ScrollPosition` mutations.
    enum OutputIntent: Equatable {
        /// Scroll to the absolute bottom of the content.
        case scrollToBottom(animated: Bool)

        /// Scroll to a specific message with an anchor position.
        case scrollToMessage(id: AnchorID, anchor: ScrollAnchorPoint)

        /// Show the "Scroll to latest" call-to-action overlay.
        case showScrollToLatest

        /// Hide all scroll-related indicators (CTA, scroll bars, etc.).
        case hideIndicators

        /// Begin a recovery window — the view layer should repeatedly
        /// attempt bottom-pinning until the window expires or the bottom
        /// anchor materializes.
        case startRecoveryWindow

        /// Cancel any active recovery window.
        case cancelRecoveryWindow
    }

    /// Abstract anchor position for scroll-to-message intents.
    enum ScrollAnchorPoint: Equatable {
        case top
        case center
        case bottom
    }

    // MARK: - Mode

    /// The coordinator's internal scroll mode — mirrors the existing
    /// `ScrollMode` semantics from `MessageListScrollState`.
    enum Mode: Equatable, CustomStringConvertible {
        /// Initial render — content starts at bottom, no user interaction yet.
        case initialLoad

        /// User is at the bottom. Auto-scroll on new content, streaming, etc.
        case followingBottom

        /// User scrolled away from bottom. No auto-scroll.
        case freeBrowsing

        /// A programmatic scroll is in flight (deep-link anchor, search, etc.).
        case programmaticScroll(anchorId: AnchorID)

        /// Temporarily stabilizing after a layout change.
        case stabilizing(previousMode: StabilizedMode, reason: StabilizationReason)

        var description: String {
            switch self {
            case .initialLoad: "initialLoad"
            case .followingBottom: "followingBottom"
            case .freeBrowsing: "freeBrowsing"
            case .programmaticScroll(let id): "programmaticScroll(\(id.rawValue))"
            case .stabilizing(let prev, let reason): "stabilizing(\(prev), \(reason))"
            }
        }

        /// Whether the mode allows automatic bottom-pinning on new content.
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
            case .stabilizing(let prev, _) where prev == .freeBrowsing: true
            default: false
            }
        }
    }

    /// The mode before entering stabilizing.
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

    enum StabilizationReason: Equatable, CustomStringConvertible {
        case resize
        case expansion

        var description: String {
            switch self {
            case .resize: "resize"
            case .expansion: "expansion"
            }
        }
    }

    // MARK: - State

    /// The current scroll mode. Read-only externally; mutated by `handle(_:)`.
    private(set) var mode: Mode = .initialLoad

    /// Current scroll phase — used for hysteresis decisions.
    private(set) var phase: Phase = .idle

    /// Whether the viewport is currently at the bottom (within hysteresis threshold).
    private(set) var isAtBottom: Bool = true

    /// Tracks overlapping stabilization windows.
    private var activeStabilizationCount: Int = 0

    /// Timestamp of the last user-initiated pin (CTA tap). Used to suppress
    /// stale momentum from the pre-CTA scroll gesture.
    private var lastUserInitiatedPinTime: Date?

    /// Pending anchor that hasn't resolved yet.
    private(set) var pendingAnchor: AnchorID?

    // MARK: - Convenience Queries

    /// Whether the mode is following the bottom (including when stabilizing
    /// from a following state).
    var isFollowingBottom: Bool {
        switch mode {
        case .followingBottom: true
        case .stabilizing(let prev, _): prev == .followingBottom
        default: false
        }
    }

    /// Whether auto-scroll is currently suppressed (stabilizing mode).
    var isSuppressed: Bool {
        if case .stabilizing = mode { return true }
        return false
    }

    /// Whether the scroll system has received initial interaction.
    var hasBeenInteracted: Bool {
        if case .initialLoad = mode { return false }
        return true
    }

    // MARK: - Event Processing

    /// Process an input event and return the resulting output intents.
    ///
    /// The coordinator is deterministic: given the same sequence of events,
    /// it produces the same sequence of intents. The view layer is responsible
    /// for translating intents into concrete scroll mutations.
    @discardableResult
    func handle(_ event: InputEvent) -> [OutputIntent] {
        switch event {
        case .appeared:
            return handleAppeared()

        case .messageCountChanged:
            return handleMessageCountChanged()

        case .sendingChanged(let isSending):
            return handleSendingChanged(isSending: isSending)

        case .scrollPhaseChanged(let newPhase):
            return handleScrollPhaseChanged(newPhase: newPhase)

        case .manualBrowseIntent:
            return handleManualBrowseIntent()

        case .manualExpansion:
            return handleManualExpansion()

        case .anchorRequested(let id):
            return handleAnchorRequested(id: id)

        case .anchorResolved(let id):
            return handleAnchorResolved(id: id)

        case .containerWidthChanged:
            return handleContainerWidthChanged()
        }
    }

    // MARK: - Event Handlers

    private func handleAppeared() -> [OutputIntent] {
        var intents: [OutputIntent] = []
        // On initial appear, start following the bottom with a recovery window.
        if mode == .initialLoad || mode == .followingBottom {
            intents.append(.startRecoveryWindow)
            intents.append(.scrollToBottom(animated: false))
        }
        return intents
    }

    private func handleMessageCountChanged() -> [OutputIntent] {
        var intents: [OutputIntent] = []

        // If we have a pending anchor, check if it resolved.
        // (The view layer calls anchorResolved separately when it finds the message.)

        // Auto-pin to bottom when in a following mode.
        if mode.allowsAutoScroll {
            intents.append(.scrollToBottom(animated: true))
        }
        return intents
    }

    private func handleSendingChanged(isSending: Bool) -> [OutputIntent] {
        var intents: [OutputIntent] = []
        if isSending {
            // User sent a message — reattach to bottom.
            transition(to: .followingBottom)
            intents.append(.startRecoveryWindow)
            intents.append(.scrollToBottom(animated: true))
        }
        return intents
    }

    private func handleScrollPhaseChanged(newPhase: Phase) -> [OutputIntent] {
        let oldPhase = phase
        phase = newPhase

        let intents: [OutputIntent] = []

        // When scroll settles to idle and we're at the bottom, reattach.
        if newPhase == .idle && oldPhase != .idle && isAtBottom {
            reattachAtBottom()
        }

        return intents
    }

    private func handleManualBrowseIntent() -> [OutputIntent] {
        var intents: [OutputIntent] = []

        // Check for stale momentum suppression: if the user tapped the CTA
        // recently and we're in a decelerating phase, the upward scroll is
        // residual momentum — not a new deliberate gesture.
        if phase == .decelerating,
           let pinTime = lastUserInitiatedPinTime,
           Date().timeIntervalSince(pinTime) < 0.5 {
            // Stale momentum — ignore.
            return intents
        }

        // Detach from auto-follow.
        switch mode {
        case .initialLoad, .followingBottom:
            transition(to: .freeBrowsing)
            intents.append(.cancelRecoveryWindow)
        case .stabilizing:
            transition(to: .freeBrowsing)
            intents.append(.cancelRecoveryWindow)
        case .freeBrowsing, .programmaticScroll:
            break
        }

        if mode.showsScrollToLatest {
            intents.append(.showScrollToLatest)
        }

        return intents
    }

    private func handleManualExpansion() -> [OutputIntent] {
        var intents: [OutputIntent] = []

        // Cancel recovery — manual expansion is explicit user intent to inspect.
        intents.append(.cancelRecoveryWindow)

        // Detach into free-browsing if not already there.
        switch mode {
        case .freeBrowsing:
            break
        case .stabilizing(let previousMode, _) where previousMode == .freeBrowsing:
            break
        default:
            transition(to: .freeBrowsing)
        }

        // Begin expansion stabilization.
        beginStabilization(.expansion)
        intents.append(.showScrollToLatest)

        return intents
    }

    private func handleAnchorRequested(id: AnchorID) -> [OutputIntent] {
        pendingAnchor = id
        transition(to: .programmaticScroll(anchorId: id))
        return [.cancelRecoveryWindow]
    }

    private func handleAnchorResolved(id: AnchorID) -> [OutputIntent] {
        guard pendingAnchor == id else { return [] }
        pendingAnchor = nil
        // Scroll to the resolved anchor at center.
        return [.scrollToMessage(id: id, anchor: .center)]
    }

    private func handleContainerWidthChanged() -> [OutputIntent] {
        var intents: [OutputIntent] = []

        switch mode {
        case .initialLoad, .followingBottom:
            // Re-pin to bottom after resize with a recovery window.
            intents.append(.startRecoveryWindow)
            intents.append(.scrollToBottom(animated: false))
        case .freeBrowsing:
            // Stabilize during resize to maintain reading position.
            beginStabilization(.resize)
        case .stabilizing:
            // Already stabilizing — restart the resize window so overlapping
            // resize events don't get dropped. Mirrors MessageListView+Lifecycle
            // which unconditionally calls beginStabilization(.resize).
            beginStabilization(.resize)
        case .programmaticScroll:
            break
        }

        return intents
    }

    // MARK: - User-Initiated Pin (CTA tap)

    /// Handles a user-initiated scroll-to-bottom (e.g. tapping the CTA).
    /// Always succeeds — user intent overrides all mode checks.
    func requestUserInitiatedPin() -> [OutputIntent] {
        lastUserInitiatedPinTime = Date()
        transition(to: .followingBottom)
        return [
            .hideIndicators,
            .startRecoveryWindow,
            .scrollToBottom(animated: true)
        ]
    }

    // MARK: - Bottom State Updates

    /// Called by the view layer to report whether the viewport is at the bottom.
    /// Uses asymmetric thresholds (hysteresis) to prevent oscillation during
    /// streaming: the "leave" threshold (30pt) is wider than the "enter"
    /// threshold (10pt).
    func updateBottomState(distanceFromBottom: CGFloat) {
        let nowAtBottom: Bool
        if isAtBottom {
            // Stay "at bottom" until clearly scrolled away.
            nowAtBottom = distanceFromBottom.isFinite && distanceFromBottom <= 30
        } else {
            // Only re-enter "at bottom" when truly close.
            nowAtBottom = distanceFromBottom.isFinite && distanceFromBottom <= 10
        }
        isAtBottom = nowAtBottom
    }

    // MARK: - Mode Transitions

    private func transition(to newMode: Mode) {
        let oldMode = mode
        guard oldMode != newMode else { return }

        // Exit actions.
        switch oldMode {
        case .stabilizing:
            if case .stabilizing = newMode {
                // Staying in stabilizing — preserve window count.
            } else {
                activeStabilizationCount = 0
            }
        default:
            break
        }

        mode = newMode
    }

    // MARK: - Stabilization

    private func beginStabilization(_ reason: StabilizationReason) {
        let previousMode: StabilizedMode
        switch mode {
        case .followingBottom, .initialLoad:
            previousMode = .followingBottom
        case .freeBrowsing:
            previousMode = .freeBrowsing
        case .stabilizing(let prev, let activeReason):
            previousMode = prev
            if activeReason == reason {
                // Same-reason re-entry — increment count but don't re-transition.
                activeStabilizationCount += 1
                return
            }
        case .programmaticScroll:
            return
        }

        activeStabilizationCount += 1
        transition(to: .stabilizing(previousMode: previousMode, reason: reason))
    }

    /// Ends one stabilization window. Only restores the previous mode
    /// when all overlapping windows have completed.
    func endStabilization() {
        guard case .stabilizing(let previousMode, _) = mode else { return }
        activeStabilizationCount = max(0, activeStabilizationCount - 1)
        guard activeStabilizationCount == 0 else { return }
        switch previousMode {
        case .followingBottom:
            transition(to: .followingBottom)
        case .freeBrowsing:
            transition(to: .freeBrowsing)
        }
    }

    // MARK: - Reattach

    private func reattachAtBottom() {
        switch mode {
        case .freeBrowsing, .initialLoad, .programmaticScroll:
            transition(to: .followingBottom)
        case .stabilizing, .followingBottom:
            break
        }
    }

    // MARK: - Reset

    /// Resets the coordinator for a conversation switch.
    func reset() {
        mode = .initialLoad
        phase = .idle
        isAtBottom = false
        activeStabilizationCount = 0
        lastUserInitiatedPinTime = nil
        pendingAnchor = nil
    }
}
