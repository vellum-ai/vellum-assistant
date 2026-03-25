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
    private func performScrollTo(_ id: any Hashable, anchor: UnitPoint? = nil) {
        scrollTo?(id, anchor)
    }

    /// Routes a bottom-follow request through the coordinator.
    /// Returns `false` when the scroll loop guard is tripped, suppressing the request.
    /// Pass `userInitiated: true` for explicit user actions (e.g. "Scroll to latest" button)
    /// to bypass the loop guard and suppression checks — user intent always wins.
    @discardableResult
    func requestBottomPin(
        reason: BottomPinRequestReason,
        conversationId: UUID?,
        animated: Bool = false,
        userInitiated: Bool = false
    ) -> Bool {
        let convIdString = (conversationId ?? Self.bootstrapConversationId).uuidString
        if !userInitiated, scrollLoopGuard.isTripped(conversationId: convIdString) {
            os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested",
                        "target=bottomAnchor reason=circuitBreakerSuppressed-requestBottomPin")
            return false
        }

        // User-initiated scrolls bypass the coordinator session and suppression
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

        let convId = conversationId ?? Self.bootstrapConversationId
        bottomPinCoordinator.requestPin(
            reason: reason,
            conversationId: convId,
            animated: animated
        )
        return true
    }

    /// Configures the coordinator's callbacks to wire pin requests back to
    /// the scroll position and follow-state changes back to `isNearBottom`.
    ///
    /// Closures capture `[weak self]` and read `self.currentConversationId`
    /// and `self.currentScrollViewportHeight` so they always use the live
    /// value — not a stale snapshot from configure time.
    func configureBottomPinCoordinator(
        scrollViewportHeight: CGFloat,
        conversationId: UUID?,
        isNearBottom: Binding<Bool>
    ) {
        // Seed the live state so closures have a valid value immediately.
        currentConversationId = conversationId
        currentScrollViewportHeight = scrollViewportHeight

        bottomPinCoordinator.onPinRequested = { [weak self] reason, animated in
            guard let self else { return false }
            guard !isSuppressed else { return false }
            // Circuit breaker: suppress scroll-to when a scroll loop was detected.
            let convIdString = self.currentConversationId?.uuidString ?? "unknown"
            if scrollLoopGuard.isTripped(conversationId: convIdString) {
                os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested",
                            "target=bottomAnchor reason=circuitBreakerSuppressed")
                return false
            }
            os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested",
                        "target=bottomAnchor reason=coordinator-%{public}s", reason.rawValue)
            recordScrollLoopEvent(.scrollToRequested, conversationId: self.currentConversationId)
            if animated {
                withAnimation(VAnimation.fast) {
                    self.performScrollTo("scroll-bottom-anchor", anchor: .bottom)
                }
            } else {
                self.performScrollTo("scroll-bottom-anchor", anchor: .bottom)
            }
            // With ScrollPosition, the scroll is applied immediately — return
            // true to indicate the pin was accepted.
            return true
        }
        bottomPinCoordinator.onFollowStateChanged = { isFollowing in
            isNearBottom.wrappedValue = isFollowing
        }

        // Wire auto-recovery: when the loop guard's cooldown expires, schedule
        // a single deferred re-pin attempt so the UI doesn't get stuck.
        scrollLoopGuard.onRecoveryNeeded = { [weak self] convId in
            guard let self else { return }
            loopGuardRecoveryTask?.cancel()
            loopGuardRecoveryTask = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(ChatScrollLoopGuard.autoRecoveryDelay * 1_000_000_000))
                guard !Task.isCancelled, let self else { return }
                // Only re-pin if the user hasn't scrolled away during the delay.
                guard self.bottomPinCoordinator.isFollowingBottom else {
                    scrollCoordinatorLog.debug("Loop guard auto-recovery: skipping re-pin — user scrolled away for \(convId)")
                    self.loopGuardRecoveryTask = nil
                    return
                }
                scrollCoordinatorLog.debug("Loop guard auto-recovery: attempting re-pin for \(convId)")
                os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested",
                            "target=bottomAnchor reason=loopGuardAutoRecovery")
                self.bottomPinCoordinator.reattach()
                self.requestBottomPin(
                    reason: .initialRestore,
                    conversationId: self.currentConversationId,
                    animated: true
                )
                self.loopGuardRecoveryTask = nil
            }
        }

        // If detach() was called before this callback was wired up, sync
        // isNearBottom now so it isn't stuck at true permanently.
        if !bottomPinCoordinator.isFollowingBottom {
            isNearBottom.wrappedValue = false
        }
    }

    /// Staged scroll-to-bottom that retries after increasing delays to handle
    /// cases where SwiftUI hasn't committed the new content's layout yet.
    ///
    /// The initial `scrollToEdge(.bottom)` in `conversationSwitched` handles
    /// most cases. This method catches slow LazyVStack materialization where
    /// the edge scroll fires before content is fully laid out.
    func restoreScrollToBottom(
        conversationId: UUID?,
        anchorMessageId: Binding<UUID?>
    ) {
        scrollRestoreTask?.cancel()

        scrollRestoreTask = Task { @MainActor [weak self] in
            guard let self, !Task.isCancelled else { return }
            os_signpost(.event, log: PerfSignposts.log, name: "scrollRestoreStage", "stage=0")
            scrollCoordinatorLog.debug("Scroll restore: stage 0 (immediate)")

            // Stage 1: ~3 frames — handles most conversation switches.
            try? await Task.sleep(nanoseconds: 50_000_000)
            guard !Task.isCancelled else { return }
            os_signpost(.event, log: PerfSignposts.log, name: "scrollRestoreStage", "stage=1")
            if anchorMessageId.wrappedValue == nil {
                requestBottomPin(reason: .initialRestore, conversationId: conversationId)
            }
            scrollCoordinatorLog.debug("Scroll restore: stage 1 (50ms)")

            // Stage 2: ~12 frames — catches slower layout/materialization.
            try? await Task.sleep(nanoseconds: 150_000_000)
            guard !Task.isCancelled else { return }
            if anchorMessageId.wrappedValue == nil
                && !hasReceivedScrollEvent
                && !self.isAtBottom
            {
                os_signpost(.event, log: PerfSignposts.log, name: "scrollRestoreStage", "stage=2 action=retry")
                requestBottomPin(reason: .initialRestore, conversationId: conversationId)
                scrollCoordinatorLog.debug("Scroll restore: stage 2 (200ms) — retrying")
            } else {
                os_signpost(.event, log: PerfSignposts.log, name: "scrollRestoreStage", "stage=2 action=skipped")
                scrollCoordinatorLog.debug("Scroll restore: stage 2 skipped (anchor=\(String(describing: anchorMessageId.wrappedValue)) scrollEvent=\(self.hasReceivedScrollEvent) atBottom=\(self.isAtBottom))")
            }

            if !Task.isCancelled { scrollRestoreTask = nil }
        }
    }

    // MARK: - User Scroll Actions

    /// Handles physical scroll-wheel/trackpad upward movement.
    func handleScrollUp() {
        scrollRestoreTask?.cancel()
        scrollRestoreTask = nil
        loopGuardRecoveryTask?.cancel()
        loopGuardRecoveryTask = nil
        clearAllSuppression()
        pushToTopMessageId = nil
        bottomPinCoordinator.handleUserAction(.scrollUp)
        hasReceivedScrollEvent = true
    }

    /// Handles user explicitly scrolling to the bottom.
    func handleScrollToBottom() {
        scrollRestoreTask?.cancel()
        scrollRestoreTask = nil
        clearAllSuppression()
        bottomPinCoordinator.handleUserAction(.scrollToBottom)
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
                if !Task.isCancelled {
                    self.removeSuppression(.resize)
                    onComplete()
                }
            }
            try? await Task.sleep(nanoseconds: 100_000_000)
            guard !Task.isCancelled else { return }

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
        // Pagination scroll-position restore is higher priority — cancel any
        // active pin session so the coordinator doesn't fight the restore.
        bottomPinCoordinator.cancelActiveSession(reason: .paginationRestore)
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
