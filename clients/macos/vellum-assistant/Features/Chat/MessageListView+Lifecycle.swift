import AppKit
import os
import os.signpost
import SwiftUI
import VellumAssistantShared

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "MessageListView")

/// Separate category for the scroll-anchor source diagnostic so its high-rate
/// output (one line per small contentH tick when the overlay is on) doesn't
/// drown out other `MessageListView` logs. Filter with
/// `log stream --predicate 'category == "ScrollAnchorDiag"'`.
private let scrollDiagLog = Logger(subsystem: Bundle.appBundleIdentifier, category: "ScrollAnchorDiag")

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
        // Seed the anchor-preservation gate so it fires immediately when the
        // view appears mid-stream (conversation switch into a still-streaming
        // thread, or app launch with isSending=true). Otherwise it would only
        // turn on at the next isSending transition, missing the growth that
        // happens before that.
        scrollState.isStreamingActive = isSending
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
        recordTranscriptDiagnosticsSnapshot(reason: "appear", force: true)
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
        // Mirror into the scroll state so the anchor-preservation gate flips
        // synchronously with the send/stream lifecycle. See `isStreamingActive`
        // on `MessageListScrollState` for the rationale.
        scrollState.isStreamingActive = isSending
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
        recordTranscriptDiagnosticsSnapshot(reason: isSending ? "sending_started" : "sending_stopped", force: true)
    }

    func handleMessagesRevisionChanged() {
        recordTranscriptDiagnosticsSnapshot(reason: "messages_revision")

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
        recordTranscriptDiagnosticsSnapshot(reason: "messages_count", force: true)

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
        recordTranscriptDiagnosticsSnapshot(reason: "conversation_switched", force: true)
    }

    // MARK: - Transcript Diagnostics

    /// Updates the content-safe snapshot used by hang diagnostics and log
    /// exports. This intentionally records only identifiers, counts, flags,
    /// and geometry - never message text, tool bodies, or attachment content.
    func recordTranscriptDiagnosticsSnapshot(
        reason: String,
        force: Bool = false,
        isLiveScrolling: Bool? = nil
    ) {
        guard let conversationId else { return }
        if let currentConversationId = scrollState.currentConversationId,
           currentConversationId != conversationId {
            return
        }

        let now = Date()
        if !force && now.timeIntervalSince(scrollState.lastTranscriptDiagnosticsAt) < 1.0 {
            return
        }
        scrollState.lastTranscriptDiagnosticsAt = now

        var sanitizer = NumericSanitizer()
        let offsetY = sanitizer.sanitize(scrollState.lastContentOffsetY, field: "scrollOffsetY")
        let contentHeight = sanitizer.sanitize(scrollState.scrollContentHeight, field: "contentHeight")
        let containerHeight = sanitizer.sanitize(scrollState.scrollContainerHeight, field: "viewportHeight")
        let scrollViewportHeight = sanitizer.sanitize(viewportHeight, field: "scrollViewportHeight")
        let currentContainerWidth = sanitizer.sanitize(containerWidth, field: "containerWidth")
        let distanceFromBottom = scrollState.distanceFromBottom
        let isNearBottom = distanceFromBottom.isFinite
            ? distanceFromBottom <= MessageListScrollState.hideScrollToLatestThreshold
            : nil
        let toolCallCount = messages.reduce(0) { total, message in
            total + message.toolCalls.count
        }

        let snapshot = ChatTranscriptSnapshot(
            conversationId: conversationId.uuidString,
            capturedAt: now,
            messageCount: messages.count,
            toolCallCount: toolCallCount,
            isPinnedToBottom: isNearBottom ?? false,
            isUserScrolling: isLiveScrolling ?? false,
            scrollOffsetY: offsetY,
            contentHeight: contentHeight,
            viewportHeight: containerHeight,
            isNearBottom: isNearBottom,
            hasBeenInteracted: scrollState.scrollContentHeight > 0 || scrollState.lastContentOffsetY > 0,
            isPaginationInFlight: scrollState.isPaginationInFlight,
            scrollMode: scrollState.isStreamingActive ? "streaming" : "idle",
            anchorMessageId: scrollState.pinnedLatestTurnAnchorMessageId?.uuidString,
            highlightedMessageId: highlightedMessageId?.uuidString,
            scrollViewportHeight: scrollViewportHeight,
            containerWidth: currentContainerWidth,
            lastScrollToReason: reason,
            source: .messageList,
            scrollIntentSource: scrollState.isStreamingActive ? .followBottom : nil,
            nonFiniteFields: sanitizer.nonFiniteFields
        )
        ChatDiagnosticsStore.shared.updateSnapshot(snapshot)

        ChatDiagnosticsStore.shared.record(ChatDiagnosticEvent(
            kind: .transcriptSnapshotCaptured,
            conversationId: conversationId.uuidString,
            reason: reason,
            messageCount: messages.count,
            toolCallCount: toolCallCount,
            isPinnedToBottom: isNearBottom,
            isUserScrolling: isLiveScrolling,
            scrollOffsetY: offsetY,
            contentHeight: contentHeight,
            viewportHeight: containerHeight,
            source: .messageList,
            interaction: scrollState.isStreamingActive ? .stream : nil,
            scrollIntentSource: scrollState.isStreamingActive ? .followBottom : nil,
            nonFiniteFields: sanitizer.nonFiniteFields
        ))
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

    // MARK: - Scroll-anchor source diagnostic

    /// Formats a single content-height-source diagnostic event for the
    /// `ScrollAnchorDiag` log category. The coordinator only fires this
    /// callback when the scroll-debug overlay is on AND `contentH` ticked by
    /// less than 8pt — the suspect range for the drift this instrumentation
    /// targets. Output shape (one line per emit):
    ///
    /// ```
    /// contentHΔ=1.0 changed=3: NSStackView(path=0/0/2 minY=2160 h=200→201) ...
    /// ```
    ///
    /// `path` is the index path from the document view; the leftmost segment
    /// is the document view's direct subview index, so two paths with a
    /// common prefix sit in the same subtree.
    static func logContentHeightSource(_ event: ContentHeightSourceDiagnosticEvent) {
        // Cap the per-line output so a single emit can't blow up the log when
        // a layout-storm event sneaks under the 8pt threshold.
        let maxEntries = 12
        let displayed = event.changedSubviews.prefix(maxEntries)
        let summary = displayed.map { c in
            "\(c.typeName)(path=\(c.path) minY=\(Int(c.minY)) h=\(c.previousHeight)→\(c.currentHeight))"
        }.joined(separator: " ")
        let truncated = event.changedSubviews.count > maxEntries
            ? " …+\(event.changedSubviews.count - maxEntries)"
            : ""
        // `.info` rather than `.debug` so the entries land in the in-memory
        // log buffer reachable by `log show --info` and `log stream`.
        // `.debug` would only be retrievable after `log config --mode
        // "level:debug" --subsystem ...`, which is too much setup for a
        // dev-only diagnostic — the sidecar file is the durable path; this
        // emission exists for live tailing.
        scrollDiagLog.info("contentHΔ=\(event.contentHDelta) changed=\(event.changedSubviews.count): \(summary)\(truncated)")
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

    func handleFeatureFlagDidChange(_ notification: Notification) {
        guard let key = notification.userInfo?["key"] as? String, key == "scroll-debug-overlay" else { return }
        let enabled: Bool = MacOSClientFeatureFlagManager.shared.isEnabled("scroll-debug-overlay")
        isScrollDebugOverlayEnabled = enabled
    }

    /// Window-became-key counterpart to `handleConfirmationFocusIfNeeded`:
    /// when the app regains key window status while a pending confirmation
    /// is active, hand focus off the composer so the bubble's key monitor
    /// receives the next keystroke.
    func handleWindowDidBecomeKey(_ notification: Notification) {
        guard let requestId = activePendingRequestId,
              scrollState.lastAutoFocusedRequestId != requestId,
              let window = notification.object as? NSWindow,
              window === NSApp.keyWindow,
              let responder = window.firstResponder as? NSTextView,
              responder.isEditable
        else { return }
        window.makeFirstResponder(nil)
        scrollState.lastAutoFocusedRequestId = requestId
    }
    #endif
}
