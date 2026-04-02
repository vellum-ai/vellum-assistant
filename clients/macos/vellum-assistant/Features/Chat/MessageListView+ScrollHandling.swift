import os
import os.signpost
import SwiftUI
import VellumAssistantShared

extension MessageListView {

    // MARK: - Scroll geometry handler

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
        // Only clear push-to-top if the pin request succeeds.
        // When the user has detached from bottom, pinToBottom returns
        // false. Clearing pushToTopMessageId without a successful pin
        // removes the tail spacer without the accompanying scroll
        // adjustment, causing a content-height discontinuity that
        // makes the scroll position jump.
        if scrollState.mode.pushToTopMessageId != nil && distanceFromBottom > 50 {
            scrollState.handlePushToTopOverflow()
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
        let anchorId = scrollState.cachedFirstVisibleMessageId
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

    /// Configures scroll action closures on the scroll state so it can
    /// perform programmatic scrolls via the view-owned ScrollPosition.
    func configureScrollCallbacks() {
        let binding = $scrollPosition
        scrollState.scrollTo = { id, anchor in
            if let stringId = id as? String {
                binding.wrappedValue.scrollTo(id: stringId, anchor: anchor)
            } else if let uuidId = id as? UUID {
                binding.wrappedValue.scrollTo(id: uuidId, anchor: anchor)
            }
        }
        scrollState.scrollToEdge = { edge in
            binding.wrappedValue.scrollTo(edge: edge)
        }
        scrollState.currentConversationId = conversationId
    }
}
