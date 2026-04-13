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
        let previousConversationId = scrollState.currentConversationId
        let isConversationSwitch = previousConversationId != nil
            && previousConversationId != conversationId
        configureScrollCallbacks()
        if isConversationSwitch {
            handleConversationSwitched()
        } else {
            // Seed lastMessageId so the CTA and scroll-to-bottom always
            // have a valid ForEach target.
            if let lastId = paginatedVisibleMessages.last?.id {
                scrollState.lastMessageId = lastId
            }
        }
        // Seed the confirmation marker so a conversation already paused in
        // awaiting_confirmation at launch or reconnect is correctly tracked.
        if !isSending {
            scrollState.lastActivityPhaseWhenIdle = assistantActivityPhase
        }
        // Handle pending anchor if already set.
        if let id = anchorMessageId, messages.contains(where: { $0.id == id }) {
            os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested", "target=anchorMessage reason=onAppear")
            os_signpost(.event, log: PerfSignposts.log, name: "anchorCleared", "reason=foundOnAppear")
            $scrollPosition.wrappedValue.scrollTo(id: id, anchor: .center)
            flashHighlight(messageId: id)
            anchorMessageId = nil
            scrollState.anchorSetTime = nil
        } else if anchorMessageId != nil {
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
                }
            }
        }
        // For initial load (no anchor, no conversation switch),
        // `.defaultScrollAnchor(.top)` handles positioning declaratively.
    }

    // MARK: - onChange handlers

    func handleSendingChanged() {
        // Guard against stale fires during a conversation switch.
        guard conversationId == scrollState.currentConversationId else { return }
        if isSending {
            // Only scroll on genuine user sends, not confirmation resumes.
            // When the daemon resumes from awaiting_confirmation, isSending
            // flips true but no new user message was sent — scrolling would
            // jump the viewport to an older user message.
            let isConfirmationResume = scrollState.lastActivityPhaseWhenIdle == "awaiting_confirmation"
            if !isConfirmationResume {
                if let userMessage = messages.last(where: { $0.role == .user }) {
                    scrollState.pendingSendScrollMessageId = userMessage.id
                }
            }
        } else {
            // Capture the activity phase at the moment sending stops.
            scrollState.lastActivityPhaseWhenIdle = assistantActivityPhase
            // First-message detection.
            if !hasEverSentMessage && messages.contains(where: { $0.role == .user }) {
                hasEverSentMessage = true
                UserDefaults.standard.set(true, forKey: "hasEverSentMessage")
            }
        }
    }

    func handleMessagesCountChanged() {
        // Guard against stale fires during a conversation switch.
        guard conversationId == scrollState.currentConversationId else { return }
        // --- Anchor message resolution ---
        if let id = anchorMessageId, messages.contains(where: { $0.id == id }) {
            os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested", "target=anchorMessage reason=messagesChanged")
            os_signpost(.event, log: PerfSignposts.log, name: "anchorCleared", "reason=foundInMessages")
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
                return
            }
        }
        // --- Safety net: detect new user message added before isSending onChange fired ---
        // MessageSendCoordinator appends the user message and calls flushCoalescedPublish()
        // before setting isSending = true, so messages.count can change first.
        // Must run before lastMessageId is updated so we can detect the change.
        if scrollState.pendingSendScrollMessageId == nil {
            if let lastUser = paginatedVisibleMessages.last(where: { $0.role == .user }),
               scrollState.lastMessageId != nil,
               lastUser.id != scrollState.lastMessageId,
               paginatedVisibleMessages.last?.id != scrollState.lastMessageId {
                scrollState.pendingSendScrollMessageId = lastUser.id
            }
        }
        // --- Update lastMessageId ---
        if let lastId = paginatedVisibleMessages.last?.id {
            scrollState.lastMessageId = lastId
        }
        // --- Scroll to bottom on send ---
        // After the user message appears and the thinking indicator shows,
        // scroll to bottom. The thinking indicator's minHeight wrapper
        // naturally pins the user message to the top of the viewport.
        // Deferred by one run-loop tick so SwiftUI lays out the new cell
        // before the scroll fires — otherwise the scroll targets the old
        // content bottom and the user message appears off-screen.
        if scrollState.pendingSendScrollMessageId != nil,
           paginatedVisibleMessages.contains(where: { $0.id == scrollState.pendingSendScrollMessageId }) {
            let scrollBinding = $scrollPosition
            scrollState.pendingSendScrollMessageId = nil
            Task { @MainActor in
                withAnimation(VAnimation.standard) {
                    scrollBinding.wrappedValue.scrollTo(edge: .bottom)
                }
            }
        }
        // --- Confirmation focus handoff ---
        #if os(macOS)
        handleConfirmationFocusIfNeeded()
        #endif
    }

    func handleContainerWidthChanged() {
        let trackedWidth = layoutMetrics.chatColumnWidth
        guard containerWidth > 0,
              abs(trackedWidth - scrollState.lastHandledChatColumnWidth) > 2 else { return }
        // First real pane measurement (0 → actual width) is not a resize — just
        // record the transcript column width.
        guard scrollState.lastHandledChatColumnWidth > 0 else {
            scrollState.lastHandledChatColumnWidth = trackedWidth
            return
        }
        scrollState.lastHandledChatColumnWidth = trackedWidth
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
        scrollState.lastHandledChatColumnWidth = containerWidth > 0
            ? layoutMetrics.chatColumnWidth
            : 0
        scrollState.anchorTimeoutTask?.cancel()
        scrollState.anchorTimeoutTask = nil
        scrollState.lastAutoFocusedRequestId = nil
        // Seed lastMessageId so scroll-to-bottom can target it.
        scrollState.lastMessageId = paginatedVisibleMessages.last?.id
        // Don't write to scrollPosition — `.defaultScrollAnchor(.top)` handles
        // positioning via the `.id(conversationId)` recreation.
    }

    func handleAnchorMessageTask() async {
        // task(id:) fires on initial value and on changes. Only process
        // non-nil anchor assignments; nil transitions are cleanup handled
        // by messagesChanged and conversationSwitched.
        guard let id = anchorMessageId else { return }
        // Cancel scroll restore when a new anchor is set.
        scrollState.scrollRestoreTask?.cancel()
        scrollState.scrollRestoreTask = nil
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
