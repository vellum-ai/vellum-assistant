import AppKit
import os
import os.signpost
import SwiftUI
import VellumAssistantShared

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "MessageListView")

/// Compound `task(id:)` key so the daemon-message-ID resolver re-fires both
/// when the requested daemon ID changes and when the messages list grows
/// (the matching row may not exist yet at the time the binding is set).
struct AnchorDaemonResolveKey: Hashable {
    let daemonId: String?
    let messageCount: Int
}

extension MessageListView {

    // MARK: - onAppear

    func handleAppear() {
        // .id(conversationId) on the ScrollView destroys and recreates it on
        // conversation switch, firing onAppear for the new view. Detect the
        // switch by comparing against the last-known conversation ID.
        let previousConversationId = scrollState.currentConversationId
        let isConversationSwitch = previousConversationId != nil
            && previousConversationId != conversationId
        scrollState.currentConversationId = conversationId
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
        if let id = anchorMessageId,
           let displayId = TranscriptItems.displayId(for: id, in: messages) {
            os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested", "target=anchorMessage reason=onAppear")
            os_signpost(.event, log: PerfSignposts.log, name: "anchorCleared", "reason=foundOnAppear")
            // .center anchor is view-relative and works correctly with inverted scroll.
            $scrollPosition.wrappedValue.scrollTo(id: displayId, anchor: .center)
            flashHighlight(messageId: displayId)
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
    }

    // MARK: - onChange handlers

    func handleSendingChanged() {
        // Guard against stale fires during a conversation switch.
        guard conversationId == scrollState.currentConversationId else { return }
        if isSending {
            // Only pin on genuine user sends, not confirmation resumes.
            // When the assistant resumes from awaiting_confirmation,
            // isSending flips true but no new user bubble was added.
            let isConfirmationResume = scrollState.lastActivityPhaseWhenIdle == "awaiting_confirmation"
            if !isConfirmationResume,
               let latestUserMessageId = latestPinnedTurnAnchorCandidateId(in: messages) {
                scrollState.pinnedLatestTurnAnchorMessageId = latestUserMessageId
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

    func handleMessagesRevisionChanged() {
        // Queued-turn handoff updates message status without changing count.
        // Re-check the pin anchor so it advances to the dequeued user message.
        guard conversationId == scrollState.currentConversationId,
              isSending,
              let candidate = latestPinnedTurnAnchorCandidateId(in: messages),
              candidate != scrollState.pinnedLatestTurnAnchorMessageId else { return }
        scrollState.pinnedLatestTurnAnchorMessageId = candidate
    }

    func handleMessagesCountChanged() {
        // Guard against stale fires during a conversation switch.
        guard conversationId == scrollState.currentConversationId else { return }
        // --- Anchor message resolution ---
        if let id = anchorMessageId,
           let displayId = TranscriptItems.displayId(for: id, in: messages) {
            os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested", "target=anchorMessage reason=messagesChanged")
            os_signpost(.event, log: PerfSignposts.log, name: "anchorCleared", "reason=foundInMessages")
            // .center anchor is view-relative and works correctly with inverted scroll.
            withAnimation {
                $scrollPosition.wrappedValue = ScrollPosition(id: displayId, anchor: .center)
            }
            flashHighlight(messageId: displayId)
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
        // Safety net: MessageSendCoordinator publishes the new user message
        // before flipping `isSending = true`, so count changes can arrive
        // first. Only pin when the newest visible message is a real user send.
        if let latestVisibleMessage = paginatedVisibleMessages.last,
           scrollState.lastMessageId != nil,
           latestVisibleMessage.id != scrollState.lastMessageId,
           isPinnedLatestTurnAnchorCandidate(latestVisibleMessage) {
            scrollState.pinnedLatestTurnAnchorMessageId = latestVisibleMessage.id
        }
        // --- Update lastMessageId ---
        if let lastId = paginatedVisibleMessages.last?.id {
            scrollState.lastMessageId = lastId
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
        viewportHeight = .infinity
        highlightedMessageId = nil
        scrollState.highlightDismissTask?.cancel()
        scrollState.highlightDismissTask = nil
        // `.id(conversationId)` is on the inner ScrollView, so this view's
        // `@State` survives conversation switches. Fixed-sentinel row IDs
        // (e.g. queuedMarker) would otherwise reuse heights across chats.
        messageHeightCache.reset()
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
        // With inverted scroll, the latest messages appear at the visual
        // bottom naturally — no imperative scroll needed.
        scrollState.lastMessageId = paginatedVisibleMessages.last?.id
    }

    func handleAnchorMessageTask() async {
        // task(id:) fires on initial value and on changes. Only process
        // non-nil anchor assignments; nil transitions are cleanup handled
        // by messagesChanged and conversationSwitched.
        guard let id = anchorMessageId else { return }
        scrollState.anchorSetTime = Date()
        scrollState.anchorTimeoutTask?.cancel()
        scrollState.anchorTimeoutTask = nil
        os_signpost(.event, log: PerfSignposts.log, name: "anchorSet", "reason=anchorMessageIdChanged")
        if let displayId = TranscriptItems.displayId(for: id, in: messages) {
            os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested", "target=anchorMessage reason=anchorChanged")
            os_signpost(.event, log: PerfSignposts.log, name: "anchorCleared", "reason=foundOnAnchorChange")
            // .center anchor is view-relative and works correctly with inverted scroll.
            withAnimation {
                $scrollPosition.wrappedValue = ScrollPosition(id: displayId, anchor: .center)
            }
            flashHighlight(messageId: displayId)
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

    /// Resolves a daemon message ID to its client `UUID` once the messages list
    /// contains a matching message, then assigns `anchorMessageId` to defer to
    /// the existing UUID-based scroll-and-flash path. Cross-conversation jumps
    /// from settings deep-links (e.g. Bookmarks) only have daemon IDs, not the
    /// client-generated UUIDs that the scroll machinery expects.
    func handleAnchorDaemonMessageIdTask() async {
        guard let daemonId = anchorDaemonMessageId.wrappedValue else { return }
        guard let match = messages.first(where: { $0.daemonMessageId == daemonId }) else { return }
        anchorDaemonMessageId.wrappedValue = nil
        anchorMessageId = match.id
    }

    // MARK: - Latest-turn pinning

    func latestPinnedTurnAnchorCandidateId(in messages: [ChatMessage]) -> UUID? {
        messages.last(where: isPinnedLatestTurnAnchorCandidate(_:))?.id
    }

    func isPinnedLatestTurnAnchorCandidate(_ message: ChatMessage) -> Bool {
        guard message.role == .user else { return false }
        if case .queued = message.status { return false }
        return true
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
