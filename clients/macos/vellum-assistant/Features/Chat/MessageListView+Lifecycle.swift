import AppKit
import os
import os.signpost
import SwiftUI
import VellumAssistantShared

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "MessageListView")

extension MessageListView {

    // MARK: - onAppear

    func handleAppear() {
        // .id(conversationId) on the ScrollView destroys and recreates it on
        // conversation switch, firing onAppear for the new view. Detect the
        // switch by comparing against the last-known conversation ID.
        //
        // Skip when currentConversationId is nil (true first mount) — reset()
        // on freshly-initialized state is redundant and its 300ms scroll-
        // indicator-hide task would cause a visual flicker on app launch.
        //
        // Scroll callbacks (proxy closures) are configured by the
        // ScrollViewReader's inner onAppear. currentConversationId is set
        // below, AFTER the switch check, because child onAppear fires first.
        let previousConversationId = scrollState.currentConversationId
        let isConversationSwitch = previousConversationId != nil
            && previousConversationId != conversationId
        if isConversationSwitch {
            handleConversationSwitched()
        }
        // Update currentConversationId AFTER the switch check.
        // configureScrollCallbacks (inner onAppear) intentionally does NOT
        // set this because child onAppear fires before parent onAppear,
        // which would make isConversationSwitch always false.
        scrollState.currentConversationId = conversationId
        // Seed the confirmation marker so a conversation already paused in
        // awaiting_confirmation at launch or reconnect is correctly tracked.
        if !isSending {
            scrollState.lastActivityPhaseWhenIdle = assistantActivityPhase
        }
        if let id = anchorMessageId, messages.contains(where: { $0.id == id }) {
            // Anchor is already set and the target message is loaded —
            // scroll to it immediately instead of falling through to bottom.
            os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested", "target=anchorMessage reason=onAppear")
            os_signpost(.event, log: PerfSignposts.log, name: "anchorCleared", "reason=foundOnAppear")
            // Use proxy if available; fall back to ScrollPosition for the
            // rare case where handleAppear fires before the inner onAppear
            // that configures the proxy (both onAppear calls race in practice).
            if scrollState.scrollTo != nil {
                scrollState.performScrollTo(id, anchor: .center)
            } else {
                $scrollPosition.wrappedValue.scrollTo(id: id, anchor: .center)
            }
            flashHighlight(messageId: id)
            anchorMessageId = nil
            scrollState.anchorSetTime = nil
        } else if anchorMessageId != nil {
            // Anchor is set but the target message isn't loaded yet.
            os_signpost(.event, log: PerfSignposts.log, name: "anchorSet", "reason=onAppearPending")
            if scrollState.anchorSetTime == nil { scrollState.anchorSetTime = Date() }
            // Start the independent timeout if not already running.
            if scrollState.anchorTimeoutTask == nil {
                    scrollState.anchorTimeoutTask = Task { @MainActor [scrollState] in
                        do {
                            try await Task.sleep(nanoseconds: 10_000_000_000)
                        } catch { return }
                        guard !Task.isCancelled, anchorMessageId != nil else { return }
                        os_signpost(.event, log: PerfSignposts.log, name: "anchorTimedOut")
                        log.debug("Anchor message not found (timed out) — clearing stale anchor")
                        anchorMessageId = nil
                        scrollState.anchorSetTime = nil
                        scrollState.anchorTimeoutTask = nil
                        scrollState.transition(to: .followingBottom)
                        scrollState.requestPinToBottom(animated: true, userInitiated: true)
                    }
            }
        } else {
            if !scrollState.hasBeenInteracted {
                scrollState.scrollToEdge?(.bottom)
            }
            restoreScrollToBottom()
        }
    }

    // MARK: - onChange handlers

    func handleSendingChanged() {
        if isSending {
            // Clear stale confirmation marker: if the phase left "awaiting_confirmation"
            // while not sending, the marker is stale.
            let effectivePhase: String
            if scrollState.lastActivityPhaseWhenIdle == "awaiting_confirmation"
                && assistantActivityPhase != "awaiting_confirmation"
            {
                effectivePhase = assistantActivityPhase
            } else {
                effectivePhase = scrollState.lastActivityPhaseWhenIdle
            }
            // Reattach and pin to bottom for user-initiated actions (send,
            // regenerate, retry). Skip reattach only when the daemon resumes
            // from a tool confirmation (not a user action during confirmation).
            let isDaemonConfirmationResume =
                effectivePhase == "awaiting_confirmation"
                && assistantActivityPhase != "awaiting_confirmation"
            if isDaemonConfirmationResume && !scrollState.isFollowingBottom {
                // Daemon resumed from confirmation while user was scrolled up.
            } else {
                // For user-initiated sends, scroll the user's message to
                // the viewport top with space below for the assistant's
                // response. Daemon confirmation resumes stay bottom-pinned.
                if !isDaemonConfirmationResume, let lastUserMsg = messages.last(where: { $0.role == .user }) {
                    scrollState.enterPushToTop(messageId: lastUserMsg.id)
                    os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested",
                                "target=userMessage reason=pushToTop")
                } else {
                    scrollState.transition(to: .followingBottom)
                    scrollState.requestPinToBottom(animated: true)
                }
            }
        } else {
            // Capture the activity phase at the moment sending stops.
            scrollState.lastActivityPhaseWhenIdle = assistantActivityPhase
            // End push-to-top phase and scroll to bottom so the user
            // sees the complete response.
            if scrollState.mode.pushToTopMessageId != nil {
                scrollState.exitPushToTop(animated: true)
                // Reset the binding so SwiftUI stops anchoring to
                // the push-to-top message and follows the bottom.
                scrollPosition = ScrollPosition(edge: .bottom)
            }
            // First-message detection.
            if !hasEverSentMessage && messages.contains(where: { $0.role == .user }) {
                hasEverSentMessage = true
                UserDefaults.standard.set(true, forKey: "hasEverSentMessage")
            }
        }
    }

    func handleMessagesCountChanged() {
        // --- Anchor message resolution ---
        if let id = anchorMessageId, messages.contains(where: { $0.id == id }) {
            os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested", "target=anchorMessage reason=messagesChanged")
            os_signpost(.event, log: PerfSignposts.log, name: "anchorCleared", "reason=foundInMessages")
            scrollState.transition(to: .programmaticScroll(reason: .deepLinkAnchor(id: id)))
            withAnimation {
                scrollState.scrollTo?(id, .center)
            }
            flashHighlight(messageId: id)
            anchorMessageId = nil
            scrollState.anchorSetTime = nil
            scrollState.anchorTimeoutTask?.cancel()
            scrollState.anchorTimeoutTask = nil
            return
        }
        // If anchor is set but the target message still hasn't appeared,
        // check pagination exhaustion with a minimum elapsed time guard.
        if anchorMessageId != nil {
            let paginationExhausted = !hasMoreMessages
            let minWaitElapsed = scrollState.anchorSetTime.map { Date().timeIntervalSince($0) > 2 } ?? false
            if paginationExhausted && minWaitElapsed {
                os_signpost(.event, log: PerfSignposts.log, name: "anchorCleared", "reason=paginationExhausted")
                log.debug("Anchor message not found (pagination exhausted) — clearing stale anchor")
                anchorMessageId = nil
                scrollState.anchorSetTime = nil
                scrollState.anchorTimeoutTask?.cancel()
                scrollState.anchorTimeoutTask = nil
                scrollState.transition(to: .followingBottom)
                scrollState.requestPinToBottom(animated: true)
                return
            }
        }
        // --- Bottom-pin on new messages ---
        if scrollState.mode.pushToTopMessageId != nil && anchorMessageId == nil {
            // no-op: push-to-top suppresses bottom-pin
        } else if anchorMessageId == nil {
            scrollState.requestPinToBottom(animated: true)
        }
        // --- Confirmation focus handoff ---
        #if os(macOS)
        handleConfirmationFocusIfNeeded()
        #endif
    }

    func handleContainerWidthChanged() {
        guard containerWidth > 0, abs(containerWidth - scrollState.lastHandledContainerWidth) > 2 else { return }
        scrollState.lastHandledContainerWidth = containerWidth
        resizeScrollTask?.cancel()
        resizeScrollTask = Task { @MainActor [scrollState] in
            scrollState.beginStabilization(.resize)
            defer {
                if !Task.isCancelled { resizeScrollTask = nil }
            }
            try? await Task.sleep(nanoseconds: 100_000_000)
            guard !Task.isCancelled else {
                scrollState.endStabilization()
                return
            }
            scrollState.endStabilization()
            if scrollState.isFollowingBottom && anchorMessageId == nil && !scrollState.isAtBottom {
                scrollState.requestPinToBottom()
            }
        }
    }

    func handleConversationSwitched() {
        // Reset view-local state.
        resizeScrollTask?.cancel()
        resizeScrollTask = nil
        highlightedMessageId = nil
        scrollState.highlightDismissTask?.cancel()
        scrollState.highlightDismissTask = nil
        // Reset scroll state for the new conversation.
        scrollState.reset(for: conversationId)
        // Capture the new conversation's activity phase so a conversation
        // already paused in awaiting_confirmation is correctly tracked.
        scrollState.lastActivityPhaseWhenIdle = isSending ? "" : assistantActivityPhase
        scrollState.lastHandledContainerWidth = containerWidth
        scrollState.anchorTimeoutTask?.cancel()
        scrollState.anchorTimeoutTask = nil
        scrollState.lastAutoFocusedRequestId = nil
        // When switching to a conversation that is already actively sending,
        // .onChange(of: isSending) won't fire (the value doesn't change), so
        // mode stays .initialLoad. Transition to .followingBottom now so that
        // requestPinToBottom() can issue pins for streaming messages.
        if isSending {
            scrollState.transition(to: .followingBottom)
        }
        // Declarative position reset — processed in the same layout pass as new content.
        // https://developer.apple.com/documentation/swiftui/scrollposition
        scrollState.scrollRestoreTask?.cancel()
        if anchorMessageId == nil {
            scrollPosition = ScrollPosition(edge: .bottom)
        }
        restoreScrollToBottom()
    }

    func handleAnchorMessageTask() async {
        // task(id:) fires on initial value and on changes. Only process
        // non-nil anchor assignments; nil transitions are cleanup handled
        // by messagesChanged and conversationSwitched.
        guard let id = anchorMessageId else { return }
        // Cancel scroll restore when a new anchor is set.
        scrollState.scrollRestoreTask?.cancel()
        scrollState.scrollRestoreTask = nil
        scrollState.transition(to: .programmaticScroll(reason: .deepLinkAnchor(id: id)))
        scrollState.anchorSetTime = Date()
        scrollState.anchorTimeoutTask?.cancel()
        scrollState.anchorTimeoutTask = nil
        os_signpost(.event, log: PerfSignposts.log, name: "anchorSet", "reason=anchorMessageIdChanged")
        if messages.contains(where: { $0.id == id }) {
            os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested", "target=anchorMessage reason=anchorChanged")
            os_signpost(.event, log: PerfSignposts.log, name: "anchorCleared", "reason=foundOnAnchorChange")
            withAnimation {
                scrollState.scrollTo?(id, .center)
            }
            flashHighlight(messageId: id)
            anchorMessageId = nil
            scrollState.anchorSetTime = nil
        } else {
            // Start an independent 10-second timeout that clears the
            // anchor even if messages.count never changes.
            scrollState.anchorTimeoutTask = Task { @MainActor [scrollState] in
                do {
                    try await Task.sleep(nanoseconds: 10_000_000_000)
                } catch { return }
                guard !Task.isCancelled, anchorMessageId != nil else { return }
                os_signpost(.event, log: PerfSignposts.log, name: "anchorTimedOut")
                log.debug("Anchor message not found (timed out) — clearing stale anchor")
                anchorMessageId = nil
                scrollState.anchorSetTime = nil
                scrollState.anchorTimeoutTask = nil
                scrollState.requestPinToBottom(animated: true, userInitiated: true)
            }
        }
    }

    // MARK: - Confirmation focus

    #if os(macOS)
    /// Handles confirmation focus handoff: when a new pending confirmation
    /// appears, resign first responder from the composer so the confirmation
    /// bubble's key monitor can intercept Tab/Enter/Escape immediately.
    func handleConfirmationFocusIfNeeded() {
        if let requestId = activePendingRequestId, scrollState.lastAutoFocusedRequestId != requestId {
            if let window = NSApp.keyWindow,
               let responder = window.firstResponder as? NSTextView,
               responder.isEditable {
                window.makeFirstResponder(nil)
                scrollState.lastAutoFocusedRequestId = requestId
            }
        } else if activePendingRequestId == nil {
            scrollState.lastAutoFocusedRequestId = nil
        }
    }
    #endif
}
