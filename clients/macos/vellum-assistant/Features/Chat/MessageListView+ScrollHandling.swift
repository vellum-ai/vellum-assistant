import os
import os.signpost
import SwiftUI
import VellumAssistantShared

extension MessageListView {

    // MARK: - Scroll geometry handler

    /// Called from `.onScrollGeometryChange` in the message list body.
    /// Feeds geometry into the simplified scroll coordinator and evaluates
    /// the pagination sentinel.
    func handleScrollGeometryUpdate(_ newState: ScrollGeometrySnapshot) {
        scrollState.contentOffsetY = newState.contentOffsetY
        scrollState.contentHeight = newState.contentHeight
        scrollState.viewportHeight = newState.visibleRectHeight
        scrollState.updateNearBottom()

        if scrollState.isInSendCycle {
            scrollState.updateSpacerForContentGrowth(newContentHeight: newState.contentHeight)
        }

        // Derive sentinel position from content offset (inverted sign to
        // match the old coordinate-space convention where minY is negative
        // when scrolled past the viewport top).
        let sentinelMinY = -newState.contentOffsetY
        let shouldPaginate = scrollState.handlePaginationSentinel(sentinelMinY: sentinelMinY)

        if shouldPaginate, hasMoreMessages, !isLoadingMoreMessages {
            triggerPagination()
        }
    }

    // MARK: - Pagination

    /// Loads the previous page of messages and scrolls to maintain the
    /// user's reading position after new content is prepended.
    private func triggerPagination() {
        os_signpost(.event, log: PerfSignposts.log, name: "paginationSentinelFired")
        Task { @MainActor in
            let anchorId = paginatedVisibleMessages.first?.id
            let hadMore = await loadPreviousMessagePage?() ?? false
            scrollState.lastPaginationCompletedAt = Date()
            if hadMore, let id = anchorId {
                // Brief yield to let SwiftUI process the new content.
                try? await Task.sleep(nanoseconds: 50_000_000)
                scrollProxy?.scrollTo(id, anchor: .top)
            }
        }
    }

    // MARK: - Scroll helpers

    /// Flash-highlights a message and schedules auto-dismiss after 1.5 seconds.
    func flashHighlight(messageId: UUID) {
        highlightedMessageId = messageId
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            withAnimation(VAnimation.slow) {
                highlightedMessageId = nil
            }
        }
    }
}
