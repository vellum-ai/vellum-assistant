import Foundation
import os
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#else
#error("Unsupported platform")
#endif

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ChatViewModel+MessageHandling")

// MARK: - Message Handling

extension ChatViewModel {

    /// Returns true if the given conversation ID belongs to this chat conversation.
    /// Messages with a nil conversationId are always accepted; messages whose
    /// conversationId doesn't match the current conversation are silently ignored
    /// to prevent cross-conversation contamination (e.g. from pop-out windows or
    /// popover text_qa flows).
    func belongsToConversation(_ messageConversationId: String?) -> Bool {
        guard let messageConversationId else { return true }
        guard let conversationId else {
            // No conversation established yet — reject messages that belong to
            // a known conversation. This prevents cross-contamination when multiple
            // ViewModels coexist (e.g. pop-out windows). The VM will claim its
            // conversation via bootstrapCorrelationId in the conversationInfo handler.
            return false
        }
        return messageConversationId == conversationId
    }

    /// Map daemon confirmation state string to ToolConfirmationState.
    private func mapConfirmationState(_ state: String) -> ToolConfirmationState? {
        switch state {
        case "approved": return .approved
        case "denied": return .denied
        case "timed_out": return .timedOut
        default: return nil
        }
    }

    /// Stamp confirmation decision on the tool call matching the toolUseId (preferred) or tool name (fallback).
    /// When `targetMessageId` is provided, stamps on that specific message instead of `currentAssistantMessageId`.
    private func stampConfirmationOnToolCall(toolName: String, decision: ToolConfirmationState, toolUseId: String? = nil, targetMessageId: UUID? = nil) {
        let assistantId = targetMessageId ?? currentAssistantMessageId
        guard let assistantId, let msgIdx = messages.firstIndex(where: { $0.id == assistantId }) else { return }
        // Prefer matching by toolUseId for correctness when multiple calls share the same name.
        // Fall back to tool name if ID match fails (e.g. after history restore where
        // ToolCallData entries may not carry toolUseId yet).
        var tcIdx: Int?
        if let toolUseId = toolUseId {
            tcIdx = messages[msgIdx].toolCalls.firstIndex(where: {
                $0.toolUseId == toolUseId
            })
        }
        if tcIdx == nil {
            tcIdx = messages[msgIdx].toolCalls.lastIndex(where: {
                $0.toolName == toolName && $0.confirmationDecision == nil
            })
        }
        if let tcIdx = tcIdx {
            messages[msgIdx].toolCalls[tcIdx].confirmationDecision = decision
            // Clear live pending confirmation now that a decision has been made
            messages[msgIdx].toolCalls[tcIdx].pendingConfirmation = nil
            // Use the tool category from the confirmation data as the label
            let label = ToolConfirmationData(requestId: "", toolName: toolName, riskLevel: "").toolCategory
            messages[msgIdx].toolCalls[tcIdx].confirmationLabel = label
        }
    }

    public func handleServerMessage(_ message: ServerMessage) {
        switch message {
        case .conversationInfo(let info):
            // Only claim this conversation_info if:
            // 1. We don't have a conversation yet, AND
            // 2. The correlation ID matches our bootstrap request.
            if conversationId == nil {
                guard let expected = bootstrapCorrelationId,
                      info.correlationId == expected else {
                    // No pending bootstrap or correlation mismatch — not ours.
                    break
                }

                conversationId = info.conversationId
                bootstrapCorrelationId = nil
                onConversationCreated?(info.conversationId)
                log.info("Chat conversation created: \(info.conversationId)")

                // Fetch pending guardian prompts for this conversation
                refreshGuardianPrompts()

                // Send the queued user message, or finalize a message-less
                // conversation create by clearing the bootstrap sending state.
                if let pending = pendingUserMessage {
                    let attachments = pendingUserAttachments
                    let automated = pendingUserMessageAutomated
                    pendingUserMessage = nil
                    pendingUserMessageDisplayText = nil
                    pendingUserAttachments = nil
                    pendingUserMessageAutomated = false
                    eventStreamClient.sendUserMessage(
                        content: pending,
                        conversationId: info.conversationId,
                        attachments: attachments,
                        conversationType: nil,
                        automated: automated ? true : nil,
                        bypassSecretCheck: nil
                    )
                } else {
                    // Message-less conversation create (e.g. private conversation
                    // pre-allocation) — conversation is claimed, reset UI state.
                    isSending = false
                    isThinking = false
                }
            }

        case .userMessageEcho(let echo):
            guard belongsToConversation(echo.conversationId) else { return }
            let userMsg = ChatMessage(role: .user, text: echo.text, status: .sent)
            messages.append(userMsg)
            isSending = true
            isThinking = true

        case .assistantThinkingDelta:
            // Stay in thinking state
            break

        case .assistantTextDelta(let delta):
            guard belongsToConversation(delta.conversationId) else { return }
            guard !isCancelling else { return }
            guard !isLoadingHistory else { return }
            if isWorkspaceRefinementInFlight {
                refinementTextBuffer += delta.text
                // Throttle refinement streaming updates with 100ms coalescing
                // to prevent republishing the entire accumulated buffer on
                // every single token (same guard-based throttle pattern as
                // scheduleStreamingFlush — not debounce, so flushes fire
                // during streaming even when tokens arrive faster than 100ms).
                if refinementFlushTask == nil {
                    refinementFlushTask = Task { @MainActor [weak self] in
                        try? await Task.sleep(nanoseconds: UInt64(Self.streamingFlushInterval * 1_000_000_000))
                        guard !Task.isCancelled, let self else { return }
                        self.refinementFlushTask = nil
                        self.refinementStreamingText = self.refinementTextBuffer
                    }
                }
                return
            }
            // Haptic on first text chunk (thinking → streaming transition)
            if isThinking {
                #if os(iOS)
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                #endif
            }
            isThinking = false
            currentAssistantHasText = true
            if pendingVoiceMessage {
                onVoiceTextDelta?(delta.text)
            }
            // Buffer the delta text and schedule a coalesced flush instead
            // of mutating `messages` on every single token. This reduces
            // SwiftUI view-graph invalidation frequency by ~10-50x.
            streamingDeltaBuffer += delta.text
            scheduleStreamingFlush()

        case .suggestionResponse(let resp):
            // Only accept if this response matches our current request
            guard resp.requestId == pendingSuggestionRequestId else { return }
            pendingSuggestionRequestId = nil
            suggestion = resp.suggestion

        case .messageComplete(let complete):
            guard belongsToConversation(complete.conversationId) else { return }
            // Flush any buffered streaming text before finalizing the message.
            flushStreamingBuffer()
            flushPartialOutputBuffer()
            // Backfill the daemon's persisted message ID so fork, inspect,
            // TTS, and other daemon-anchored actions work without a history reload.
            if let messageId = complete.messageId,
               let msgId = currentAssistantMessageId,
               let idx = messages.firstIndex(where: { $0.id == msgId }) {
                messages[idx].daemonMessageId = messageId
            }
            // Strip heavy binary data from old messages to cap memory growth.
            trimOldMessagesIfNeeded()
            let wasRefinement = isWorkspaceRefinementInFlight || cancelledDuringRefinement
            isWorkspaceRefinementInFlight = false
            cancelledDuringRefinement = false
            cancelTimeoutTask?.cancel()
            cancelTimeoutTask = nil
            isCancelling = false
            isThinking = false
            // When a send-direct is pending, this messageComplete is the
            // cancel acknowledgment. Reset all queue state so the follow-up
            // sendMessage() starts a fresh send instead of re-queuing.
            if pendingSendDirectText != nil {
                isSending = false
                pendingQueuedCount = 0
                pendingMessageIds = []
                requestIdToMessageId = [:]
                activeRequestIdToMessageId = [:]
                pendingLocalDeletions.removeAll()
                for i in messages.indices {
                    if case .queued = messages[i].status, messages[i].role == .user {
                        messages[i].status = .sent
                    }
                }
            } else if pendingQueuedCount == 0 {
                // Only clear isSending if no messages are still queued
                isSending = false
                #if os(iOS)
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                #endif
            }
            // Cancel the throttled refinement flush and do a final immediate
            // flush so the complete buffer is available for the logic below.
            refinementFlushTask?.cancel()
            refinementFlushTask = nil
            if wasRefinement {
                refinementStreamingText = refinementTextBuffer
            }
            // Surface the AI's text response when a refinement produced no update
            if wasRefinement {
                if refinementReceivedSurfaceUpdate {
                    // Surface updated — auto-dismiss the activity feed after 2s
                    refinementFailureDismissTask?.cancel()
                    refinementFailureDismissTask = Task { [weak self] in
                        try? await Task.sleep(nanoseconds: 2_000_000_000)
                        guard let self, !Task.isCancelled else { return }
                        self.refinementMessagePreview = nil
                        self.refinementStreamingText = nil
                    }
                } else if !refinementTextBuffer.isEmpty {
                    let text = refinementTextBuffer.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !text.isEmpty {
                        refinementStreamingText = text
                        refinementFailureText = text
                    } else {
                        // Buffer was only whitespace — clean up
                        refinementMessagePreview = nil
                        refinementStreamingText = nil
                    }
                } else {
                    // No surface update and no text — clean up
                    refinementMessagePreview = nil
                    refinementStreamingText = nil
                }
                refinementTextBuffer = ""
                refinementReceivedSurfaceUpdate = false
            }
            // Must run before currentAssistantMessageId is cleared so attachments land on the right message
            if !wasRefinement {
                ingestAssistantAttachments(complete.attachments)
            }
            if pendingVoiceMessage {
                pendingVoiceMessage = false
                if let existingId = currentAssistantMessageId,
                   let index = messages.firstIndex(where: { $0.id == existingId }) {
                    let responseText = messages[index].textSegments.joined(separator: "\n")
                    onVoiceResponseComplete?(responseText)
                }
            }
            // Fire first-reply callback once when the first complete
            // assistant message arrives (used for bootstrap gate).
            // Guard: only fire if an actual assistant message with content
            // exists, so cancellation-acknowledgement completions that
            // carry no assistant text don't prematurely close the gate.
            if let callback = onFirstAssistantReply {
                if let firstAssistant = messages.first(where: { $0.role == .assistant && !$0.text.isEmpty }) {
                    let replyText = firstAssistant.text
                    onFirstAssistantReply = nil
                    callback(replyText)
                }
            }
            var completedToolCalls: [ToolCallData]?
            if let existingId = currentAssistantMessageId,
               let index = messages.firstIndex(where: { $0.id == existingId }) {
                messages[index].isStreaming = false
                // Delay clearing the code preview so users can see the HTML being written
                let hadCodePreview = messages[index].streamingCodePreview != nil
                if hadCodePreview {
                    let msgId = existingId
                    Task { @MainActor [weak self] in
                        try? await Task.sleep(nanoseconds: 5_000_000_000)
                        guard let self,
                              let idx = self.messages.firstIndex(where: { $0.id == msgId }) else { return }
                        self.messages[idx].streamingCodePreview = nil
                        self.messages[idx].streamingCodeToolName = nil
                    }
                } else {
                    messages[index].streamingCodePreview = nil
                    messages[index].streamingCodeToolName = nil
                }
                // Check if this message has completed tool calls
                let toolCalls = messages[index].toolCalls
                if !toolCalls.isEmpty && toolCalls.allSatisfy({ $0.isComplete }) {
                    completedToolCalls = toolCalls
                }
            }
            currentAssistantMessageId = nil
            currentTurnUserText = nil
            currentAssistantHasText = false
            lastContentWasToolCall = false
            // Reset processing messages to sent and drop attachment base64 data
            // for lazy-loadable attachments (sizeBytes != nil means the daemon can
            // re-serve them). Locally-added attachments (sizeBytes == nil) keep their
            // data because ImageActions.openInPreview / saveFileAttachment rely on it.
            for i in messages.indices {
                if messages[i].role == .user && messages[i].status == .processing {
                    messages[i].status = .sent
                    for j in messages[i].attachments.indices {
                        if messages[i].attachments[j].sizeBytes != nil {
                            messages[i].attachments[j].data = ""
                            messages[i].attachments[j].dataLength = 0
                        }
                    }
                }
            }
            activeRequestIdToMessageId.removeAll()
            dispatchPendingSendDirect()
            // Refresh guardian prompts on message completion (cheap consistency check)
            refreshGuardianPrompts()
            // Skip follow-up suggestions for workspace refinements
            if !isSending && !wasRefinement {
                fetchSuggestion()
            }
            // Notify about completed tool calls
            if let toolCalls = completedToolCalls, let callback = onToolCallsComplete {
                callback(toolCalls)
            }
            // Notify that the assistant response is complete
            if let callback = onResponseComplete, !wasRefinement {
                // Extract a summary from the last assistant message
                if let existingId = messages.last(where: { $0.role == .assistant })?.id,
                   let index = messages.firstIndex(where: { $0.id == existingId }) {
                    let summary = messages[index].textSegments.joined(separator: "\n")
                    callback(summary)
                } else {
                    callback("Response complete")
                }
            }

        case .undoComplete(let undoMsg):
            guard belongsToConversation(undoMsg.conversationId) else { return }
            // Remove all messages after the last user message (the assistant
            // exchange that was regenerated). The daemon will immediately start
            // streaming a new response.
            if let lastUserIndex = messages.lastIndex(where: { $0.role == .user }) {
                messages.removeSubrange((lastUserIndex + 1)...)
            }
            currentAssistantMessageId = nil
            currentTurnUserText = nil
            currentAssistantHasText = false
            lastContentWasToolCall = false
            discardStreamingBuffer()
            discardPartialOutputBuffer()

        case .generationCancelled(let cancelled):
            guard belongsToConversation(cancelled.conversationId) else { return }
            let wasCancelling = isCancelling
            isCancelling = false
            // Stale cancel event from a previous cancel cycle — the daemon
            // emits generation_cancelled for each queued entry during abort,
            // but the first event already reset state and dispatched any
            // pending send-direct. Ignore to avoid clobbering the new send.
            if !wasCancelling && isSending {
                return
            }
            pendingVoiceMessage = false
            isWorkspaceRefinementInFlight = false
            refinementFlushTask?.cancel()
            refinementFlushTask = nil
            refinementMessagePreview = nil
            refinementStreamingText = nil
            cancelledDuringRefinement = false
            cancelTimeoutTask?.cancel()
            cancelTimeoutTask = nil
            isThinking = false
            if wasCancelling {
                isSending = false
                pendingQueuedCount = 0
                pendingMessageIds = []
                requestIdToMessageId = [:]
                activeRequestIdToMessageId = [:]
                pendingLocalDeletions.removeAll()
                for i in messages.indices {
                    if case .queued = messages[i].status, messages[i].role == .user {
                        messages[i].status = .sent
                    }
                }
            } else if pendingQueuedCount == 0 {
                isSending = false
            }
            if let existingId = currentAssistantMessageId,
               let index = messages.firstIndex(where: { $0.id == existingId }) {
                messages[index].isStreaming = false
                messages[index].streamingCodePreview = nil
                messages[index].streamingCodeToolName = nil
                // Mark preview-only tool calls (have toolUseId, not complete, no inputRawDict)
                // as complete/cancelled so they don't remain in a dangling incomplete state.
                for tcIdx in messages[index].toolCalls.indices {
                    let tc = messages[index].toolCalls[tcIdx]
                    if tc.toolUseId != nil && !tc.isComplete && tc.inputRawDict == nil {
                        messages[index].toolCalls[tcIdx].isComplete = true
                        messages[index].toolCalls[tcIdx].completedAt = Date()
                    }
                }
            }
            currentAssistantMessageId = nil
            currentTurnUserText = nil
            currentAssistantHasText = false
            lastContentWasToolCall = false
            discardStreamingBuffer()
            flushPartialOutputBuffer()
            // Reset processing messages to sent
            for i in messages.indices {
                if messages[i].role == .user && messages[i].status == .processing {
                    messages[i].status = .sent
                }
            }
            dispatchPendingSendDirect()

        case .messageQueued(let queued):
            guard belongsToConversation(queued.conversationId) else { return }
            pendingQueuedCount += 1
            // Associate this requestId with the oldest pending user message
            if let messageId = pendingMessageIds.first {
                pendingMessageIds.removeFirst()
                requestIdToMessageId[queued.requestId] = messageId
                // If the user deleted this message before the ack arrived,
                // forward the deletion to the daemon now that we have the requestId.
                if pendingLocalDeletions.remove(messageId) != nil {
                    Task {
                        let success = await conversationQueueClient.deleteQueuedMessage(
                            conversationId: queued.conversationId,
                            requestId: queued.requestId
                        )
                        if success {
                            applyQueuedMessageDeletion(requestId: queued.requestId)
                        } else {
                            log.error("Failed to send deferred delete_queued_message")
                        }
                    }
                } else if let index = messages.firstIndex(where: { $0.id == messageId }) {
                    messages[index].status = .queued(position: queued.position)
                }
            }

        case .messageQueuedDeleted(let msg):
            guard belongsToConversation(msg.conversationId) else { return }
            applyQueuedMessageDeletion(requestId: msg.requestId)

        case .messageDequeued(let msg):
            guard belongsToConversation(msg.conversationId) else { return }
            pendingQueuedCount = max(0, pendingQueuedCount - 1)
            // Mark the associated user message as processing and track its text
            // so assistantTextDelta tags the response correctly.
            if let messageId = requestIdToMessageId.removeValue(forKey: msg.requestId),
               let index = messages.firstIndex(where: { $0.id == messageId }) {
                activeRequestIdToMessageId[msg.requestId] = messageId
                messages[index].status = .processing
                // Only update currentTurnUserText when no agent turn is already
                // in-flight. Synthetic dequeues from inline approval consumption
                // arrive while the agent owns currentTurnUserText; overwriting it
                // with the approval text (e.g. "approve") would break the error
                // handler's secret_blocked message lookup.
                // Also guard on currentTurnUserText == nil to handle the case where
                // the agent is processing but hasn't streamed text yet (so
                // currentAssistantMessageId is still nil).
                if currentAssistantMessageId == nil && currentTurnUserText == nil {
                    currentTurnUserText = messages[index].text.trimmingCharacters(in: .whitespacesAndNewlines)
                }
                // Clear attachment binary payloads now that the daemon has persisted them.
                // Keep thumbnailImage for display; the full data can be re-fetched via HTTP if needed.
                // Only clear for lazy-loadable attachments (sizeBytes != nil); locally-created
                // attachments (sizeBytes == nil) can't be re-fetched and need their data preserved.
                for a in messages[index].attachments.indices {
                    if !messages[index].attachments[a].data.isEmpty && messages[index].attachments[a].sizeBytes != nil {
                        messages[index].attachments[a].data = ""
                        messages[index].attachments[a].dataLength = 0
                    }
                }
            }
            // Recompute positions for remaining queued messages
            for i in messages.indices {
                if case .queued(let position) = messages[i].status, position > 0 {
                    messages[i].status = .queued(position: position - 1)
                }
            }
            // The dequeued message is now being processed
            isThinking = true
            isSending = true

        case .messageRequestComplete(let msg):
            guard belongsToConversation(msg.conversationId) else { return }
            if let messageId = activeRequestIdToMessageId.removeValue(forKey: msg.requestId),
               let index = messages.firstIndex(where: { $0.id == messageId }),
               messages[index].role == .user,
               messages[index].status == .processing {
                messages[index].status = .sent
            }
            // When no agent turn is in-flight, finalize the assistant message
            // created by the preceding assistant_text_delta so it doesn't remain
            // stuck in streaming state or cause subsequent deltas to append to it.
            if msg.runStillActive != true {
                flushStreamingBuffer()
                flushPartialOutputBuffer()
                if let existingId = currentAssistantMessageId,
                   let index = messages.firstIndex(where: { $0.id == existingId }) {
                    messages[index].isStreaming = false
                    messages[index].streamingCodePreview = nil
                    messages[index].streamingCodeToolName = nil
                }
                currentAssistantMessageId = nil
                currentTurnUserText = nil
                currentAssistantHasText = false
                lastContentWasToolCall = false
            }
            if msg.runStillActive != true && pendingQueuedCount == 0 {
                isSending = false
                isThinking = false
            }

        case .generationHandoff(let handoff):
            guard belongsToConversation(handoff.conversationId) else { return }
            if let requestId = handoff.requestId {
                activeRequestIdToMessageId.removeValue(forKey: requestId)
            }
            isThinking = false
            // Flush buffered text so it lands on the current assistant message
            // before we clear the ID and hand off to the next queued turn.
            flushStreamingBuffer()
            flushPartialOutputBuffer()
            // Must run before currentAssistantMessageId is cleared so attachments land on the right message
            ingestAssistantAttachments(handoff.attachments)
            // Keep isSending = true — daemon is handing off to next queued message
            if let existingId = currentAssistantMessageId,
               let index = messages.firstIndex(where: { $0.id == existingId }) {
                // Backfill the daemon's persisted message ID so fork, inspect,
                // TTS, and other daemon-anchored actions work without a history reload.
                if let messageId = handoff.messageId {
                    messages[index].daemonMessageId = messageId
                }
                messages[index].isStreaming = false
                messages[index].streamingCodePreview = nil
                messages[index].streamingCodeToolName = nil
            }
            currentAssistantMessageId = nil
            currentTurnUserText = nil
            currentAssistantHasText = false
            lastContentWasToolCall = false
            // Reset processing messages to sent and clear attachment binary payloads.
            // Only clear for lazy-loadable attachments (sizeBytes != nil); locally-created
            // attachments (sizeBytes == nil) can't be re-fetched and need their data preserved.
            for i in messages.indices {
                if messages[i].role == .user && messages[i].status == .processing {
                    messages[i].status = .sent
                    for a in messages[i].attachments.indices {
                        if !messages[i].attachments[a].data.isEmpty && messages[i].attachments[a].sizeBytes != nil {
                            messages[i].attachments[a].data = ""
                            messages[i].attachments[a].dataLength = 0
                        }
                    }
                }
            }

        case .error(let err):
            log.error("Server error: \(err.message, privacy: .public)")
            // Only process errors relevant to this chat conversation. Generic daemon
            // errors (e.g., validation failures from unrelated message types
            // like work_item_delete) should not pollute the chat UI.
            guard isSending || isThinking || isCancelling || currentAssistantMessageId != nil || isWorkspaceRefinementInFlight else {
                return
            }
            isWorkspaceRefinementInFlight = false
            refinementFlushTask?.cancel()
            refinementFlushTask = nil
            refinementMessagePreview = nil
            refinementStreamingText = nil
            cancelledDuringRefinement = false
            isThinking = false
            pendingVoiceMessage = false
            let wasCancelling = isCancelling
            isCancelling = false
            // Snapshot turn-specific state before reset so the secret_blocked
            // handler below can reference the actual blocked text/attachments
            // rather than falling back to a potentially-wrong transcript lookup.
            let savedTurnUserText = currentTurnUserText
            // Flush any buffered text so already-received tokens are preserved
            // in the assistant message before we clear the turn state.
            flushStreamingBuffer()
            flushPartialOutputBuffer()
            // Mark current assistant message as no longer streaming
            if let existingId = currentAssistantMessageId,
               let index = messages.firstIndex(where: { $0.id == existingId }) {
                messages[index].isStreaming = false
                messages[index].streamingCodePreview = nil
                messages[index].streamingCodeToolName = nil
                // Mark preview-only tool calls as complete on terminal error
                for tcIdx in messages[index].toolCalls.indices {
                    let tc = messages[index].toolCalls[tcIdx]
                    if tc.toolUseId != nil && !tc.isComplete && tc.inputRawDict == nil {
                        messages[index].toolCalls[tcIdx].isComplete = true
                        messages[index].toolCalls[tcIdx].completedAt = Date()
                    }
                }
            }
            currentAssistantMessageId = nil
            currentTurnUserText = nil
            currentAssistantHasText = false
            lastContentWasToolCall = false
            if !wasCancelling {
                errorText = err.message
                // When the backend blocks a message for containing secrets,
                // stash the full send context so "Send Anyway" can reconstruct
                // the original UserMessageMessage with attachments and surface metadata.
                if err.category == "secret_blocked" {
                    let blockedMessageIndex: Int? = {
                        let normalizedTurnText = savedTurnUserText?.trimmingCharacters(in: .whitespacesAndNewlines)
                        if let normalizedTurnText, !normalizedTurnText.isEmpty {
                            return messages.lastIndex(where: {
                                $0.role == .user
                                    && $0.text.trimmingCharacters(in: .whitespacesAndNewlines) == normalizedTurnText
                            })
                        }
                        return messages.lastIndex(where: { $0.role == .user })
                    }()
                    let blockedUserMessage = blockedMessageIndex.map { messages[$0] }

                    // Prefer the snapshotted turn text (the text that was actually sent)
                    // over the transcript lookup, which can miss workspace refinements
                    // that don't append a user chat message.
                    if let sendText = savedTurnUserText {
                        secretBlockedMessageText = sendText
                    } else if let blockedUserMessage {
                        secretBlockedMessageText = blockedUserMessage.text
                    }
                    // Reconstruct attachments from the blocked user message's ChatAttachments.
                    // Include filePath, sizeBytes, and thumbnailData so file-backed
                    // attachments survive the secret-ingress redirect.
                    if let blockedUserMessage, !blockedUserMessage.attachments.isEmpty {
                        secretBlockedAttachments = blockedUserMessage.attachments.compactMap { att in
                            guard !att.data.isEmpty || att.filePath != nil else { return nil }
                            return UserMessageAttachment(
                                filename: att.filename,
                                mimeType: att.mimeType,
                                data: att.data,
                                extractedText: nil,
                                sizeBytes: att.sizeBytes,
                                thumbnailData: att.thumbnailData?.base64EncodedString(),
                                filePath: att.filePath
                            )
                        }
                    }
                    secretBlockedActiveSurfaceId = activeSurfaceId
                    secretBlockedCurrentPage = currentPage

                    // Remove the blocked user bubble so secret-like text is not
                    // retained in chat history after secure save redirect.
                    if let blockedMessageIndex {
                        let blockedMessage = messages[blockedMessageIndex]
                        let blockedMessageId = blockedMessage.id
                        if case .queued = blockedMessage.status {
                            pendingQueuedCount = max(0, pendingQueuedCount - 1)
                        }
                        pendingMessageIds.removeAll { $0 == blockedMessageId }
                        requestIdToMessageId = requestIdToMessageId.filter { $0.value != blockedMessageId }
                        activeRequestIdToMessageId = activeRequestIdToMessageId.filter { $0.value != blockedMessageId }
                        pendingLocalDeletions.remove(blockedMessageId)
                        messages.remove(at: blockedMessageIndex)
                    }
                }
            }
            // Reset processing messages to sent
            for i in messages.indices {
                if messages[i].role == .user && messages[i].status == .processing {
                    messages[i].status = .sent
                }
            }
            // When a cancellation-related generic error arrives while we are
            // in cancel mode, force-clear queue bookkeeping because queued
            // messages will not be processed and no message_dequeued events
            // are expected for them.
            if wasCancelling {
                isSending = false
                pendingQueuedCount = 0
                pendingMessageIds = []
                requestIdToMessageId = [:]
                activeRequestIdToMessageId = [:]
                for i in messages.indices {
                    if case .queued = messages[i].status, messages[i].role == .user {
                        messages[i].status = .sent
                    }
                }
                dispatchPendingSendDirect()
            } else if pendingQueuedCount == 0 {
                // The daemon drains queued work after a non-cancellation
                // error, so preserve queue bookkeeping when messages are
                // still queued. Only clear everything when the queue is
                // empty.
                isSending = false
                pendingMessageIds = []
                requestIdToMessageId = [:]
                activeRequestIdToMessageId = [:]
            }

        case .confirmationRequest(let msg):
            guard !isLoadingHistory else { return }
            // Flush buffered text before inserting the confirmation message.
            flushStreamingBuffer()
            flushPartialOutputBuffer()
            // Route using conversationId when available (daemon >= v1.x includes
            // the conversationId). Fall back to the timestamp-based heuristic
            // via shouldAcceptConfirmation for older daemons that omit conversationId.
            if let msgConversationId = msg.conversationId {
                guard conversationId != nil, belongsToConversation(msgConversationId) else { return }
            } else {
                guard conversationId != nil,
                      lastToolUseReceivedAt != nil,
                      shouldAcceptConfirmation?() ?? false else { return }
            }
            isThinking = false
            #if os(iOS)
            UINotificationFeedbackGenerator().notificationOccurred(.warning)
            #endif
            let confirmation = ToolConfirmationData(
                requestId: msg.requestId,
                toolName: msg.toolName,
                input: msg.input,
                riskLevel: msg.riskLevel,
                diff: msg.diff,
                allowlistOptions: msg.allowlistOptions,
                scopeOptions: msg.scopeOptions,
                executionTarget: msg.executionTarget,
                persistentDecisionsAllowed: msg.persistentDecisionsAllowed ?? true,
                temporaryOptionsAvailable: msg.temporaryOptionsAvailable ?? [],
                toolUseId: msg.toolUseId
            )
            // Attach confirmation to matching tool call if toolUseId is available
            if let toolUseId = msg.toolUseId,
               let assistantId = currentAssistantMessageId,
               let msgIdx = messages.firstIndex(where: { $0.id == assistantId }),
               let tcIdx = messages[msgIdx].toolCalls.firstIndex(where: { $0.toolUseId == toolUseId }) {
                messages[msgIdx].toolCalls[tcIdx].pendingConfirmation = confirmation
            }
            let confirmMsg = ChatMessage(
                role: .assistant,
                text: "",
                confirmation: confirmation
            )
            // Insert after the current streaming assistant message so the
            // assistant's text appears above the confirmation buttons.
            if let existingId = currentAssistantMessageId,
               let index = messages.firstIndex(where: { $0.id == existingId }) {
                messages[index].isStreaming = false
                messages.insert(confirmMsg, at: index + 1)
            } else {
                messages.append(confirmMsg)
            }

        case .toolUsePreviewStart(let msg):
            handleToolUsePreviewStart(msg)

        case .toolUseStart(let msg):
            handleToolUseStart(msg)

        case .toolInputDelta(let msg):
            handleToolInputDelta(msg)

        case .toolOutputChunk(let msg):
            handleToolOutputChunk(msg)

        case .toolResult(let msg):
            handleToolResult(msg)

        case .uiSurfaceShow(let msg):
            handleSurfaceShow(msg)

        case .uiSurfaceUndoResult(let msg):
            handleSurfaceUndoResult(msg)

        case .uiSurfaceUpdate(let msg):
            handleSurfaceUpdate(msg)

        case .uiSurfaceDismiss(let msg):
            handleSurfaceDismiss(msg)

        case .uiSurfaceComplete(let msg):
            handleSurfaceComplete(msg)

        case .conversationError(let msg):
            // Empty conversationId is treated as a broadcast (e.g. transport-level 401)
            guard conversationId != nil, msg.conversationId.isEmpty || belongsToConversation(msg.conversationId) else { return }
            log.error("Session error [\(msg.code.rawValue, privacy: .public)]: \(msg.userMessage, privacy: .public)")

            // Per-message send failure: mark the specific user message instead
            // of showing a conversation-level error banner.
            if let failedContent = msg.failedMessageContent {
                if let idx = messages.lastIndex(where: { $0.role == .user && $0.text == failedContent && $0.status != .sendFailed }) {
                    messages[idx].status = .sendFailed
                }
                // Only reset sending state if no other messages are in-flight.
                // Check for genuinely in-flight statuses (.processing, .queued)
                // — NOT .sent, which is the default/terminal status for all
                // previously delivered messages. Also treat an active assistant
                // response (currentAssistantMessageId != nil) as in-flight,
                // because direct (non-queued) sends keep the user bubble at
                // .sent while isSending is true and the assistant streams.
                let hasActiveSend = isSending && (
                    currentAssistantMessageId != nil ||
                    messages.contains(where: { msg in
                        guard msg.role == .user else { return false }
                        if msg.status == .processing { return true }
                        if case .queued = msg.status { return true }
                        return false
                    })
                )
                if !hasActiveSend {
                    isThinking = false
                    isSending = false
                }
                return
            }

            isWorkspaceRefinementInFlight = false
            refinementFlushTask?.cancel()
            refinementFlushTask = nil
            refinementMessagePreview = nil
            refinementStreamingText = nil
            cancelledDuringRefinement = false
            isThinking = false
            pendingVoiceMessage = false
            let wasCancelling = isCancelling
            isCancelling = false
            // Flush any buffered streaming text so the message exists in
            // `messages` before we try to finalize it below. This mirrors
            // the `messageComplete` path and preserves partial assistant
            // text for the user to see alongside the error.
            flushStreamingBuffer()
            if let existingId = currentAssistantMessageId,
               let index = messages.firstIndex(where: { $0.id == existingId }) {
                messages[index].isStreaming = false
                messages[index].streamingCodePreview = nil
                messages[index].streamingCodeToolName = nil
                // Mark preview-only tool calls as complete on conversation error
                for tcIdx in messages[index].toolCalls.indices {
                    let tc = messages[index].toolCalls[tcIdx]
                    if tc.toolUseId != nil && !tc.isComplete && tc.inputRawDict == nil {
                        messages[index].toolCalls[tcIdx].isComplete = true
                        messages[index].toolCalls[tcIdx].completedAt = Date()
                    }
                }
            }
            currentAssistantMessageId = nil
            currentTurnUserText = nil
            currentAssistantHasText = false
            lastContentWasToolCall = false
            flushPartialOutputBuffer()
            // When the user intentionally cancelled, suppress the error.
            // Otherwise, insert an inline error message so errors are visually
            // distinct from normal assistant replies (rendered with a red box).
            if !wasCancelling {
                let typedError = ConversationError(from: msg)
                conversationError = typedError
                errorText = msg.userMessage
                // Remove empty assistant message left over from the interrupted stream
                if let existingId = messages.last?.id,
                   messages.last?.role == .assistant,
                   messages.last?.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == true,
                   messages.last?.toolCalls.isEmpty == true {
                    messages.removeAll(where: { $0.id == existingId })
                }
                // When the managed API key is invalid, trigger automatic
                // reprovision in the background so the next retry uses a fresh key.
                if typedError.isManagedKeyInvalid {
                    onManagedKeyInvalid?()
                }
                if shouldCreateInlineErrorMessage?(typedError) ?? true {
                    let errorMsg = ChatMessage(role: .assistant, text: msg.userMessage, isError: true, conversationError: typedError)
                    messages.append(errorMsg)
                    // Mark the error as displayed inline so the toast overlay
                    // suppresses its duplicate display, while keeping the typed
                    // error state available for downstream consumers (credits-
                    // exhausted recovery, sidebar state, iOS banner).
                    errorManager.isConversationErrorDisplayedInline = true
                }
            }
            for i in messages.indices {
                if messages[i].role == .user && messages[i].status == .processing {
                    messages[i].status = .sent
                }
            }
            if wasCancelling {
                isSending = false
                pendingQueuedCount = 0
                pendingMessageIds = []
                requestIdToMessageId = [:]
                activeRequestIdToMessageId = [:]
                for i in messages.indices {
                    if case .queued = messages[i].status, messages[i].role == .user {
                        messages[i].status = .sent
                    }
                }
            } else {
                // Always clear sending state so regenerate is unblocked.
                isSending = false
                if pendingQueuedCount == 0 {
                    // No queued work remains — safe to tear down everything.
                    pendingMessageIds = []
                    requestIdToMessageId = [:]
                    activeRequestIdToMessageId = [:]
                } else {
                    // The daemon drains queued work after a conversation_error
                    // (session.ts calls drainQueue in `finally`), so preserve
                    // pendingQueuedCount, pendingMessageIds, requestIdToMessageId,
                    // and queued message statuses. Incoming message_dequeued events
                    // need requestIdToMessageId to correlate to user messages.
                    // messageDequeued will re-set isSending=true when the next
                    // queued message starts processing.
                }
            }

        case .confirmationStateChanged(let msg):
            guard belongsToConversation(msg.conversationId) else { return }
            // Find the confirmation with this requestId and update its state.
            var confirmationToolName: String?
            var precedingAssistantId: UUID?
            for i in messages.indices {
                guard messages[i].confirmation?.requestId == msg.requestId else { continue }
                confirmationToolName = messages[i].confirmation?.toolName
                // Walk backwards past other confirmation messages to find the
                // tool-bearing assistant message. With parallel confirmations the
                // order is [assistant(A), confirm2, confirm1], so looking only one
                // message back would hit confirm2 instead of assistant(A).
                var searchIdx = i
                while searchIdx > messages.startIndex {
                    searchIdx = messages.index(before: searchIdx)
                    let candidate = messages[searchIdx]
                    if candidate.role == .assistant && !candidate.toolCalls.isEmpty {
                        precedingAssistantId = candidate.id
                        break
                    }
                    // Skip past confirmation messages (assistant messages with .confirmation set)
                    if candidate.role == .assistant && candidate.confirmation != nil { continue }
                    break
                }
                switch msg.state {
                case "approved":
                    messages[i].confirmation?.state = .approved
                    // Preserve approvedDecision if already set locally (the daemon
                    // event doesn't carry the decision mode).
                case "denied":
                    messages[i].confirmation?.state = .denied
                case "timed_out":
                    messages[i].confirmation?.state = .denied
                case "resolved_stale":
                    messages[i].confirmation?.state = .denied
                default:
                    break
                }
                break
            }
            // Stamp confirmation data on the corresponding ToolCallData in the
            // preceding assistant message so it survives conversation switches.
            let decision = mapConfirmationState(msg.state)
            if let toolName = confirmationToolName,
               let state = decision {
                stampConfirmationOnToolCall(toolName: toolName, decision: state, toolUseId: msg.toolUseId, targetMessageId: precedingAssistantId)
            }
            // Clear pendingConfirmation when the confirmation reaches a terminal state
            // (approved, denied, timed_out, resolved_stale) — but NOT on "pending" which
            // is the initial state transition that fires immediately after the request is created.
            if msg.state != "pending" {
                for i in messages.indices.reversed() {
                    guard messages[i].role == .assistant, messages[i].confirmation == nil else { continue }
                    if let tcIdx = messages[i].toolCalls.firstIndex(where: {
                        $0.pendingConfirmation?.requestId == msg.requestId
                    }) {
                        messages[i].toolCalls[tcIdx].pendingConfirmation = nil
                        break
                    }
                }

                // Clean up the native notification path. If respondToConfirmation /
                // respondToAlwaysAllow already called onInlineConfirmationResponse
                // for this requestId, skip the duplicate call; otherwise forward
                // so externally-resolved confirmations still dismiss notifications.
                if inlineResponseHandledRequestIds.remove(msg.requestId) == nil {
                    log.info("[confirm-flow] confirmationStateChanged: forwarding to notification cleanup (not in handledSet): requestId=\(msg.requestId, privacy: .public) state=\(msg.state, privacy: .public)")
                    let decisionString = msg.state == "approved" ? "allow" : "deny"
                    onInlineConfirmationResponse?(msg.requestId, decisionString)
                } else {
                    log.info("[confirm-flow] confirmationStateChanged: skipped notification cleanup (already in handledSet): requestId=\(msg.requestId, privacy: .public) state=\(msg.state, privacy: .public)")
                }
            }

        case .assistantActivityState(let msg):
            guard belongsToConversation(msg.conversationId) else { return }
            // Ignore stale events — only accept monotonically increasing versions.
            guard msg.activityVersion > lastActivityVersion else { return }
            lastActivityVersion = msg.activityVersion
            assistantActivityPhase = msg.phase
            assistantActivityAnchor = msg.anchor
            assistantActivityReason = msg.reason
            assistantStatusText = msg.statusText
            isCompacting = msg.reason == "context_compacting"
            switch msg.phase {
            case "thinking":
                isThinking = true
                isSending = false
            case "streaming", "tool_running":
                isThinking = false
            case "idle":
                isThinking = false
            case "awaiting_confirmation":
                isThinking = false
                isSending = false
            default:
                break
            }

        case .watchStarted(let msg):
            guard belongsToConversation(msg.conversationId) else { return }
            isWatchSessionActive = true
            onWatchStarted?(msg, connectionManager)

        case .watchCompleteRequest(let msg):
            guard belongsToConversation(msg.conversationId) else { return }
            isWatchSessionActive = false
            onWatchCompleteRequest?(msg)

        case .subagentSpawned(let msg):
            guard belongsToConversation(msg.parentConversationId) else { return }
            let info = SubagentInfo(id: msg.subagentId, label: msg.label, status: .running, parentMessageId: currentAssistantMessageId)
            activeSubagents.append(info)
            subagentDetailStore.recordSpawned(subagentId: msg.subagentId, objective: msg.objective)

        case .subagentStatusChanged(let msg):
            if let index = activeSubagents.firstIndex(where: { $0.id == msg.subagentId }) {
                activeSubagents[index].status = SubagentStatus(wire: msg.status)
                activeSubagents[index].error = msg.error
                subagentDetailStore.recordStatusChanged(subagentId: msg.subagentId, usage: msg.usage)
            }

        case .subagentEvent(let msg):
            guard activeSubagents.contains(where: { $0.id == msg.subagentId }) else { break }
            subagentDetailStore.handleEvent(subagentId: msg.subagentId, event: msg.event)

        case .modelInfo(let msg):
            selectedModel = msg.model
            if let providers = msg.configuredProviders {
                configuredProviders = Set(providers)
            }
            if let allProviders = msg.allProviders, !allProviders.isEmpty {
                providerCatalog = allProviders
            }

        case .memoryStatus(let status):
            // Log degradation state so developers can diagnose memory issues
            // without interrupting the user with a banner.
            let degraded = status.enabled && status.degraded
            if degraded {
                log.warning("Memory is temporarily unavailable – reason: \(status.reason ?? "unknown", privacy: .public)")
            }

        case .guardianActionsPendingResponse(let response):
            handleGuardianActionsPendingResponse(response)

        case .guardianActionDecisionResponse(let response):
            handleGuardianActionDecisionResponse(response)

        default:
            break
        }
    }

}
