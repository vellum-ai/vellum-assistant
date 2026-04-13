import os
import os.signpost
import SwiftUI
import VellumAssistantShared

// MARK: - ScrollCoordinator.Phase Bridge

extension ScrollCoordinator.Phase {
    /// Maps SwiftUI's `ScrollPhase` to the coordinator's phase abstraction.
    /// Lives in the view layer (not in ScrollCoordinator) to keep the
    /// coordinator free of SwiftUI imports.
    static func from(_ phase: ScrollPhase) -> ScrollCoordinator.Phase {
        switch phase {
        case .idle: .idle
        case .interacting: .interacting
        case .tracking: .interacting
        case .decelerating: .decelerating
        case .animating: .animating
        @unknown default: .idle
        }
    }
}

extension MessageListView {

    // MARK: - Coordinator Intent Execution

    /// Translates `ScrollCoordinator.OutputIntent`s into concrete scroll
    /// mutations on `scrollState` / `ScrollPosition`. The coordinator is
    /// the policy layer; this method is the execution layer.
    func executeCoordinatorIntents(_ intents: [ScrollCoordinator.OutputIntent]) {
        for intent in intents {
            switch intent {
            case .scrollToBottom(let animated):
                if animated {
                    scrollState.scheduleDeferredBottomPin(animated: true)
                } else {
                    scrollState.requestPinToBottom(animated: false)
                }

            case .scrollToMessage(let anchorId, let anchor):
                let unitPoint: UnitPoint
                switch anchor {
                case .top: unitPoint = .top
                case .center: unitPoint = .center
                case .bottom: unitPoint = .bottom
                }
                scrollState.performScrollTo(anchorId.rawValue, anchor: unitPoint)

            case .showScrollToLatest:
                // The coordinator signals that the CTA should appear.
                // scrollState's mode-based UI sync handles visibility;
                // this is a forward-looking hook for when the coordinator
                // fully owns the CTA lifecycle.
                break

            case .hideIndicators:
                // Forward-looking hook — scrollState's syncUIImmediately
                // handles indicator visibility for now.
                break

            case .startRecoveryWindow:
                scrollState.bottomAnchorAppeared = false
                scrollState.recoveryDeadline = Date().addingTimeInterval(2.0)

            case .cancelRecoveryWindow:
                scrollState.recoveryDeadline = nil
            }
        }
    }
}

extension MessageListView {

    // MARK: - Scroll geometry handler

    /// Coalesces `onScrollGeometryChange` updates onto the next main-actor turn.
    ///
    /// macOS 26's `OnScrollGeometryChange` modifier faults when its action
    /// causes enough synchronous view-affecting state mutations to re-enter
    /// the modifier in the same frame. We only store the latest geometry
    /// snapshot inside the callback, then process it after the callback unwinds.
    func enqueueScrollGeometryUpdate(_ newState: ScrollGeometrySnapshot) {
        ScrollGeometryUpdateDispatcher.shared.enqueue(for: scrollState, snapshot: newState) { snapshot in
            handleScrollGeometryUpdate(snapshot)
        }
    }

    func handleScrollGeometryUpdate(_ newState: ScrollGeometrySnapshot) {
        // --- Update geometry on scroll state ---
        scrollState.scrollContentHeight = newState.contentHeight
        scrollState.scrollContainerHeight = newState.containerHeight
        scrollState.lastContentOffsetY = newState.contentOffsetY

        // --- Viewport height update ---
        // Filter non-finite viewport heights and sub-pixel jitter.
        let decision = PreferenceGeometryFilter.evaluate(
            newValue: newState.visibleRectHeight,
            previous: scrollState.viewportHeight,
            deadZone: 0.5
        )
        if case .accept(let accepted) = decision {
            scrollState.viewportHeight = accepted
        }

        // --- Distance-based scroll-to-latest CTA ---
        scrollState.updateScrollToLatest()

        // --- Pagination ---
        handlePaginationSentinel(sentinelMinY: -newState.contentOffsetY)
    }

    // MARK: - Pagination sentinel

    /// Triggers pagination when the sentinel enters the trigger band.
    /// Uses rising-edge detection with a 500ms cooldown (via scrollState).
    func handlePaginationSentinel(sentinelMinY: CGFloat) {
        guard PreferenceGeometryFilter.evaluate(
            newValue: sentinelMinY,
            previous: .infinity,
            deadZone: 0
        ) != .rejectNonFinite else { return }

        guard scrollState.handlePaginationSentinel(sentinelMinY: sentinelMinY),
              hasMoreMessages,
              !isLoadingMoreMessages,
              !scrollState.isPaginationInFlight
        else { return }

        scrollState.isPaginationInFlight = true
        let anchorId = scrollState.derivedStateCache.cachedFirstVisibleMessageId
        let taskConversationId = scrollState.currentConversationId
        os_signpost(.event, log: PerfSignposts.log, name: "paginationSentinelFired")
        scrollState.paginationTask = Task { [scrollState] in
            defer {
                if !Task.isCancelled {
                    scrollState.lastPaginationCompletedAt = Date()
                    scrollState.isPaginationInFlight = false
                    scrollState.paginationTask = nil
                } else if scrollState.paginationTask == nil,
                          scrollState.currentConversationId == taskConversationId {
                    scrollState.lastPaginationCompletedAt = Date()
                    scrollState.isPaginationInFlight = false
                }
            }
            let hadMore = await loadPreviousMessagePage?() ?? false
            if hadMore, let id = anchorId {
                    scrollState.beginStabilization(.pagination)
                    try? await Task.sleep(nanoseconds: 100_000_000)
                    guard !Task.isCancelled else {
                        scrollState.endStabilization()
                        return
                    }
                    os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested", "target=paginationAnchor")
                    scrollState.performScrollTo(id, anchor: .top)
                    scrollState.endStabilization()
            }
        }
    }

    // MARK: - Scroll helpers

    /// Restores scroll-to-bottom after a conversation load or app restart.
    /// Issues a delayed fallback pin that catches cases where the declarative
    /// `ScrollPosition(edge: .bottom)` hasn't fully resolved for the new content.
    /// The `isAtBottom` guard is intentionally omitted: during a conversation
    /// switch, `isAtBottom` is unreliable because scroll geometry hasn't updated
    /// yet for the new content. An extra pin when already at bottom is a no-op.
    func restoreScrollToBottom() {
        scrollState.scrollRestoreTask?.cancel()
        scrollState.scrollRestoreTask = Task { @MainActor [scrollState] in
            try? await Task.sleep(nanoseconds: 100_000_000)
            guard !Task.isCancelled else { return }
            if anchorMessageId == nil,
               case .freeBrowsing = scrollState.mode {
                // User scrolled away during the restore window — respect that.
            } else if anchorMessageId == nil,
                      case .programmaticScroll = scrollState.mode {
                // A deep-link anchor scroll resolved and cleared anchorMessageId
                // before this task fired. Don't yank the viewport back to bottom.
            } else if anchorMessageId == nil,
                      case .stabilizing = scrollState.mode {
                // A resize or expansion stabilization started during the
                // restore window. Overriding with .followingBottom would
                // leak activeStabilizationCount — endStabilization() checks
                // `guard case .stabilizing = mode` and bails if mode changed.
            } else if anchorMessageId == nil {
                os_signpost(.event, log: PerfSignposts.log, name: "scrollRestoreStage", "stage=fallback")
                scrollState.transition(to: .followingBottom)
                scrollState.requestPinToBottom()
            }
            scrollState.scrollRestoreTask = nil
        }
    }

    /// Flash-highlights a message and schedules auto-dismiss after 1.5 seconds.
    func flashHighlight(messageId: UUID) {
        scrollState.highlightDismissTask?.cancel()
        highlightedMessageId = messageId
        scrollState.highlightDismissTask = Task { @MainActor [scrollState] in
            do {
                try await Task.sleep(nanoseconds: 1_500_000_000)
            } catch { return }
            guard !Task.isCancelled else { return }
            withAnimation(VAnimation.slow) {
                highlightedMessageId = nil
            }
            scrollState.highlightDismissTask = nil
        }
    }

    /// Configures scroll action closures on the scroll state so it can
    /// perform programmatic scrolls via the view-owned ScrollPosition.
    func configureScrollCallbacks() {
        let binding = $scrollPosition
        // Replace the entire ScrollPosition value instead of calling the
        // mutating `.scrollTo(id:anchor:)` method. Value replacement
        // forces SwiftUI to process a fresh scroll command every time.
        // The `.scrollTo()` method can be silently deduped when the
        // position was previously set to the same ID (e.g. from a
        // conversation switch `ScrollPosition(id: lastId, .bottom)`) —
        // even after the user has scrolled away, the internal state may
        // still consider itself "at" that ID.
        scrollState.scrollTo = { id, anchor in
            if let uuidId = id as? UUID {
                binding.wrappedValue = ScrollPosition(id: uuidId, anchor: anchor)
            } else if let stringId = id as? String {
                binding.wrappedValue = ScrollPosition(id: stringId, anchor: anchor)
            }
        }
        // Replace the entire ScrollPosition value (same as the ID-based
        // closure above) instead of calling the mutating `.scrollTo(edge:)`
        // method. Value replacement forces SwiftUI to process a fresh
        // scroll command every time. The mutating method can be silently
        // deduped when SwiftUI considers the position "already at that
        // edge" — the same class of bug that affected `.scrollTo(id:)`.
        // After SwiftUI processes the edge scroll, it updates the binding
        // to the actual content offset, so the next value replacement
        // with ScrollPosition(edge:) is always a new value.
        scrollState.scrollToEdge = { edge in
            binding.wrappedValue = ScrollPosition(edge: edge)
        }
        // Cancel in-flight spring animations on the scroll position.
        //
        // SwiftUI's `withAnimation { scrollPosition = ScrollPosition(...) }`
        // creates a SwiftUI-managed spring animation that does NOT cancel
        // when the user starts a new scroll gesture — unlike UIKit's
        // `UIScrollView.setContentOffset(animated:)` which cancels on touch.
        //
        // Writing an empty `ScrollPosition()` (no target) with animations
        // disabled overwrites the animated value, cancelling the spring.
        // During `.interacting` phase the user's gesture has priority, so
        // the empty position doesn't move the viewport — it just stops the
        // animation from fighting the user's drag.
        scrollState.cancelScrollAnimation = {
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                binding.wrappedValue = ScrollPosition()
            }
        }
        scrollState.currentConversationId = conversationId
    }
}
