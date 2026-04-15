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
        // With inverted scroll the visual top (oldest messages) is where
        // distanceFromTop approaches 0. Negate so the sentinel's
        // `sentinelMinY > -triggerBand` fires near the visual top.
        handlePaginationSentinel(sentinelMinY: -scrollState.distanceFromTop)
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
        let scrollBinding = $scrollPosition
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
                    try? await Task.sleep(nanoseconds: 100_000_000)
                    guard !Task.isCancelled else { return }
                    os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested", "target=paginationAnchor")
                    // .bottom in scroll coordinates = visual top in inverted scroll
                    scrollBinding.wrappedValue = ScrollPosition(id: id, anchor: .bottom)
            }
        }
    }

    // MARK: - Scroll helpers

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

}
