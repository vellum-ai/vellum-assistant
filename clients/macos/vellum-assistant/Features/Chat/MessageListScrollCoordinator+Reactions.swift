import AppKit
import Foundation
import os
import SwiftUI
import VellumAssistantShared

// MARK: - Consolidated Reaction Points

extension MessageListScrollCoordinator {

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
        hasPlayedTailEntryAnimation: inout Bool,
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
        hasPlayedTailEntryAnimation = false
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
}
