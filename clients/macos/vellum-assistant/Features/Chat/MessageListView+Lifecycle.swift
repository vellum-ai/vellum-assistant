import AppKit
import os
import os.signpost
import SwiftUI
import VellumAssistantShared

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "MessageListView")

extension MessageListView {

    // MARK: - onAppear

    func handleAppear() {
        let isConversationSwitch = lastConversationId != conversationId
        if isConversationSwitch {
            handleConversationSwitched()
        }
        if let id = anchorMessageId, messages.contains(where: { $0.id == id }) {
            // Anchor is already set and the target message is loaded —
            // scroll to it immediately.
            os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested", "target=anchorMessage reason=onAppear")
            os_signpost(.event, log: PerfSignposts.log, name: "anchorCleared", "reason=foundOnAppear")
            scrollPosition.scrollTo(id: id, anchor: .center)
            flashHighlight(messageId: id)
            anchorMessageId = nil
            anchorSetTime = nil
        } else if anchorMessageId != nil {
            // Anchor is set but the target message isn't loaded yet.
            os_signpost(.event, log: PerfSignposts.log, name: "anchorSet", "reason=onAppearPending")
            if anchorSetTime == nil { anchorSetTime = Date() }
            if anchorTimeoutTask == nil {
                anchorTimeoutTask = Task { @MainActor in
                    do {
                        try await Task.sleep(nanoseconds: 10_000_000_000)
                    } catch { return }
                    guard !Task.isCancelled, anchorMessageId != nil else { return }
                    os_signpost(.event, log: PerfSignposts.log, name: "anchorTimedOut")
                    log.debug("Anchor message not found (timed out) -- clearing stale anchor")
                    anchorMessageId = nil
                    anchorSetTime = nil
                    anchorTimeoutTask = nil
                    withAnimation(.easeInOut(duration: 0.3)) {
                        scrollPosition.scrollTo(id: "scroll-bottom-anchor", anchor: .bottom)
                    }
                }
            }
        }
        // else: Initial load — `.defaultScrollAnchor(.bottom, for: .initialOffset)`
        // handles positioning declaratively.
    }

    // MARK: - onChange handlers

    func handleSendingChanged() {
        guard conversationId == lastConversationId else { return }
        if isSending {
            // Scroll to the user's message so it appears near the top of
            // the viewport with assistant response flowing below.
            if let userMessage = messages.last(where: { $0.role == .user }) {
                scrollPosition.scrollTo(id: userMessage.id, anchor: .top)
            }
        } else {
            // First-message detection.
            if !hasEverSentMessage && messages.contains(where: { $0.role == .user }) {
                hasEverSentMessage = true
                UserDefaults.standard.set(true, forKey: "hasEverSentMessage")
            }
        }
    }

    func handleMessagesCountChanged() {
        guard conversationId == lastConversationId else { return }
        // --- Anchor message resolution ---
        if let id = anchorMessageId, messages.contains(where: { $0.id == id }) {
            os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested", "target=anchorMessage reason=messagesChanged")
            os_signpost(.event, log: PerfSignposts.log, name: "anchorCleared", "reason=foundInMessages")
            withAnimation {
                scrollPosition.scrollTo(id: id, anchor: .center)
            }
            flashHighlight(messageId: id)
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
                log.debug("Anchor message not found (pagination exhausted) -- clearing stale anchor")
                anchorMessageId = nil
                anchorSetTime = nil
                anchorTimeoutTask?.cancel()
                anchorTimeoutTask = nil
                withAnimation(.easeInOut(duration: 0.3)) {
                    scrollPosition.scrollTo(id: "scroll-bottom-anchor", anchor: .bottom)
                }
                return
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
              abs(trackedWidth - lastHandledChatColumnWidth) > 2 else { return }
        // First real pane measurement (0 -> actual width) is not a resize —
        // just record the transcript column width so subsequent reflows are
        // treated as real resizes.
        guard lastHandledChatColumnWidth > 0 else {
            lastHandledChatColumnWidth = trackedWidth
            return
        }
        lastHandledChatColumnWidth = trackedWidth
        resizeScrollTask?.cancel()
        resizeScrollTask = Task { @MainActor in
            defer {
                if !Task.isCancelled { resizeScrollTask = nil }
            }
            try? await Task.sleep(nanoseconds: 100_000_000)
            guard !Task.isCancelled else { return }
            if isAtBottom && anchorMessageId == nil {
                // Re-pin to bottom after width change since LazyVStack
                // re-estimates content heights.
                scrollPosition.scrollTo(id: "scroll-bottom-anchor", anchor: .bottom)
            }
        }
    }

    func handleConversationSwitched() {
        // Reset view-local state.
        resizeScrollTask?.cancel()
        resizeScrollTask = nil
        paginationTask?.cancel()
        paginationTask = nil
        isLoadingMore = false
        isAtBottom = true
        topVisibleMessageId = nil
        highlightedMessageId = nil
        highlightDismissTask?.cancel()
        highlightDismissTask = nil
        lastConversationId = conversationId
        lastHandledChatColumnWidth = containerWidth > 0
            ? layoutMetrics.chatColumnWidth
            : 0
        anchorTimeoutTask?.cancel()
        anchorTimeoutTask = nil
        lastAutoFocusedRequestId = nil
        anchorSetTime = nil
        projectionCache.reset()
        // Position at the content bottom for the new conversation.
        // .id(conversationId) destroys and recreates the ScrollView.
        // .defaultScrollAnchor(.bottom, for: .initialOffset) positions
        // the new instance at the bottom. As a safety net, also issue an
        // explicit imperative scroll in case the @State ScrollPosition
        // retains a stale target from the previous conversation that
        // interferes with the declarative anchor.
        scrollPosition.scrollTo(edge: .bottom)
    }

    func handleAnchorMessageTask() async {
        // task(id:) fires on initial value and on changes. Only process
        // non-nil anchor assignments; nil transitions are cleanup handled
        // by messagesChanged and conversationSwitched.
        guard let id = anchorMessageId else { return }
        anchorSetTime = Date()
        anchorTimeoutTask?.cancel()
        anchorTimeoutTask = nil
        os_signpost(.event, log: PerfSignposts.log, name: "anchorSet", "reason=anchorMessageIdChanged")
        if messages.contains(where: { $0.id == id }) {
            os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested", "target=anchorMessage reason=anchorChanged")
            os_signpost(.event, log: PerfSignposts.log, name: "anchorCleared", "reason=foundOnAnchorChange")
            withAnimation {
                scrollPosition.scrollTo(id: id, anchor: .center)
            }
            flashHighlight(messageId: id)
            anchorMessageId = nil
            anchorSetTime = nil
        } else {
            // Start an independent 10-second timeout that clears the
            // anchor even if messages.count never changes.
            anchorTimeoutTask = Task { @MainActor in
                do {
                    try await Task.sleep(nanoseconds: 10_000_000_000)
                } catch { return }
                guard !Task.isCancelled, anchorMessageId != nil else { return }
                os_signpost(.event, log: PerfSignposts.log, name: "anchorTimedOut")
                log.debug("Anchor message not found (timed out) -- clearing stale anchor")
                anchorMessageId = nil
                anchorSetTime = nil
                anchorTimeoutTask = nil
                withAnimation(.easeInOut(duration: 0.3)) {
                    scrollPosition.scrollTo(id: "scroll-bottom-anchor", anchor: .bottom)
                }
            }
        }
    }

    // MARK: - Highlight

    func flashHighlight(messageId: UUID) {
        highlightedMessageId = messageId
        highlightDismissTask?.cancel()
        highlightDismissTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            guard !Task.isCancelled else { return }
            withAnimation(.easeOut(duration: 0.5)) {
                highlightedMessageId = nil
            }
            highlightDismissTask = nil
        }
    }

    // MARK: - Confirmation focus

    #if os(macOS)
    func handleConfirmationFocusIfNeeded() {
        if let requestId = activePendingRequestId, lastAutoFocusedRequestId != requestId {
            if let window = NSApp.keyWindow,
               let responder = window.firstResponder as? NSTextView,
               responder.isEditable {
                window.makeFirstResponder(nil)
                lastAutoFocusedRequestId = requestId
            }
        } else if activePendingRequestId == nil {
            lastAutoFocusedRequestId = nil
        }
    }
    #endif
}
