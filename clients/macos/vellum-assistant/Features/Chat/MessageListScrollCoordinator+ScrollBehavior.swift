import AppKit
import Foundation
import os
import SwiftUI
import VellumAssistantShared

// MARK: - All Scroll Behavior (Pin, Reactions, Pagination)

extension MessageListScrollCoordinator {

    // MARK: - State Reactions

    /// Reacts to `isSending` transitions. Batches scroll reattach, bottom-pin,
    /// phase tracking, and first-message detection into a single state transition
    /// to avoid cascading re-renders from sequential onChange firings.
    ///
    /// Replaces the former inline `onChange(of: isSending)`,
    /// `onChange(of: assistantActivityPhase)`, and `onChange(of: isThinking)` handlers.
    func sendingStateChanged(
        isSending: Bool,
        isThinking: Bool,
        assistantActivityPhase: String,
        messages: [ChatMessage],
        hasEverSentMessage: inout Bool,
        conversationId: UUID?
    ) {
        if isSending {
            hasReceivedScrollEvent = true
            // Clear stale confirmation marker: if the phase left "awaiting_confirmation"
            // while not sending, the marker is stale. Check current phase to detect this
            // without needing a separate onChange(of: assistantActivityPhase).
            let effectivePhaseWhenSendingStopped: String
            if phaseWhenSendingStopped == "awaiting_confirmation"
                && assistantActivityPhase != "awaiting_confirmation"
            {
                effectivePhaseWhenSendingStopped = assistantActivityPhase
            } else {
                effectivePhaseWhenSendingStopped = phaseWhenSendingStopped
            }
            // Reattach and pin to bottom for user-initiated actions (send,
            // regenerate, retry). Skip reattach only when the daemon resumes
            // from a tool confirmation (not a user action during confirmation).
            let isDaemonConfirmationResume =
                effectivePhaseWhenSendingStopped == "awaiting_confirmation"
                && assistantActivityPhase != "awaiting_confirmation"
            if isDaemonConfirmationResume && !isFollowingBottom {
                // Daemon resumed from confirmation while user was scrolled up.
            } else {
                reattachToBottom()
                // For user-initiated sends, scroll the user's message to
                // the viewport top with space below for the assistant's
                // response. Daemon confirmation resumes stay bottom-pinned.
                if !isDaemonConfirmationResume, let lastUserMsg = messages.last(where: { $0.role == .user }) {
                    pushToTopMessageId = lastUserMsg.id
                    os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested",
                                "target=userMessage reason=pushToTop")
                    withAnimation(VAnimation.fast) {
                        performScrollTo(lastUserMsg.id, anchor: .top)
                    }
                } else {
                    requestBottomPin(
                        reason: .messageCount,
                        conversationId: conversationId,
                        animated: true
                    )
                }
            }
        } else {
            // Capture the activity phase at the moment sending stops.
            phaseWhenSendingStopped = assistantActivityPhase
            // End push-to-top phase and scroll to bottom so the user
            // sees the complete response. Without this, responses that
            // don't trigger overflow detection leave the user stranded
            // near the top.
            let wasPushToTop = pushToTopMessageId != nil
            pushToTopMessageId = nil
            if wasPushToTop && isFollowingBottom {
                requestBottomPin(
                    reason: .messageCount,
                    conversationId: conversationId,
                    animated: true
                )
            }
            // First-message detection.
            if !hasEverSentMessage && messages.contains(where: { $0.role == .user }) {
                hasEverSentMessage = true
            }
        }
    }

    /// Reacts to `messages.count` changes. Handles anchor-message resolution,
    /// bottom-pin requests, stale anchor cleanup, and confirmation focus handoff
    /// in a single coordinated pass.
    ///
    /// Consolidates the former `onChange(of: messages.count)` and
    /// `onChange(of: anchorMessageId)` (partial) handlers. A separate
    /// `onChange(of: currentPendingRequestId)` still exists in the view
    /// for immediate focus handoff on confirmation appearance.
    func messagesChanged(
        messages: [ChatMessage],
        anchorMessageId: inout UUID?,
        highlightedMessageId: Binding<UUID?>,
        hasMoreMessages: Bool,
        isNearBottom: Bool,
        conversationId: UUID?,
        currentPendingRequestId: String?
    ) {
        // --- Anchor message resolution ---
        // Anchor scroll takes priority: when a notification deep-link
        // set anchorMessageId, retry scrolling to it as messages load.
        if let id = anchorMessageId, messages.contains(where: { $0.id == id }) {
            os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested", "target=anchorMessage reason=messagesChanged")
            os_signpost(.event, log: PerfSignposts.log, name: "anchorCleared", "reason=foundInMessages")
            recordScrollLoopEvent(.scrollToRequested, conversationId: conversationId, isNearBottom: isNearBottom)
            // Deep-link anchor takes priority — detach from bottom-follow.
            detachFromBottom()
            withAnimation {
                scrollTo?(id, .center)
            }
            flashHighlight(messageId: id, highlightedMessageId: highlightedMessageId)
            anchorMessageId = nil
            anchorSetTime = nil
            anchorTimeoutTask?.cancel()
            anchorTimeoutTask = nil
            return
        }
        // If anchor is set but the target message still hasn't appeared,
        // check pagination exhaustion with a minimum elapsed time guard.
        if anchorMessageId != nil {
            let paginationExhausted = !hasMoreMessages
            let minWaitElapsed = anchorSetTime.map { Date().timeIntervalSince($0) > 2 } ?? false
            if paginationExhausted && minWaitElapsed {
                os_signpost(.event, log: PerfSignposts.log, name: "anchorCleared", "reason=paginationExhausted")
                scrollCoordinatorLog.debug("Anchor message not found (pagination exhausted) — clearing stale anchor")
                anchorMessageId = nil
                anchorSetTime = nil
                anchorTimeoutTask?.cancel()
                anchorTimeoutTask = nil
                reattachToBottom()
                requestBottomPin(reason: .messageCount, conversationId: conversationId, animated: true)
                return
            }
        }

        // --- Bottom-pin on new messages ---
        // During push-to-top, suppress auto-scroll so content grows
        // naturally below the user message. Overflow detection in the
        // geometry handler transitions back to bottom-pin.
        if pushToTopMessageId != nil && anchorMessageId == nil {
            // no-op: push-to-top suppresses bottom-pin
        } else if isNearBottom && !isSuppressed && anchorMessageId == nil && hasReceivedScrollEvent {
            requestBottomPin(reason: .messageCount, conversationId: conversationId, animated: true)
        } else if isSuppressed {
            scrollCoordinatorLog.debug("Auto-scroll suppressed (bottom-scroll suppression active)")
        }

        // --- Confirmation focus handoff ---
        #if os(macOS)
        handleConfirmationFocusIfNeeded(currentPendingRequestId: currentPendingRequestId)
        #endif
    }

    /// Reacts to `containerWidth` changes. Manages resize scroll stabilization
    /// with suppression and dead-zone filtering.
    ///
    /// Replaces the former inline `onChange(of: containerWidth)` handler.
    /// Returns the new resize task (or nil if the change was filtered out).
    /// The caller is responsible for storing the returned task and cancelling
    /// the previous one before calling this method.
    func containerResized(
        width: CGFloat,
        conversationId: UUID?,
        isNearBottom: Bool,
        anchorMessageId: UUID?,
        previousResizeTask: Task<Void, Never>?,
        onResizeComplete: @escaping @MainActor () -> Void
    ) -> Task<Void, Never>? {
        guard width > 0, abs(width - lastHandledContainerWidth) > 2 else { return previousResizeTask }
        lastHandledContainerWidth = width
        previousResizeTask?.cancel()
        return makeResizeTask(
            conversationId: conversationId,
            isNearBottom: isNearBottom,
            anchorMessageId: anchorMessageId,
            onComplete: onResizeComplete
        )
    }

    /// Reacts to `conversationId` changes. Batches coordinator reset, view-local
    /// state cleanup, phase tracking, and scroll restoration into a single
    /// coordinated transition.
    ///
    /// Replaces the former inline `onChange(of: conversationId)` handler.
    func conversationSwitched(
        oldConversationId: UUID?,
        newConversationId: UUID?,
        isSending: Bool,
        assistantActivityPhase: String,
        containerWidth: CGFloat,
        isNearBottom: inout Bool,
        highlightedMessageId: Binding<UUID?>,
        resizeScrollTask: inout Task<Void, Never>?,
        anchorMessageId: Binding<UUID?>,
        scrollViewportHeight: CGFloat
    ) {
        // Reset view-local state that doesn't belong in the coordinator.
        resizeScrollTask?.cancel()
        resizeScrollTask = nil
        resetForConversationSwitch(
            oldConversationId: oldConversationId,
            newConversationId: newConversationId
        )
        isNearBottom = true
        highlightedMessageId.wrappedValue = nil
        highlightDismissTask?.cancel()
        highlightDismissTask = nil
        // Capture the new conversation's activity phase so a conversation
        // already paused in awaiting_confirmation is correctly tracked.
        phaseWhenSendingStopped = isSending ? "" : assistantActivityPhase
        lastHandledContainerWidth = containerWidth
        anchorTimeoutTask?.cancel()
        anchorTimeoutTask = nil
        // Reset confirmation focus tracking for the new conversation.
        lastAutoFocusedRequestId = nil
        // When switching to a conversation that is already actively sending,
        // .onChange(of: isSending) won't fire (the value doesn't change), so
        // hasReceivedScrollEvent stays false. Set it now so that messagesChanged()
        // can issue programmatic pins for streaming messages in the new conversation.
        if isSending {
            hasReceivedScrollEvent = true
        }
        // Scroll to bottom for the new conversation. All positioning is
        // imperative via ScrollPosition to avoid conflicts with push-to-top.
        scrollRestoreTask?.cancel()
        if anchorMessageId.wrappedValue == nil {
            scrollToEdge?(.bottom)
        }
        restoreScrollToBottom(
            conversationId: newConversationId,
            anchorMessageId: anchorMessageId
        )
    }

    /// Reacts to `anchorMessageId` changes (set externally via notification deep links).
    /// Handles immediate scroll-to-anchor when the target message is loaded, or
    /// starts a timeout task to clear stale anchors.
    ///
    /// Called from a `.task(id: anchorMessageId)` modifier in the view so it fires
    /// on both initial value and subsequent changes without counting as an onChange.
    /// Uses `Binding` instead of `inout` so it can be called from an async context.
    func anchorMessageIdChanged(
        anchorMessageId: Binding<UUID?>,
        messages: [ChatMessage],
        conversationId: UUID?,
        highlightedMessageId: Binding<UUID?>
    ) {
        // Only cancel scroll restore when a new anchor is set (non-nil).
        if anchorMessageId.wrappedValue != nil {
            scrollRestoreTask?.cancel()
            scrollRestoreTask = nil
            // Deep-link anchor takes priority — detach from bottom-follow.
            detachFromBottom()
        }
        anchorSetTime = anchorMessageId.wrappedValue != nil ? Date() : nil
        anchorTimeoutTask?.cancel()
        anchorTimeoutTask = nil
        guard let id = anchorMessageId.wrappedValue else { return }
        os_signpost(.event, log: PerfSignposts.log, name: "anchorSet", "reason=anchorMessageIdChanged")
        if messages.contains(where: { $0.id == id }) {
            os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested", "target=anchorMessage reason=anchorChanged")
            os_signpost(.event, log: PerfSignposts.log, name: "anchorCleared", "reason=foundOnAnchorChange")
            recordScrollLoopEvent(.scrollToRequested, conversationId: conversationId)
            withAnimation {
                scrollTo?(id, .center)
            }
            flashHighlight(messageId: id, highlightedMessageId: highlightedMessageId)
            anchorMessageId.wrappedValue = nil
            anchorSetTime = nil
        } else {
            // Start an independent 10-second timeout that clears the
            // anchor even if messages.count never changes.
            anchorTimeoutTask = Task { @MainActor [weak self] in
                do {
                    try await Task.sleep(nanoseconds: 10_000_000_000)
                } catch { return }
                guard !Task.isCancelled, let self, anchorMessageId.wrappedValue != nil else { return }
                os_signpost(.event, log: PerfSignposts.log, name: "anchorTimedOut")
                scrollCoordinatorLog.debug("Anchor message not found (timed out) — clearing stale anchor")
                anchorMessageId.wrappedValue = nil
                self.anchorSetTime = nil
                self.anchorTimeoutTask = nil
                self.reattachToBottom()
                self.requestBottomPin(reason: .initialRestore, conversationId: conversationId, animated: true)
            }
        }
    }

    /// Flash-highlights a message and schedules auto-dismiss after 1.5 seconds.
    /// Manages the highlight dismiss task internally.
    func flashHighlight(messageId: UUID, highlightedMessageId: Binding<UUID?>) {
        highlightDismissTask?.cancel()
        highlightedMessageId.wrappedValue = messageId
        highlightDismissTask = Task { @MainActor [weak self] in
            do {
                try await Task.sleep(nanoseconds: 1_500_000_000)
            } catch { return }
            guard !Task.isCancelled else { return }
            withAnimation(VAnimation.slow) {
                highlightedMessageId.wrappedValue = nil
            }
            self?.highlightDismissTask = nil
        }
    }

    /// Handles confirmation focus handoff: when a new pending confirmation
    /// appears, resign first responder from the composer so the confirmation
    /// bubble's key monitor can intercept Tab/Enter/Escape immediately.
    #if os(macOS)
    func handleConfirmationFocusIfNeeded(currentPendingRequestId: String?) {
        if let requestId = currentPendingRequestId, lastAutoFocusedRequestId != requestId {
            if let window = NSApp.keyWindow,
               let responder = window.firstResponder as? NSTextView,
               responder.isEditable {
                window.makeFirstResponder(nil)
                lastAutoFocusedRequestId = requestId
            }
        } else if currentPendingRequestId == nil {
            lastAutoFocusedRequestId = nil
        }
    }
    #endif

    // MARK: - Pin & Scroll

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

    // MARK: - User Actions

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
        endExpansionSuppression()
        if isNearBottom {
            os_signpost(.event, log: PerfSignposts.log, name: "scrollSuppressionChanged", "on reason=expansionPinning")
            recordScrollLoopEvent(.suppressionFlip, conversationId: conversationId, isNearBottom: isNearBottom, scrollViewportHeight: scrollViewportHeight)
            requestBottomPin(reason: .expansion, conversationId: conversationId, animated: false)
        } else {
            os_signpost(.event, log: PerfSignposts.log, name: "scrollSuppressionChanged", "on reason=offBottomExpansion")
            recordScrollLoopEvent(.suppressionFlip, conversationId: conversationId, isNearBottom: isNearBottom, scrollViewportHeight: scrollViewportHeight)
            // Begin expansion suppression with 200ms auto-timeout. Resize and
            // pagination have their own independent boolean flags — no guards needed.
            beginExpansionSuppression()
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
            // Suppress auto-scroll while the layout stabilizes. Managed
            // inline — no timeout Task needed (begin/end bracket the sleep).
            self.beginResizeSuppression()
            defer {
                if !Task.isCancelled { onComplete() }
            }
            try? await Task.sleep(nanoseconds: 100_000_000)
            guard !Task.isCancelled else {
                self.endResizeSuppression()
                return
            }
            // Remove suppression BEFORE the pin request so it isn't rejected.
            self.endResizeSuppression()
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
                // Suppress auto-scroll while restoring the scroll position.
                // Managed inline — no timeout Task needed.
                beginPaginationSuppression()
                try? await Task.sleep(nanoseconds: 100_000_000)
                guard !Task.isCancelled else {
                    endPaginationSuppression()
                    return
                }
                os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested", "target=paginationAnchor")
                recordScrollLoopEvent(.scrollToRequested, conversationId: conversationId)
                performScrollTo(id, anchor: .top)
                scrollCoordinatorLog.debug("[pagination] scroll restored to anchor \(id)")
                endPaginationSuppression()
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
