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
        scrollState.currentConversationId = conversationId
        if isConversationSwitch {
            handleConversationSwitched()
        } else {
            // Seed lastMessageId so the scroll-to-bottom overlay always
            // has a valid target.
            if let lastId = paginatedVisibleMessages.last?.id {
                scrollState.lastMessageId = lastId
            }
            // Initial load — scroll to bottom via proxy.
            if let id = anchorMessageId, messages.contains(where: { $0.id == id }) {
                scrollProxy?.scrollTo(id, anchor: .center)
                flashHighlight(messageId: id)
                anchorMessageId = nil
            } else if anchorMessageId == nil {
                scrollProxy?.scrollTo("scroll-bottom-anchor", anchor: .bottom)
            }
        }
    }

    // MARK: - onChange handlers

    func handleSendingChanged() {
        // Guard against stale fires during a conversation switch.
        guard conversationId == scrollState.currentConversationId else { return }
        if isSending {
            // false → true transition: begin a new send cycle.
            scrollState.beginSendCycle()

            // Find the last user message to anchor to viewport top.
            if let userMessage = messages.last(where: { $0.role == .user }),
               scrollState.pendingAnchorMessageId == nil {
                scrollProxy?.scrollTo(userMessage.id, anchor: .top)
                // Schedule a 50ms delayed retry for layout timing —
                // LazyVStack may not have materialized the target yet.
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 50_000_000)
                    scrollProxy?.scrollTo(userMessage.id, anchor: .top)
                }
                scrollState.markSendAnchored()
            }
        } else {
            // true → false transition.
            // Track first-message detection.
            if !hasEverSentMessage && messages.contains(where: { $0.role == .user }) {
                hasEverSentMessage = true
                UserDefaults.standard.set(true, forKey: "hasEverSentMessage")
            }
        }
    }

    func handleMessagesCountChanged() {
        // Guard against stale fires during a conversation switch.
        guard conversationId == scrollState.currentConversationId else { return }

        // Keep lastMessageId current.
        if let lastId = paginatedVisibleMessages.last?.id {
            scrollState.lastMessageId = lastId
        }

        // --- Deep-link anchor resolution ---
        if let id = scrollState.pendingAnchorMessageId,
           messages.contains(where: { $0.id == id }) {
            scrollProxy?.scrollTo(id, anchor: .center)
            flashHighlight(messageId: id)
            scrollState.pendingAnchorMessageId = nil
            return
        }

        // --- Anchor message from binding ---
        if let id = anchorMessageId, messages.contains(where: { $0.id == id }) {
            scrollProxy?.scrollTo(id, anchor: .center)
            flashHighlight(messageId: id)
            anchorMessageId = nil
            return
        }

        // --- Auto-follow on new messages ---
        if scrollState.shouldAutoFollow, scrollProxy != nil {
            scrollProxy?.scrollTo("scroll-bottom-anchor", anchor: .bottom)
        }

        // --- Confirmation focus handoff ---
        #if os(macOS)
        handleConfirmationFocusIfNeeded()
        #endif
    }

    func handleContainerWidthChanged() {
        if scrollState.isNearBottom {
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 100_000_000)
                scrollProxy?.scrollTo("scroll-bottom-anchor", anchor: .bottom)
            }
        }
    }

    func handleConversationSwitched() {
        guard let conversationId else { return }
        scrollState.reset(for: conversationId)
        anchorMessageId = nil
        highlightedMessageId = nil
        // Seed lastMessageId for the new conversation.
        scrollState.lastMessageId = paginatedVisibleMessages.last?.id
        scrollProxy?.scrollTo("scroll-bottom-anchor", anchor: .bottom)
    }

    func handleAnchorMessageTask() async {
        // task(id:) fires on initial value and on changes. Only process
        // non-nil anchor assignments.
        guard let id = anchorMessageId else { return }

        // Deep-link anchor takes precedence — store for resolution.
        scrollState.pendingAnchorMessageId = id

        if messages.contains(where: { $0.id == id }) {
            scrollProxy?.scrollTo(id, anchor: .center)
            flashHighlight(messageId: id)
            anchorMessageId = nil
            scrollState.pendingAnchorMessageId = nil
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
