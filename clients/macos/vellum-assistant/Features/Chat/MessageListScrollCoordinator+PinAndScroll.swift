import Foundation
import os
import SwiftUI
import VellumAssistantShared

// MARK: - Pin Requests, Scroll Handling, and Pagination

extension MessageListScrollCoordinator {

    // MARK: - Scroll Methods

    /// Sentinel UUID used for pin requests before the daemon assigns a real
    /// conversation ID. Lets bootstrap-window requests coalesce normally.
    static let bootstrapConversationId = UUID(uuidString: "00000000-0000-0000-0000-000000000000")!

    /// Performs a programmatic scroll to the given item ID and anchor point,
    /// using the `scrollTo` closure configured during setup.
    func performScrollTo(_ id: any Hashable, anchor: UnitPoint? = nil) {
        scrollTo?(id, anchor)
    }

    /// Routes a bottom-follow request directly.
    /// Pass `userInitiated: true` for explicit user actions (e.g. "Scroll to latest" button)
    /// to bypass both follow-state and suppression checks — user intent always wins.
    @discardableResult
    func requestBottomPin(
        reason: BottomPinRequestReason,
        conversationId: UUID?,
        animated: Bool = false,
        userInitiated: Bool = false
    ) -> Bool {
        // User-initiated scrolls bypass both the follow-state and suppression
        // checks entirely — user intent always wins over defensive guards.
        if userInitiated {
            os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested",
                        "target=bottomAnchor reason=userInitiated")
            if animated {
                withAnimation(VAnimation.fast) {
                    performScrollTo("scroll-bottom-anchor", anchor: .bottom)
                }
            } else {
                performScrollTo("scroll-bottom-anchor", anchor: .bottom)
            }
            return true
        }

        // Non-user-initiated requests are gated on BOTH follow-state and
        // suppression. The isFollowingBottom check prevents yanking detached
        // users to the bottom. The !isSuppressed check prevents auto-scroll
        // from fighting pagination, expansion, and resize suppression.
        guard isFollowingBottom else {
            scrollCoordinatorLog.debug("[BottomPin] suppressed reason=\(reason.rawValue) isFollowingBottom=false")
            return false
        }
        guard !isSuppressed else {
            scrollCoordinatorLog.debug("[BottomPin] suppressed reason=\(reason.rawValue) isSuppressed=true")
            return false
        }

        os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested",
                    "target=bottomAnchor reason=%{public}s", reason.rawValue)
        recordScrollLoopEvent(.scrollToRequested, conversationId: currentConversationId)
        if animated {
            withAnimation(VAnimation.fast) {
                performScrollTo("scroll-bottom-anchor", anchor: .bottom)
            }
        } else {
            performScrollTo("scroll-bottom-anchor", anchor: .bottom)
        }
        return true
    }

    /// Configures the scroll coordinator's bindings and seeds initial state.
    /// Stores the `isNearBottom` binding so `detachFromBottom` / `reattachToBottom`
    /// can update it directly without callback indirection.
    func configureScrollCallbacks(
        scrollViewportHeight: CGFloat,
        conversationId: UUID?,
        isNearBottom: Binding<Bool>
    ) {
        // Seed the live state so closures have a valid value immediately.
        currentConversationId = conversationId
        currentScrollViewportHeight = scrollViewportHeight
        isNearBottomBinding = isNearBottom

        // If detachFromBottom() was called before this binding was stored,
        // sync isNearBottom now so it isn't stuck at true permanently.
        if !isFollowingBottom {
            isNearBottom.wrappedValue = false
        }
    }

    /// Delayed scroll-to-bottom fallback that catches cases where the preceding
    /// `scrollToEdge(.bottom)` fires before SwiftUI has fully laid out the content.
    ///
    /// All callers now perform `scrollToEdge(.bottom)` before invoking this method
    /// (both `conversationSwitched` and `onAppear`). This single 100ms delayed
    /// fallback uses the ID-based `requestBottomPin` as a belt-and-suspenders check
    /// for cases where the edge scroll fires before content layout is complete.
    func restoreScrollToBottom(
        conversationId: UUID?,
        anchorMessageId: Binding<UUID?>
    ) {
        scrollRestoreTask?.cancel()

        scrollRestoreTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 100_000_000)
            guard !Task.isCancelled, let self else { return }
            if anchorMessageId.wrappedValue == nil
                && !self.hasReceivedScrollEvent
                && !self.isAtBottom
            {
                os_signpost(.event, log: PerfSignposts.log, name: "scrollRestoreStage", "stage=fallback")
                self.requestBottomPin(reason: .initialRestore, conversationId: conversationId)
            }
            self.scrollRestoreTask = nil
        }
    }

    // MARK: - User Scroll Actions

    /// Handles physical scroll-wheel/trackpad upward movement.
    func handleScrollUp() {
        scrollRestoreTask?.cancel()
        scrollRestoreTask = nil
        clearAllSuppression()
        pushToTopMessageId = nil
        detachFromBottom()
        hasReceivedScrollEvent = true
    }

    /// Handles user explicitly scrolling to the bottom.
    func handleScrollToBottom() {
        scrollRestoreTask?.cancel()
        scrollRestoreTask = nil
        clearAllSuppression()
        reattachToBottom()
        hasReceivedScrollEvent = true
    }

    /// Handles the suppress-auto-scroll environment action from child views.
    func handleSuppressAutoScroll(
        isNearBottom: Bool,
        conversationId: UUID?,
        scrollViewportHeight: CGFloat
    ) {
        // Cancel any pending expansion timeout before re-evaluating.
        removeSuppression(.expansion)
        if isNearBottom {
            os_signpost(.event, log: PerfSignposts.log, name: "scrollSuppressionChanged", "on reason=expansionPinning")
            recordScrollLoopEvent(.suppressionFlip, conversationId: conversationId, isNearBottom: isNearBottom, scrollViewportHeight: scrollViewportHeight)
            requestBottomPin(reason: .expansion, conversationId: conversationId, animated: false)
        } else {
            os_signpost(.event, log: PerfSignposts.log, name: "scrollSuppressionChanged", "on reason=offBottomExpansion")
            recordScrollLoopEvent(.suppressionFlip, conversationId: conversationId, isNearBottom: isNearBottom, scrollViewportHeight: scrollViewportHeight)
            // Add expansion suppression with auto-timeout. Each OptionSet bit
            // is independent, so removal is unconditional — no resize/pagination
            // guards needed (those have their own suppression bits and timeouts).
            addSuppression(.expansion)
        }
    }

    // MARK: - Resize

    /// Creates a resize scroll stabilization task. The caller is responsible for
    /// assigning the returned task to the view-local `resizeScrollTask` state and
    /// cancelling any previous task before calling this.
    func makeResizeTask(
        conversationId: UUID?,
        isNearBottom: Bool,
        anchorMessageId: UUID?,
        onComplete: @escaping @MainActor () -> Void
    ) -> Task<Void, Never> {
        Task { @MainActor [weak self] in
            guard let self else { return }
            // Use inline suppression for resize since we manage the lifecycle
            // within this task (similar to pagination). Cancel the auto-timeout
            // from addSuppression so the defer block controls removal.
            self.addSuppression(.resize)
            self.suppressionTimeoutTasks[ScrollSuppression.resize.rawValue]?.cancel()
            self.suppressionTimeoutTasks[ScrollSuppression.resize.rawValue] = nil
            defer {
                if !Task.isCancelled { onComplete() }
            }
            try? await Task.sleep(nanoseconds: 100_000_000)
            guard !Task.isCancelled else {
                self.removeSuppression(.resize)
                return
            }
            // Remove suppression BEFORE the pin request so it isn't rejected.
            self.removeSuppression(.resize)
            if isNearBottom && anchorMessageId == nil && !self.isAtBottom {
                self.requestBottomPin(reason: .resize, conversationId: conversationId)
            }
        }
    }

    // MARK: - Pagination

    /// Fires a single pagination load, restores the scroll anchor, and
    /// manages the `isPaginationInFlight` / suppression guards.
    func triggerPagination(
        visibleMessages: [ChatMessage],
        conversationId: UUID?,
        loadPreviousMessagePage: (() async -> Bool)?
    ) {
        guard !isPaginationInFlight else { return }
        isPaginationInFlight = true
        // Pagination scroll-position restore is higher priority than bottom-pin.
        // No active session to cancel (sessions were removed in PR 1).
        let anchorId = visibleMessages.first?.id
        os_signpost(.event, log: PerfSignposts.log, name: "paginationSentinelFired")
        scrollCoordinatorLog.debug("[pagination] fired — anchorId: \(String(describing: anchorId))")
        paginationTask = Task { [weak self] in
            guard let self else { return }
            defer {
                if !Task.isCancelled {
                    isPaginationInFlight = false
                    paginationTask = nil
                } else if paginationTask == nil {
                    isPaginationInFlight = false
                }
            }
            let hadMore = await loadPreviousMessagePage?() ?? false
            scrollCoordinatorLog.debug("[pagination] loadPreviousMessagePage returned hadMore=\(hadMore)")
            if hadMore, let id = anchorId {
                // Use inline suppression for pagination since we need to
                // hold suppression across the sleep + scroll restore sequence.
                // The timeout task from addSuppression is cancelled immediately
                // after the scroll restore to keep the inline timing exact.
                addSuppression(.pagination)
                // Cancel the auto-timeout — we manage the lifecycle inline.
                suppressionTimeoutTasks[ScrollSuppression.pagination.rawValue]?.cancel()
                suppressionTimeoutTasks[ScrollSuppression.pagination.rawValue] = nil
                try? await Task.sleep(nanoseconds: 100_000_000)
                guard !Task.isCancelled else {
                    removeSuppression(.pagination)
                    return
                }
                os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested", "target=paginationAnchor")
                recordScrollLoopEvent(.scrollToRequested, conversationId: conversationId)
                performScrollTo(id, anchor: .top)
                scrollCoordinatorLog.debug("[pagination] scroll restored to anchor \(id)")
                removeSuppression(.pagination)
            }
        }
    }

    /// Evaluates a pagination sentinel preference change and triggers pagination
    /// if the sentinel entered the trigger band. Returns true if pagination was triggered.
    @discardableResult
    func handlePaginationSentinel(
        sentinelMinY: CGFloat,
        scrollViewportHeight: CGFloat,
        hasMoreMessages: Bool,
        isLoadingMoreMessages: Bool,
        visibleMessages: [ChatMessage],
        conversationId: UUID?,
        loadPreviousMessagePage: (() async -> Bool)?
    ) -> Bool {
        guard PreferenceGeometryFilter.evaluate(
            newValue: sentinelMinY,
            previous: .infinity,
            deadZone: 0
        ) != .rejectNonFinite else { return false }

        let isInRange = MessageListPaginationTriggerPolicy.isInTriggerBand(
            sentinelMinY: sentinelMinY,
            viewportHeight: scrollViewportHeight
        )
        let shouldFire = MessageListPaginationTriggerPolicy.shouldTrigger(
            sentinelMinY: sentinelMinY,
            viewportHeight: scrollViewportHeight,
            wasInRange: wasPaginationTriggerInRange
        )
        wasPaginationTriggerInRange = isInRange

        guard shouldFire,
              hasMoreMessages,
              !isLoadingMoreMessages,
              !isPaginationInFlight
        else { return false }

        triggerPagination(
            visibleMessages: visibleMessages,
            conversationId: conversationId,
            loadPreviousMessagePage: loadPreviousMessagePage
        )
        return true
    }
}
