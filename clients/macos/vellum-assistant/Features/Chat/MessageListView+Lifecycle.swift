import AppKit
import os
import os.signpost
import SwiftUI
import VellumAssistantShared

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "MessageListView")
private let scrollDiag = Logger(subsystem: Bundle.appBundleIdentifier, category: "ScrollDiag")

extension MessageListView {

    // MARK: - onAppear

    func handleAppear() {
        let isConversationSwitch = currentConversationId != conversationId
        scrollDiag.debug("handleAppear: isSwitch=\(isConversationSwitch, privacy: .public) old=\(currentConversationId?.uuidString ?? "nil", privacy: .public) new=\(conversationId?.uuidString ?? "nil", privacy: .public) msgCount=\(paginatedVisibleMessages.count, privacy: .public)")
        currentConversationId = conversationId
        if isConversationSwitch {
            handleConversationSwitched()
        }
        if !isSending {
            lastActivityPhaseWhenIdle = assistantActivityPhase
        }
        if let id = anchorMessageId, messages.contains(where: { $0.id == id }) {
            os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested", "target=anchorMessage reason=onAppear")
            os_signpost(.event, log: PerfSignposts.log, name: "anchorCleared", "reason=foundOnAppear")
            scrollPosition.scrollTo(id: id, anchor: .center)
            flashHighlight(messageId: id)
            anchorMessageId = nil
            anchorSetTime = nil
            scrollRestoreTask?.cancel()
            scrollRestoreTask = nil
        } else if anchorMessageId != nil {
            os_signpost(.event, log: PerfSignposts.log, name: "anchorSet", "reason=onAppearPending")
            if anchorSetTime == nil { anchorSetTime = Date() }
            startAnchorTimeout()
        } else {
            restoreScrollToBottom()
        }
    }

    // MARK: - onChange handlers

    func handleSendingChanged() {
        guard conversationId == currentConversationId else { return }
        if isSending {
            let effectivePhase: String
            if lastActivityPhaseWhenIdle == "awaiting_confirmation"
                && assistantActivityPhase != "awaiting_confirmation"
            {
                effectivePhase = assistantActivityPhase
            } else {
                effectivePhase = lastActivityPhaseWhenIdle
            }
            let isDaemonConfirmationResume =
                effectivePhase == "awaiting_confirmation"
                && assistantActivityPhase != "awaiting_confirmation"
            if isDaemonConfirmationResume && !isAtBottom {
                // Daemon resumed from confirmation while user was scrolled up.
            } else {
                os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested",
                            "target=bottom reason=sendFollowingBottom")
                // Scroll the user message to top for Claude-style behavior.
                // Defer to next main-queue turn to avoid "Modifying state
                // during view update" when isSending and messages.count
                // change in the same SwiftUI update cycle.
                DispatchQueue.main.async { [self] in
                    if let userMessage = messages.last(where: { $0.role == .user }) {
                        scrollPosition.scrollTo(id: userMessage.id, anchor: .top)
                    } else {
                        scrollToBottom(animated: true)
                    }
                }
            }
        } else {
            lastActivityPhaseWhenIdle = assistantActivityPhase
            if !hasEverSentMessage && messages.contains(where: { $0.role == .user }) {
                hasEverSentMessage = true
                UserDefaults.standard.set(true, forKey: "hasEverSentMessage")
            }
        }
    }

    func handleMessagesCountChanged() {
        guard conversationId == currentConversationId else { return }
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
        if anchorMessageId != nil {
            let paginationExhausted = !hasMoreMessages
            let minWaitElapsed = anchorSetTime.map { Date().timeIntervalSince($0) > 2 } ?? false
            if paginationExhausted && minWaitElapsed {
                os_signpost(.event, log: PerfSignposts.log, name: "anchorCleared", "reason=paginationExhausted")
                log.debug("Anchor message not found (pagination exhausted) — clearing stale anchor")
                anchorMessageId = nil
                anchorSetTime = nil
                anchorTimeoutTask?.cancel()
                anchorTimeoutTask = nil
                scrollToBottom(animated: true)
                return
            }
        }
        // No auto-follow: new messages do not scroll the viewport.
        // The "Scroll to latest" CTA appears automatically when isAtBottom
        // becomes false (driven by onScrollGeometryChange).
        #if os(macOS)
        handleConfirmationFocusIfNeeded()
        #endif
    }

    func handleContainerWidthChanged() {
        let trackedWidth = layoutMetrics.chatColumnWidth
        guard containerWidth > 0,
              abs(trackedWidth - lastHandledChatColumnWidth) > 2 else { return }
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
            if isAtBottom, anchorMessageId == nil {
                scrollToBottom(animated: false)
            } else if !isAtBottom,
                      anchorMessageId == nil,
                      let visibleId = projectionCache.cachedFirstVisibleMessageId {
                scrollPosition.scrollTo(id: visibleId, anchor: .top)
            }
        }
    }

    func handleConversationSwitched() {
        resizeScrollTask?.cancel()
        resizeScrollTask = nil
        highlightedMessageId = nil
        highlightDismissTask?.cancel()
        highlightDismissTask = nil
        projectionCache.reset()
        isAtBottom = true
        lastActivityPhaseWhenIdle = isSending ? "" : assistantActivityPhase
        lastHandledChatColumnWidth = containerWidth > 0
            ? layoutMetrics.chatColumnWidth
            : 0
        anchorTimeoutTask?.cancel()
        anchorTimeoutTask = nil
        anchorSetTime = nil
        lastAutoFocusedRequestId = nil
        paginationTask?.cancel()
        paginationTask = nil
        isPaginationInFlight = false
        wasPaginationTriggerInRange = false
        scrollRestoreTask?.cancel()
        if anchorMessageId == nil {
            scrollDiag.debug("handleConversationSwitched: calling scrollTo(edge: .bottom), conv=\(conversationId?.uuidString ?? "nil", privacy: .public)")
            scrollPosition.scrollTo(edge: .bottom)
        } else {
            scrollDiag.debug("handleConversationSwitched: SKIPPED scroll — anchorMessageId is set")
        }
        restoreScrollToBottom()
    }

    func handleAnchorMessageTask() async {
        guard let id = anchorMessageId else { return }
        scrollRestoreTask?.cancel()
        scrollRestoreTask = nil
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
            startAnchorTimeout()
        }
    }

    // MARK: - Scroll helpers

    func scrollToBottom(animated: Bool) {
        if let lastId = paginatedVisibleMessages.last?.id {
            if animated {
                withAnimation(VAnimation.spring) {
                    scrollPosition.scrollTo(id: lastId, anchor: .bottom)
                }
            } else {
                scrollPosition.scrollTo(id: lastId, anchor: .bottom)
            }
        } else {
            scrollPosition.scrollTo(edge: .bottom)
        }
    }

    func restoreScrollToBottom() {
        scrollRestoreTask?.cancel()
        scrollRestoreTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 100_000_000)
            guard !Task.isCancelled, anchorMessageId == nil else { return }
            scrollPosition.scrollTo(edge: .bottom)
            scrollRestoreTask = nil
        }
    }

    func flashHighlight(messageId: UUID) {
        highlightedMessageId = messageId
        highlightDismissTask?.cancel()
        highlightDismissTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            guard !Task.isCancelled else { return }
            highlightedMessageId = nil
            highlightDismissTask = nil
        }
    }

    // MARK: - Pagination

    func triggerPagination() {
        guard hasMoreMessages,
              !isLoadingMoreMessages,
              !isPaginationInFlight,
              Date().timeIntervalSince(lastPaginationCompletedAt) > 0.5
        else { return }

        isPaginationInFlight = true
        let anchorId = projectionCache.cachedFirstVisibleMessageId

        os_signpost(.event, log: PerfSignposts.log, name: "paginationSentinelFired")
        paginationTask = Task { @MainActor in
            defer {
                if !Task.isCancelled {
                    lastPaginationCompletedAt = Date()
                    isPaginationInFlight = false
                    paginationTask = nil
                }
            }
            let hadMore = await loadPreviousMessagePage?() ?? false
            if hadMore, let id = anchorId {
                try? await Task.sleep(nanoseconds: 100_000_000)
                guard !Task.isCancelled else { return }
                scrollPosition.scrollTo(id: id, anchor: .top)
            }
        }
    }

    // MARK: - Anchor timeout

    private func startAnchorTimeout() {
        guard anchorTimeoutTask == nil else { return }
        anchorTimeoutTask = Task { @MainActor in
            do {
                try await Task.sleep(nanoseconds: 10_000_000_000)
            } catch { return }
            guard !Task.isCancelled, anchorMessageId != nil else { return }
            os_signpost(.event, log: PerfSignposts.log, name: "anchorTimedOut")
            log.debug("Anchor message not found (timed out) — clearing stale anchor")
            anchorMessageId = nil
            anchorSetTime = nil
            anchorTimeoutTask = nil
            withAnimation(VAnimation.fast) {
                scrollToBottom(animated: true)
            }
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
