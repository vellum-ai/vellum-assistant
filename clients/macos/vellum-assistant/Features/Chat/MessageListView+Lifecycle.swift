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
        let previousConversationId = scrollState.currentConversationId
        let isConversationSwitch = previousConversationId != nil
            && previousConversationId != conversationId
        scrollState.currentConversationId = conversationId
        if isConversationSwitch {
            handleConversationSwitched()
        } else {
            // Start the recovery window for the initial load — LazyVStack
            // height estimates are unreliable until views materialize.
            // (For conversation switches, reset() inside handleConversationSwitched
            // already sets recoveryDeadline.)
            scrollState.recoveryDeadline = Date().addingTimeInterval(2.0)
            // Seed lastMessageId so the CTA and executeScrollToBottom always
            // have a valid ForEach target. Without this, the initial load
            // leaves lastMessageId nil — a CTA tap would fall back to the
            // standalone "scroll-bottom-anchor" which may not be materialized.
            if let lastId = paginatedVisibleMessages.last?.id {
                scrollState.lastMessageId = lastId
            }
        }
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
            $scrollPosition.wrappedValue.scrollTo(id: id, anchor: .center)
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
                        _ = withAnimation(VAnimation.fast) {
                            scrollState.requestPinToBottom(animated: true, userInitiated: true)
                        }
                    }
            }
        } else {
            // Initial load (first mount). Let `.defaultScrollAnchor(.bottom,
            // for: .initialOffset)` handle positioning declaratively —
            // it places the viewport at the bottom in the same layout pass
            // as content rendering. An imperative `scrollToEdge(.bottom)`
            // here would compete with the declarative anchor, causing visible
            // flicker: the viewport jumps down (declarative), then gets
            // yanked again by the imperative call, potentially overshooting
            // into blank LazyVStack estimated space.
            //
            // `.defaultScrollAnchor(.bottom, for: .initialOffset)` handles
            // initial positioning declaratively. The recovery window catches
            // cases where height estimates are unreliable.
        }
    }

    // MARK: - onChange handlers

    func handleSendingChanged() {
        // Guard against stale fires during a conversation switch.
        // onChange handlers fire in declaration order; isSending fires
        // before conversationId, so during a switch this handler sees
        // the NEW isSending value but the OLD scroll state (reset()
        // hasn't run yet). Animated pins targeting stale content
        // accumulate and corrupt SwiftUI's scroll position.
        guard conversationId == scrollState.currentConversationId else { return }
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
                scrollState.transition(to: .followingBottom)
                // Start a fresh recovery window: the animated scroll can
                // overshoot into blank LazyVStack estimated space. Without
                // this, isAtBottom is falsely true at the estimated bottom
                // and persistent recovery doesn't fire — the viewport
                // stays blank until the user scrolls manually.
                scrollState.bottomAnchorAppeared = false
                scrollState.recoveryDeadline = Date().addingTimeInterval(2.0)
                scrollState.requestPinToBottom(animated: true)
                os_signpost(.event, log: PerfSignposts.log, name: "scrollToRequested",
                            "target=bottom reason=sendFollowingBottom")
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
        // onChange(of: messages.count) fires before onChange(of: conversationId),
        // so during a switch this handler sees the NEW message count but
        // the OLD scroll state (reset() hasn't run yet). An animated
        // requestPinToBottom targeting stale content interferes with the
        // subsequent conversation switch flow.
        guard conversationId == scrollState.currentConversationId else { return }
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
        // Keep lastMessageId current so executeScrollToBottom targets ForEach items.
        if let lastId = paginatedVisibleMessages.last?.id {
            scrollState.lastMessageId = lastId
        }
        if anchorMessageId == nil {
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
                if scrollState.mode.allowsAutoScroll && anchorMessageId == nil {
                    // Use mode.allowsAutoScroll (covers both .initialLoad and
                    // .followingBottom) instead of isFollowingBottom (which
                    // returns false for .initialLoad). A resize during initial
                    // load — e.g. app opens with side panel — must still re-pin.
                    // Always re-pin after resize — don't check isAtBottom.
                    // After a width change, LazyVStack re-estimates content heights.
                    // The viewport can be at the *estimated* bottom (blank space)
                    // where distanceFromBottom ≈ 0 → isAtBottom = true, even though
                    // actual content is above. Start a fresh recovery window so
                    // persistent recovery fires unconditionally for 2 seconds.
                    scrollState.bottomAnchorAppeared = false
                    scrollState.recoveryDeadline = Date().addingTimeInterval(2.0)
                    scrollState.requestPinToBottom()
                } else if case .freeBrowsing = scrollState.mode,
                          anchorMessageId == nil,
                          let visibleId = scrollState.cachedFirstVisibleMessageId {
                    // User was scrolled up when resize happened. LazyVStack
                    // re-estimates heights for the new container width, which
                    // can shift content — the viewport may now show blank
                    // estimated space instead of the message the user was
                    // reading. Re-anchor at the first visible message to
                    // maintain the user's reading position.
                    scrollState.performScrollTo(visibleId, anchor: .top)
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
        // reset() already set mode to .initialLoad, which allows auto-scroll.
        // Don't override with .programmaticScroll — that would block
        // handleMessagesCountChanged and content-growth auto-follow during
        // the critical window while LazyVStack materializes new content.
        //
        // Seed lastMessageId so executeScrollToBottom can target it.
        scrollState.lastMessageId = paginatedVisibleMessages.last?.id
        // Declarative position reset — processed in the same layout pass as new content.
        // Prefer the last ForEach message ID over the standalone anchor because
        // ForEach items are always indexable by ScrollPosition even when not
        // materialized — SwiftUI locates them in the data source. The standalone
        // "scroll-bottom-anchor" (outside ForEach) is only locatable when materialized.
        // https://developer.apple.com/documentation/swiftui/scrollposition
        if anchorMessageId == nil {
            if let lastId = paginatedVisibleMessages.last?.id {
                scrollPosition = ScrollPosition(id: lastId, anchor: .bottom)
            } else {
                // Empty conversation — no ForEach items to target.
                // Use edge-based position; the standalone "scroll-bottom-anchor"
                // is outside ForEach and only locatable when materialized.
                scrollPosition = ScrollPosition(edge: .bottom)
            }
        }
    }

    func handleAnchorMessageTask() async {
        // task(id:) fires on initial value and on changes. Only process
        // non-nil anchor assignments; nil transitions are cleanup handled
        // by messagesChanged and conversationSwitched.
        guard let id = anchorMessageId else { return }
        scrollState.pendingAnchorMessageId = id
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
                _ = withAnimation(VAnimation.fast) {
                    scrollState.requestPinToBottom(animated: true, userInitiated: true)
                }
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
