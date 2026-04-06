import os
import os.signpost
import SwiftUI
import VellumAssistantShared

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
        // --- Scroll direction detection ---
        let effectiveContentHeight = newState.contentHeight - scrollState.tailSpacerHeight
        let isScrollable = effectiveContentHeight > newState.containerHeight || scrollState.mode.pushToTopMessageId != nil
        let isScrollingUp = newState.contentOffsetY < scrollState.lastContentOffsetY
        scrollState.scrollContentHeight = newState.contentHeight
        scrollState.scrollContainerHeight = newState.containerHeight
        scrollState.lastContentOffsetY = newState.contentOffsetY

        // Only detach on direct user gesture (interacting), not momentum.
        // Only detach when content is scrollable (prevents false detaches
        // on short conversations).
        if scrollState.scrollPhase == .interacting && isScrollingUp && isScrollable {
            scrollState.scrollRestoreTask?.cancel()
            scrollState.scrollRestoreTask = nil
            scrollState.handleUserScrollUp()
        }

        // --- Viewport height update ---
        // Filter non-finite viewport heights and sub-pixel jitter.
        // A 0.5pt dead-zone prevents floating-point rounding differences
        // from triggering continuous updates that feed back into layout.
        let decision = PreferenceGeometryFilter.evaluate(
            newValue: newState.visibleRectHeight,
            previous: scrollState.viewportHeight,
            deadZone: 0.5
        )
        if case .accept(let accepted) = decision {
            os_signpost(.begin, log: PerfSignposts.log, name: "viewportHeightChanged")
            scrollState.viewportHeight = accepted
            os_signpost(.end, log: PerfSignposts.log, name: "viewportHeightChanged")
        }

        // --- Bottom detection (with hysteresis) ---
        // Asymmetric thresholds prevent oscillation during streaming:
        // content-height growth can briefly push distanceFromBottom past
        // the "at bottom" threshold before the scroll position catches
        // up, causing rapid true→false→true flips. A wider leave
        // threshold absorbs those transient spikes without overly
        // widening the idle-reattach zone (onScrollPhaseChange reattaches
        // when isAtBottom is true on idle).
        let distanceFromBottom = effectiveContentHeight - newState.contentOffsetY - newState.visibleRectHeight
        let nowAtBottom: Bool
        if scrollState.isAtBottom {
            // Stay "at bottom" until clearly scrolled away.
            nowAtBottom = distanceFromBottom.isFinite && distanceFromBottom <= 30
        } else {
            // Only re-enter "at bottom" when truly close.
            nowAtBottom = distanceFromBottom.isFinite && distanceFromBottom <= 10
        }
        if scrollState.isAtBottom != nowAtBottom {
            scrollState.isAtBottom = nowAtBottom
            if nowAtBottom {
                scrollState.handleReachedBottom()
            }
        }

        // --- Push-to-top overflow detection ---
        // Exit push-to-top when the user manually scrolls down past
        // the push-to-top zone. Gated on user-initiated scroll phases
        // (.interacting / .decelerating) so the programmatic animation
        // that positions the message at .top doesn't immediately
        // trigger overflow (distanceFromBottom is large during that
        // animation, which would undo the push-to-top instantly).
        // The onScrollPhaseChange handler separately covers the case
        // where the user scrolls to the bottom and the phase settles.
        if scrollState.mode.pushToTopMessageId != nil && distanceFromBottom > 50
            && (scrollState.scrollPhase == .interacting || scrollState.scrollPhase == .decelerating) {
            scrollState.handlePushToTopOverflow()
            scrollPosition = ScrollPosition(edge: .bottom)
        }

        // --- Pagination trigger ---
        // Derive pagination from scroll offset instead of a
        // GeometryReader+PreferenceKey sentinel inside the
        // LazyVStack. The old sentinel reported minY in the
        // ScrollView coordinate space (0 at viewport top,
        // negative when scrolled past). contentOffsetY has
        // inverted sign (0 at top, positive when scrolled
        // down), so we negate to preserve the same semantics.
        handlePaginationSentinel(
            sentinelMinY: -newState.contentOffsetY
        )
    }

    // MARK: - Pagination sentinel

    /// Evaluates a pagination sentinel preference change and triggers pagination
    /// if the sentinel entered the trigger band.
    func handlePaginationSentinel(sentinelMinY: CGFloat) {
        guard PreferenceGeometryFilter.evaluate(
            newValue: sentinelMinY,
            previous: .infinity,
            deadZone: 0
        ) != .rejectNonFinite else { return }

        let isInRange = MessageListPaginationTriggerPolicy.isInTriggerBand(
            sentinelMinY: sentinelMinY,
            viewportHeight: scrollState.viewportHeight
        )
        let shouldFire = MessageListPaginationTriggerPolicy.shouldTrigger(
            sentinelMinY: sentinelMinY,
            viewportHeight: scrollState.viewportHeight,
            wasInRange: scrollState.wasPaginationTriggerInRange
        )
        guard shouldFire,
              hasMoreMessages,
              !isLoadingMoreMessages,
              !scrollState.isPaginationInFlight
        else { return }

        guard Date().timeIntervalSince(scrollState.lastPaginationCompletedAt) > 0.5 else { return }

        // Fire pagination — update edge state only now so guard rejections
        // (including cooldown) don't consume the one-shot rising edge.
        scrollState.wasPaginationTriggerInRange = isInRange
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
            if anchorMessageId == nil
                && !scrollState.hasBeenInteracted
            {
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

    /// Configures scroll action closures on the scroll state.
    /// Uses `ScrollViewReader`'s proxy for `scrollTo` — the newer
    /// `ScrollPosition.scrollTo(id:anchor:)` has known reliability
    /// issues with `LazyVStack` on macOS 15 where programmatic
    /// scrolls silently fail. `ScrollViewProxy.scrollTo` (available
    /// since macOS 11) is the battle-tested alternative.
    /// Ref: https://developer.apple.com/documentation/swiftui/scrollviewproxy
    func configureScrollCallbacks(proxy: ScrollViewProxy) {
        scrollState.scrollTo = { id, anchor in
            if let stringId = id as? String {
                proxy.scrollTo(stringId, anchor: anchor)
            } else if let uuidId = id as? UUID {
                proxy.scrollTo(uuidId, anchor: anchor)
            }
        }
        let binding = $scrollPosition
        scrollState.scrollToEdge = { edge in
            binding.wrappedValue.scrollTo(edge: edge)
        }
        scrollState.clearScrollPositionBinding = {
            binding.wrappedValue = ScrollPosition()
        }
        // NOTE: currentConversationId is intentionally NOT set here.
        // It is set in handleAppear() AFTER the conversation-switch check,
        // because child onAppear fires before parent onAppear in SwiftUI.
    }
}
