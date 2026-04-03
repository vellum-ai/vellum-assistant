import Foundation
import os
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#else
#error("Unsupported platform")
#endif

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ChatActionHandler")

// MARK: - ChatActionHandler

/// Handles all incoming server message dispatch for a chat conversation.
///
/// Owns the `handleServerMessage()` switch and per-case helpers. Holds a weak
/// reference to `ChatViewModel` for reading/writing VM state and calling
/// streaming/surface helper methods on ChatViewModel extensions.
@MainActor
final class ChatActionHandler {

    // MARK: - Dependencies

    weak var viewModel: ChatViewModel?

    init(viewModel: ChatViewModel) {
        self.viewModel = viewModel
    }

    // MARK: - Conversation Ownership

    /// Returns true if the given conversation ID belongs to this chat conversation.
    /// Messages with a nil conversationId are always accepted; messages whose
    /// conversationId doesn't match the current conversation are silently ignored
    /// to prevent cross-conversation contamination (e.g. from pop-out windows or
    /// popover text_qa flows).
    func belongsToConversation(_ messageConversationId: String?) -> Bool {
        guard let vm = viewModel else { return false }
        guard let messageConversationId else { return true }
        guard let conversationId = vm.conversationId else {
            // No conversation established yet — reject messages that belong to
            // a known conversation. This prevents cross-contamination when multiple
            // ViewModels coexist (e.g. pop-out windows). The VM will claim its
            // conversation via bootstrapCorrelationId in the conversationInfo handler.
            return false
        }
        return messageConversationId == conversationId
    }

    // MARK: - Confirmation Helpers

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
    func stampConfirmationOnToolCall(toolName: String, decision: ToolConfirmationState, toolUseId: String? = nil, targetMessageId: UUID? = nil) {
        guard let vm = viewModel else { return }
        let assistantId = targetMessageId ?? vm.currentAssistantMessageId
        guard let assistantId, let msgIdx = vm.messages.firstIndex(where: { $0.id == assistantId }) else { return }
        // Prefer matching by toolUseId for correctness when multiple calls share the same name.
        // Fall back to tool name if ID match fails (e.g. after history restore where
        // ToolCallData entries may not carry toolUseId yet).
        var tcIdx: Int?
        if let toolUseId = toolUseId {
            tcIdx = vm.messages[msgIdx].toolCalls.firstIndex(where: {
                $0.toolUseId == toolUseId
            })
        }
        if tcIdx == nil {
            tcIdx = vm.messages[msgIdx].toolCalls.lastIndex(where: {
                $0.toolName == toolName && $0.confirmationDecision == nil
            })
        }
        if let tcIdx = tcIdx {
            vm.messages[msgIdx].toolCalls[tcIdx].confirmationDecision = decision
            // Clear live pending confirmation now that a decision has been made
            vm.messages[msgIdx].toolCalls[tcIdx].pendingConfirmation = nil
            // Use the tool category from the confirmation data as the label
            let label = ToolConfirmationData(requestId: "", toolName: toolName, riskLevel: "").toolCategory
            vm.messages[msgIdx].toolCalls[tcIdx].confirmationLabel = label
        }
    }

    // MARK: - Server Message Dispatch

    func handleServerMessage(_ message: ServerMessage) {
        guard let vm = viewModel else { return }

        switch message {
        case .conversationInfo(let info):
            handleConversationInfo(info, vm: vm)

        case .userMessageEcho(let echo):
            guard belongsToConversation(echo.conversationId) else { return }
            let userMsg = ChatMessage(role: .user, text: echo.text, status: .sent)
            vm.messages.append(userMsg)
            vm.isSending = true
            vm.isThinking = true

        case .assistantThinkingDelta(let delta):
            guard belongsToConversation(delta.conversationId) else { return }
            guard !vm.isCancelling else { break }
            guard !vm.isLoadingHistory else { break }
            guard !vm.isWorkspaceRefinementInFlight else { break }
            guard MacOSClientFeatureFlagManager.shared.isEnabled("show-thinking-blocks") else { break }
            vm.thinkingDeltaBuffer += delta.thinking
            vm.scheduleThinkingFlush()

        case .assistantTextDelta(let delta):
            handleAssistantTextDelta(delta, vm: vm)

        case .suggestionResponse(let resp):
            // Only accept if this response matches our current request
            guard resp.requestId == vm.pendingSuggestionRequestId else { return }
            vm.pendingSuggestionRequestId = nil
            vm.suggestion = resp.suggestion

        case .messageComplete(let complete):
            handleMessageComplete(complete, vm: vm)

        case .undoComplete(let undoMsg):
            handleUndoComplete(undoMsg, vm: vm)

        case .generationCancelled(let cancelled):
            handleGenerationCancelled(cancelled, vm: vm)

        case .messageQueued(let queued):
            handleMessageQueued(queued, vm: vm)

        case .messageQueuedDeleted(let msg):
            guard belongsToConversation(msg.conversationId) else { return }
            vm.applyQueuedMessageDeletion(requestId: msg.requestId)

        case .messageDequeued(let msg):
            handleMessageDequeued(msg, vm: vm)

        case .messageRequestComplete(let msg):
            handleMessageRequestComplete(msg, vm: vm)

        case .generationHandoff(let handoff):
            handleGenerationHandoff(handoff, vm: vm)

        case .error(let err):
            handleError(err, vm: vm)

        case .confirmationRequest(let msg):
            handleConfirmationRequest(msg, vm: vm)

        case .toolUsePreviewStart(let msg):
            vm.handleToolUsePreviewStart(msg)

        case .toolUseStart(let msg):
            vm.handleToolUseStart(msg)

        case .toolInputDelta(let msg):
            vm.handleToolInputDelta(msg)

        case .toolOutputChunk(let msg):
            vm.handleToolOutputChunk(msg)

        case .toolResult(let msg):
            vm.handleToolResult(msg)

        case .uiSurfaceShow(let msg):
            vm.handleSurfaceShow(msg)

        case .uiSurfaceUndoResult(let msg):
            vm.handleSurfaceUndoResult(msg)

        case .uiSurfaceUpdate(let msg):
            vm.handleSurfaceUpdate(msg)

        case .uiSurfaceDismiss(let msg):
            vm.handleSurfaceDismiss(msg)

        case .uiSurfaceComplete(let msg):
            vm.handleSurfaceComplete(msg)

        case .conversationError(let msg):
            handleConversationError(msg, vm: vm)

        case .confirmationStateChanged(let msg):
            handleConfirmationStateChanged(msg, vm: vm)

        case .assistantActivityState(let msg):
            handleAssistantActivityState(msg, vm: vm)

        case .watchStarted(let msg):
            guard belongsToConversation(msg.conversationId) else { return }
            vm.isWatchSessionActive = true
            vm.onWatchStarted?(msg, vm.connectionManager)

        case .watchCompleteRequest(let msg):
            guard belongsToConversation(msg.conversationId) else { return }
            vm.isWatchSessionActive = false
            vm.onWatchCompleteRequest?(msg)

        case .subagentSpawned(let msg):
            guard belongsToConversation(msg.parentConversationId) else { return }
            let info = SubagentInfo(id: msg.subagentId, label: msg.label, status: .running, parentMessageId: vm.currentAssistantMessageId)
            vm.activeSubagents.append(info)
            vm.subagentDetailStore.recordSpawned(subagentId: msg.subagentId, objective: msg.objective)

        case .subagentStatusChanged(let msg):
            if let index = vm.activeSubagents.firstIndex(where: { $0.id == msg.subagentId }) {
                vm.activeSubagents[index].status = SubagentStatus(wire: msg.status)
                vm.activeSubagents[index].error = msg.error
                vm.subagentDetailStore.recordStatusChanged(subagentId: msg.subagentId, usage: msg.usage)
            }

        case .subagentEvent(let msg):
            guard vm.activeSubagents.contains(where: { $0.id == msg.subagentId }) else { break }
            vm.subagentDetailStore.handleEvent(subagentId: msg.subagentId, event: msg.event)

        case .modelInfo(let msg):
            vm.selectedModel = msg.model
            if let providers = msg.configuredProviders {
                vm.configuredProviders = Set(providers)
            }
            if let allProviders = msg.allProviders, !allProviders.isEmpty {
                vm.providerCatalog = allProviders
            }

        case .memoryStatus(let status):
            // Log degradation state so developers can diagnose memory issues
            // without interrupting the user with a banner.
            let degraded = status.enabled && status.degraded
            if degraded {
                log.warning("Memory is temporarily unavailable – reason: \(status.reason ?? "unknown", privacy: .public)")
            }

        case .guardianActionsPendingResponse(let response):
            vm.handleGuardianActionsPendingResponse(response)

        case .usageUpdate(let update):
            guard belongsToConversation(update.conversationId) else { return }
            if let tokens = update.contextWindowTokens {
                vm.contextWindowTokens = tokens
            }
            if let max = update.contextWindowMaxTokens {
                vm.contextWindowMaxTokens = max
            }

        default:
            break
        }
    }

    // MARK: - Per-Case Handlers

    private func handleConversationInfo(_ info: ConversationInfoMessage, vm: ChatViewModel) {
        // Only claim this conversation_info if:
        // 1. We don't have a conversation yet, AND
        // 2. The correlation ID matches our bootstrap request.
        if vm.conversationId == nil {
            guard let expected = vm.bootstrapCorrelationId,
                  info.correlationId == expected else {
                // No pending bootstrap or correlation mismatch — not ours.
                return
            }

            vm.conversationId = info.conversationId
            vm.bootstrapCorrelationId = nil
            vm.onConversationCreated?(info.conversationId)
            log.info("Chat conversation created: \(info.conversationId)")

            // Fetch pending guardian prompts for this conversation
            vm.refreshGuardianPrompts()

            // Send the queued user message, or finalize a message-less
            // conversation create by clearing the bootstrap sending state.
            if let pending = vm.pendingUserMessage {
                let attachments = vm.pendingUserAttachments
                let automated = vm.pendingUserMessageAutomated
                vm.pendingUserMessage = nil
                vm.pendingUserMessageDisplayText = nil
                vm.pendingUserAttachments = nil
                vm.pendingUserMessageAutomated = false
                vm.eventStreamClient.sendUserMessage(
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
                vm.isSending = false
                vm.isThinking = false
            }
        }
    }

    private func handleAssistantTextDelta(_ delta: AssistantTextDeltaMessage, vm: ChatViewModel) {
        guard belongsToConversation(delta.conversationId) else { return }
        guard !vm.isCancelling else { return }
        guard !vm.isLoadingHistory else { return }
        if vm.isWorkspaceRefinementInFlight {
            vm.refinementTextBuffer += delta.text
            // Throttle refinement streaming updates with 100ms coalescing
            // to prevent republishing the entire accumulated buffer on
            // every single token (same guard-based throttle pattern as
            // scheduleStreamingFlush — not debounce, so flushes fire
            // during streaming even when tokens arrive faster than 100ms).
            if vm.refinementFlushTask == nil {
                vm.refinementFlushTask = Task { @MainActor [weak vm] in
                    try? await Task.sleep(nanoseconds: UInt64(ChatViewModel.streamingFlushInterval * 1_000_000_000))
                    guard !Task.isCancelled, let vm else { return }
                    vm.refinementFlushTask = nil
                    vm.refinementStreamingText = vm.refinementTextBuffer
                }
            }
            return
        }
        // Haptic on first text chunk (thinking → streaming transition)
        if vm.isThinking {
            #if os(iOS)
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            #endif
        }
        vm.isThinking = false
        vm.currentAssistantHasText = true
        if vm.pendingVoiceMessage {
            vm.onVoiceTextDelta?(delta.text)
        }
        // Buffer the delta text and schedule a coalesced flush instead
        // of mutating `messages` on every single token. This reduces
        // SwiftUI view-graph invalidation frequency by ~10-50x.
        vm.streamingDeltaBuffer += delta.text
        vm.scheduleStreamingFlush()
    }

    private func handleMessageComplete(_ complete: MessageCompleteMessage, vm: ChatViewModel) {
        guard belongsToConversation(complete.conversationId) else { return }
        // Auxiliary message_complete events (watch notifiers, call notifications)
        // that lack a messageId should not reset the main agent turn state.
        // Filter when a main agent turn is actively streaming (currentAssistantMessageId
        // is set) OR still in the thinking phase (isThinking is true but
        // currentAssistantMessageId hasn't been set yet by the first streaming flush).
        // This allows slash commands and other non-auxiliary completions to process normally.
        if complete.messageId == nil && (vm.currentAssistantMessageId != nil || vm.isThinking) {
            return
        }
        // Flush any buffered streaming text before finalizing the message.
        vm.flushStreamingBuffer()
        vm.flushPartialOutputBuffer()
        // Backfill the daemon's persisted message ID so fork, inspect,
        // TTS, and other daemon-anchored actions work without a history reload.
        if let messageId = complete.messageId,
           let msgId = vm.currentAssistantMessageId,
           let idx = vm.messages.firstIndex(where: { $0.id == msgId }) {
            vm.messages[idx].daemonMessageId = messageId
        }
        // Strip heavy binary data from old messages to cap memory growth.
        vm.trimOldMessagesIfNeeded()
        let wasRefinement = vm.isWorkspaceRefinementInFlight || vm.cancelledDuringRefinement
        vm.isWorkspaceRefinementInFlight = false
        vm.cancelledDuringRefinement = false
        vm.cancelTimeoutTask?.cancel()
        vm.cancelTimeoutTask = nil
        vm.isCancelling = false
        vm.isThinking = false
        // When a send-direct is pending, this messageComplete is the
        // cancel acknowledgment. Reset all queue state so the follow-up
        // sendMessage() starts a fresh send instead of re-queuing.
        if vm.pendingSendDirectText != nil {
            vm.isSending = false
            vm.pendingQueuedCount = 0
            vm.pendingMessageIds = []
            vm.requestIdToMessageId = [:]
            vm.activeRequestIdToMessageId = [:]
            vm.pendingLocalDeletions.removeAll()
            for i in vm.messages.indices {
                if case .queued = vm.messages[i].status, vm.messages[i].role == .user {
                    vm.messages[i].status = .sent
                }
            }
        } else if vm.pendingQueuedCount == 0 {
            // Only clear isSending if no messages are still queued
            vm.isSending = false
            #if os(iOS)
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            #endif
        }
        // Cancel the throttled refinement flush and do a final immediate
        // flush so the complete buffer is available for the logic below.
        vm.refinementFlushTask?.cancel()
        vm.refinementFlushTask = nil
        if wasRefinement {
            vm.refinementStreamingText = vm.refinementTextBuffer
        }
        // Surface the AI's text response when a refinement produced no update
        if wasRefinement {
            if vm.refinementReceivedSurfaceUpdate {
                // Surface updated — auto-dismiss the activity feed after 2s
                vm.refinementFailureDismissTask?.cancel()
                vm.refinementFailureDismissTask = Task { [weak vm] in
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    guard let vm, !Task.isCancelled else { return }
                    vm.refinementMessagePreview = nil
                    vm.refinementStreamingText = nil
                }
            } else if !vm.refinementTextBuffer.isEmpty {
                let text = vm.refinementTextBuffer.trimmingCharacters(in: .whitespacesAndNewlines)
                if !text.isEmpty {
                    vm.refinementStreamingText = text
                    vm.refinementFailureText = text
                } else {
                    // Buffer was only whitespace — clean up
                    vm.refinementMessagePreview = nil
                    vm.refinementStreamingText = nil
                }
            } else {
                // No surface update and no text — clean up
                vm.refinementMessagePreview = nil
                vm.refinementStreamingText = nil
            }
            vm.refinementTextBuffer = ""
            vm.refinementReceivedSurfaceUpdate = false
        }
        // Must run before currentAssistantMessageId is cleared so attachments land on the right message
        if !wasRefinement {
            vm.ingestAssistantAttachments(complete.attachments)
        }
        if vm.pendingVoiceMessage {
            vm.pendingVoiceMessage = false
            if let existingId = vm.currentAssistantMessageId,
               let index = vm.messages.firstIndex(where: { $0.id == existingId }) {
                let responseText = vm.messages[index].textSegments.joined(separator: "\n")
                vm.onVoiceResponseComplete?(responseText)
            }
        }
        // Fire first-reply callback once when the first complete
        // assistant message arrives (used for bootstrap gate).
        // Guard: only fire if an actual assistant message with content
        // exists, so cancellation-acknowledgement completions that
        // carry no assistant text don't prematurely close the gate.
        if let callback = vm.onFirstAssistantReply {
            if let firstAssistant = vm.messages.first(where: { $0.role == .assistant && !$0.text.isEmpty }) {
                let replyText = firstAssistant.text
                vm.onFirstAssistantReply = nil
                callback(replyText)
            }
        }
        var completedToolCalls: [ToolCallData]?
        if let existingId = vm.currentAssistantMessageId,
           let index = vm.messages.firstIndex(where: { $0.id == existingId }) {
            vm.messages[index].isStreaming = false
            // Delay clearing the code preview so users can see the HTML being written
            let hadCodePreview = vm.messages[index].streamingCodePreview != nil
            if hadCodePreview {
                let msgId = existingId
                Task { @MainActor [weak vm] in
                    try? await Task.sleep(nanoseconds: 5_000_000_000)
                    guard let vm,
                          let idx = vm.messages.firstIndex(where: { $0.id == msgId }) else { return }
                    vm.messages[idx].streamingCodePreview = nil
                    vm.messages[idx].streamingCodeToolName = nil
                }
            } else {
                vm.messages[index].streamingCodePreview = nil
                vm.messages[index].streamingCodeToolName = nil
            }
            // Check if this message has completed tool calls
            let toolCalls = vm.messages[index].toolCalls
            if !toolCalls.isEmpty && toolCalls.allSatisfy({ $0.isComplete }) {
                completedToolCalls = toolCalls
            }
        }
        vm.currentAssistantMessageId = nil
        vm.currentTurnUserText = nil
        vm.currentAssistantHasText = false
        // Reset processing messages to sent and drop attachment base64 data
        // for lazy-loadable attachments (sizeBytes != nil means the daemon can
        // re-serve them). Locally-added attachments (sizeBytes == nil) keep their
        // data because ImageActions.openInPreview / saveFileAttachment rely on it.
        for i in vm.messages.indices {
            if vm.messages[i].role == .user && vm.messages[i].status == .processing {
                vm.messages[i].status = .sent
                for j in vm.messages[i].attachments.indices {
                    if vm.messages[i].attachments[j].sizeBytes != nil {
                        vm.messages[i].attachments[j].data = ""
                        vm.messages[i].attachments[j].dataLength = 0
                    }
                }
            }
        }
        vm.activeRequestIdToMessageId.removeAll()
        vm.dispatchPendingSendDirect()
        // Refresh guardian prompts on message completion (cheap consistency check)
        vm.refreshGuardianPrompts()
        // Skip follow-up suggestions for workspace refinements
        if !vm.isSending && !wasRefinement {
            vm.fetchSuggestion()
        }
        // Notify about completed tool calls
        if let toolCalls = completedToolCalls, let callback = vm.onToolCallsComplete {
            callback(toolCalls)
        }
        // Notify that the assistant response is complete
        if let callback = vm.onResponseComplete, !wasRefinement {
            // Extract a summary from the last assistant message
            if let existingId = vm.messages.last(where: { $0.role == .assistant })?.id,
               let index = vm.messages.firstIndex(where: { $0.id == existingId }) {
                let summary = vm.messages[index].textSegments.joined(separator: "\n")
                callback(summary)
            } else {
                callback("Response complete")
            }
        }
    }

    private func handleUndoComplete(_ undoMsg: UndoCompleteMessage, vm: ChatViewModel) {
        guard belongsToConversation(undoMsg.conversationId) else { return }
        // Remove all messages after the last user message (the assistant
        // exchange that was regenerated). The daemon will immediately start
        // streaming a new response.
        if let lastUserIndex = vm.messages.lastIndex(where: { $0.role == .user }) {
            vm.messages.removeSubrange((lastUserIndex + 1)...)
        }
        vm.currentAssistantMessageId = nil
        vm.currentTurnUserText = nil
        vm.currentAssistantHasText = false
        vm.discardStreamingBuffer()
        vm.discardPartialOutputBuffer()
    }

    private func handleGenerationCancelled(_ cancelled: GenerationCancelledMessage, vm: ChatViewModel) {
        guard belongsToConversation(cancelled.conversationId) else { return }
        let wasCancelling = vm.isCancelling
        vm.isCancelling = false
        // Stale cancel event from a previous cancel cycle — the daemon
        // emits generation_cancelled for each queued entry during abort,
        // but the first event already reset state and dispatched any
        // pending send-direct. Ignore to avoid clobbering the new send.
        if !wasCancelling && vm.isSending {
            return
        }
        vm.pendingVoiceMessage = false
        vm.isWorkspaceRefinementInFlight = false
        vm.refinementFlushTask?.cancel()
        vm.refinementFlushTask = nil
        vm.refinementMessagePreview = nil
        vm.refinementStreamingText = nil
        vm.cancelledDuringRefinement = false
        vm.cancelTimeoutTask?.cancel()
        vm.cancelTimeoutTask = nil
        vm.isThinking = false
        if wasCancelling {
            vm.isSending = false
            vm.pendingQueuedCount = 0
            vm.pendingMessageIds = []
            vm.requestIdToMessageId = [:]
            vm.activeRequestIdToMessageId = [:]
            vm.pendingLocalDeletions.removeAll()
            for i in vm.messages.indices {
                if case .queued = vm.messages[i].status, vm.messages[i].role == .user {
                    vm.messages[i].status = .sent
                }
            }
        } else if vm.pendingQueuedCount == 0 {
            vm.isSending = false
        }
        if let existingId = vm.currentAssistantMessageId,
           let index = vm.messages.firstIndex(where: { $0.id == existingId }) {
            vm.messages[index].isStreaming = false
            vm.messages[index].streamingCodePreview = nil
            vm.messages[index].streamingCodeToolName = nil
            // Mark preview-only tool calls (have toolUseId, not complete, no inputRawDict)
            // as complete/cancelled so they don't remain in a dangling incomplete state.
            for tcIdx in vm.messages[index].toolCalls.indices {
                let tc = vm.messages[index].toolCalls[tcIdx]
                if tc.toolUseId != nil && !tc.isComplete && tc.inputRawDict == nil {
                    vm.messages[index].toolCalls[tcIdx].isComplete = true
                    vm.messages[index].toolCalls[tcIdx].completedAt = Date()
                }
            }
        }
        vm.currentAssistantMessageId = nil
        vm.currentTurnUserText = nil
        vm.currentAssistantHasText = false
        vm.discardStreamingBuffer()
        vm.flushPartialOutputBuffer()
        // Reset processing messages to sent
        for i in vm.messages.indices {
            if vm.messages[i].role == .user && vm.messages[i].status == .processing {
                vm.messages[i].status = .sent
            }
        }
        vm.dispatchPendingSendDirect()
    }

    private func handleMessageQueued(_ queued: MessageQueuedMessage, vm: ChatViewModel) {
        guard belongsToConversation(queued.conversationId) else { return }
        vm.pendingQueuedCount += 1
        // Associate this requestId with the oldest pending user message
        if let messageId = vm.pendingMessageIds.first {
            vm.pendingMessageIds.removeFirst()
            vm.requestIdToMessageId[queued.requestId] = messageId
            // If the user deleted this message before the ack arrived,
            // forward the deletion to the daemon now that we have the requestId.
            if vm.pendingLocalDeletions.remove(messageId) != nil {
                Task {
                    let success = await vm.conversationQueueClient.deleteQueuedMessage(
                        conversationId: queued.conversationId,
                        requestId: queued.requestId
                    )
                    if success {
                        vm.applyQueuedMessageDeletion(requestId: queued.requestId)
                    } else {
                        log.error("Failed to send deferred delete_queued_message")
                    }
                }
            } else if let index = vm.messages.firstIndex(where: { $0.id == messageId }) {
                vm.messages[index].status = .queued(position: queued.position)
            }
        }
    }

    private func handleMessageDequeued(_ msg: MessageDequeuedMessage, vm: ChatViewModel) {
        guard belongsToConversation(msg.conversationId) else { return }
        vm.pendingQueuedCount = max(0, vm.pendingQueuedCount - 1)
        // Mark the associated user message as processing and track its text
        // so assistantTextDelta tags the response correctly.
        if let messageId = vm.requestIdToMessageId.removeValue(forKey: msg.requestId),
           let index = vm.messages.firstIndex(where: { $0.id == messageId }) {
            vm.activeRequestIdToMessageId[msg.requestId] = messageId
            vm.messages[index].status = .processing
            // Only update currentTurnUserText when no agent turn is already
            // in-flight. Synthetic dequeues from inline approval consumption
            // arrive while the agent owns currentTurnUserText; overwriting it
            // with the approval text (e.g. "approve") would break the error
            // handler's secret_blocked message lookup.
            // Also guard on currentTurnUserText == nil to handle the case where
            // the agent is processing but hasn't streamed text yet (so
            // currentAssistantMessageId is still nil).
            if vm.currentAssistantMessageId == nil && vm.currentTurnUserText == nil {
                vm.currentTurnUserText = vm.messages[index].text.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            // Clear attachment binary payloads now that the daemon has persisted them.
            // Keep thumbnailImage for display; the full data can be re-fetched via HTTP if needed.
            // Only clear for lazy-loadable attachments (sizeBytes != nil); locally-created
            // attachments (sizeBytes == nil) can't be re-fetched and need their data preserved.
            for a in vm.messages[index].attachments.indices {
                if !vm.messages[index].attachments[a].data.isEmpty && vm.messages[index].attachments[a].sizeBytes != nil {
                    vm.messages[index].attachments[a].data = ""
                    vm.messages[index].attachments[a].dataLength = 0
                }
            }
        }
        // Recompute positions for remaining queued messages
        for i in vm.messages.indices {
            if case .queued(let position) = vm.messages[i].status, position > 0 {
                vm.messages[i].status = .queued(position: position - 1)
            }
        }
        // The dequeued message is now being processed
        vm.isThinking = true
        vm.isSending = true
    }

    private func handleMessageRequestComplete(_ msg: MessageRequestCompleteMessage, vm: ChatViewModel) {
        guard belongsToConversation(msg.conversationId) else { return }
        if let messageId = vm.activeRequestIdToMessageId.removeValue(forKey: msg.requestId),
           let index = vm.messages.firstIndex(where: { $0.id == messageId }),
           vm.messages[index].role == .user,
           vm.messages[index].status == .processing {
            vm.messages[index].status = .sent
        }
        // When no agent turn is in-flight, finalize the assistant message
        // created by the preceding assistant_text_delta so it doesn't remain
        // stuck in streaming state or cause subsequent deltas to append to it.
        if msg.runStillActive != true {
            vm.flushStreamingBuffer()
            vm.flushPartialOutputBuffer()
            if let existingId = vm.currentAssistantMessageId,
               let index = vm.messages.firstIndex(where: { $0.id == existingId }) {
                vm.messages[index].isStreaming = false
                vm.messages[index].streamingCodePreview = nil
                vm.messages[index].streamingCodeToolName = nil
            }
            vm.currentAssistantMessageId = nil
            vm.currentTurnUserText = nil
            vm.currentAssistantHasText = false
        }
        if msg.runStillActive != true && vm.pendingQueuedCount == 0 {
            vm.isSending = false
            vm.isThinking = false
        }
    }

    private func handleGenerationHandoff(_ handoff: GenerationHandoffMessage, vm: ChatViewModel) {
        guard belongsToConversation(handoff.conversationId) else { return }
        if let requestId = handoff.requestId {
            vm.activeRequestIdToMessageId.removeValue(forKey: requestId)
        }
        vm.isThinking = false
        // Flush buffered text so it lands on the current assistant message
        // before we clear the ID and hand off to the next queued turn.
        vm.flushStreamingBuffer()
        vm.flushPartialOutputBuffer()
        // Must run before currentAssistantMessageId is cleared so attachments land on the right message
        vm.ingestAssistantAttachments(handoff.attachments)
        // Keep isSending = true — daemon is handing off to next queued message
        if let existingId = vm.currentAssistantMessageId,
           let index = vm.messages.firstIndex(where: { $0.id == existingId }) {
            // Backfill the daemon's persisted message ID so fork, inspect,
            // TTS, and other daemon-anchored actions work without a history reload.
            if let messageId = handoff.messageId {
                vm.messages[index].daemonMessageId = messageId
            }
            vm.messages[index].isStreaming = false
            vm.messages[index].streamingCodePreview = nil
            vm.messages[index].streamingCodeToolName = nil
        }
        vm.currentAssistantMessageId = nil
        vm.currentTurnUserText = nil
        vm.currentAssistantHasText = false
        // Reset processing messages to sent and clear attachment binary payloads.
        // Only clear for lazy-loadable attachments (sizeBytes != nil); locally-created
        // attachments (sizeBytes == nil) can't be re-fetched and need their data preserved.
        for i in vm.messages.indices {
            if vm.messages[i].role == .user && vm.messages[i].status == .processing {
                vm.messages[i].status = .sent
                for a in vm.messages[i].attachments.indices {
                    if !vm.messages[i].attachments[a].data.isEmpty && vm.messages[i].attachments[a].sizeBytes != nil {
                        vm.messages[i].attachments[a].data = ""
                        vm.messages[i].attachments[a].dataLength = 0
                    }
                }
            }
        }
    }

    private func handleError(_ err: ErrorMessage, vm: ChatViewModel) {
        log.error("Server error: \(err.message, privacy: .public)")
        // Only process errors relevant to this chat conversation. Generic daemon
        // errors (e.g., validation failures from unrelated message types
        // like work_item_delete) should not pollute the chat UI.
        guard vm.isSending || vm.isThinking || vm.isCancelling || vm.currentAssistantMessageId != nil || vm.isWorkspaceRefinementInFlight else {
            return
        }
        vm.isWorkspaceRefinementInFlight = false
        vm.refinementFlushTask?.cancel()
        vm.refinementFlushTask = nil
        vm.refinementMessagePreview = nil
        vm.refinementStreamingText = nil
        vm.cancelledDuringRefinement = false
        vm.isThinking = false
        vm.pendingVoiceMessage = false
        let wasCancelling = vm.isCancelling
        vm.isCancelling = false
        // Snapshot turn-specific state before reset so the secret_blocked
        // handler below can reference the actual blocked text/attachments
        // rather than falling back to a potentially-wrong transcript lookup.
        let savedTurnUserText = vm.currentTurnUserText
        // Flush any buffered text so already-received tokens are preserved
        // in the assistant message before we clear the turn state.
        vm.flushStreamingBuffer()
        vm.flushPartialOutputBuffer()
        // Mark current assistant message as no longer streaming
        if let existingId = vm.currentAssistantMessageId,
           let index = vm.messages.firstIndex(where: { $0.id == existingId }) {
            vm.messages[index].isStreaming = false
            vm.messages[index].streamingCodePreview = nil
            vm.messages[index].streamingCodeToolName = nil
            // Mark preview-only tool calls as complete on terminal error
            for tcIdx in vm.messages[index].toolCalls.indices {
                let tc = vm.messages[index].toolCalls[tcIdx]
                if tc.toolUseId != nil && !tc.isComplete && tc.inputRawDict == nil {
                    vm.messages[index].toolCalls[tcIdx].isComplete = true
                    vm.messages[index].toolCalls[tcIdx].completedAt = Date()
                }
            }
        }
        vm.currentAssistantMessageId = nil
        vm.currentTurnUserText = nil
        vm.currentAssistantHasText = false
        if !wasCancelling {
            vm.errorText = err.message
            // When the backend blocks a message for containing secrets,
            // stash the full send context so "Send Anyway" can reconstruct
            // the original UserMessageMessage with attachments and surface metadata.
            if err.category == "secret_blocked" {
                let blockedMessageIndex: Int? = {
                    let normalizedTurnText = savedTurnUserText?.trimmingCharacters(in: .whitespacesAndNewlines)
                    if let normalizedTurnText, !normalizedTurnText.isEmpty {
                        return vm.messages.lastIndex(where: {
                            $0.role == .user
                                && $0.text.trimmingCharacters(in: .whitespacesAndNewlines) == normalizedTurnText
                        })
                    }
                    return vm.messages.lastIndex(where: { $0.role == .user })
                }()
                let blockedUserMessage = blockedMessageIndex.map { vm.messages[$0] }

                // Prefer the snapshotted turn text (the text that was actually sent)
                // over the transcript lookup, which can miss workspace refinements
                // that don't append a user chat message.
                if let sendText = savedTurnUserText {
                    vm.secretBlockedMessageText = sendText
                } else if let blockedUserMessage {
                    vm.secretBlockedMessageText = blockedUserMessage.text
                }
                // Reconstruct attachments from the blocked user message's ChatAttachments.
                // Include filePath, sizeBytes, and thumbnailData so file-backed
                // attachments survive the secret-ingress redirect.
                if let blockedUserMessage, !blockedUserMessage.attachments.isEmpty {
                    vm.secretBlockedAttachments = blockedUserMessage.attachments.compactMap { att in
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
                vm.secretBlockedActiveSurfaceId = vm.activeSurfaceId
                vm.secretBlockedCurrentPage = vm.currentPage

                // Remove the blocked user bubble so secret-like text is not
                // retained in chat history after secure save redirect.
                if let blockedMessageIndex {
                    let blockedMessage = vm.messages[blockedMessageIndex]
                    let blockedMessageId = blockedMessage.id
                    if case .queued = blockedMessage.status {
                        vm.pendingQueuedCount = max(0, vm.pendingQueuedCount - 1)
                    }
                    vm.pendingMessageIds.removeAll { $0 == blockedMessageId }
                    vm.requestIdToMessageId = vm.requestIdToMessageId.filter { $0.value != blockedMessageId }
                    vm.activeRequestIdToMessageId = vm.activeRequestIdToMessageId.filter { $0.value != blockedMessageId }
                    vm.pendingLocalDeletions.remove(blockedMessageId)
                    vm.messages.remove(at: blockedMessageIndex)
                }
            }
        }
        // Reset processing messages to sent
        for i in vm.messages.indices {
            if vm.messages[i].role == .user && vm.messages[i].status == .processing {
                vm.messages[i].status = .sent
            }
        }
        // When a cancellation-related generic error arrives while we are
        // in cancel mode, force-clear queue bookkeeping because queued
        // messages will not be processed and no message_dequeued events
        // are expected for them.
        if wasCancelling {
            vm.isSending = false
            vm.pendingQueuedCount = 0
            vm.pendingMessageIds = []
            vm.requestIdToMessageId = [:]
            vm.activeRequestIdToMessageId = [:]
            for i in vm.messages.indices {
                if case .queued = vm.messages[i].status, vm.messages[i].role == .user {
                    vm.messages[i].status = .sent
                }
            }
            vm.dispatchPendingSendDirect()
        } else if vm.pendingQueuedCount == 0 {
            // The daemon drains queued work after a non-cancellation
            // error, so preserve queue bookkeeping when messages are
            // still queued. Only clear everything when the queue is
            // empty.
            vm.isSending = false
            vm.pendingMessageIds = []
            vm.requestIdToMessageId = [:]
            vm.activeRequestIdToMessageId = [:]
        }
    }

    private func handleConfirmationRequest(_ msg: ConfirmationRequestMessage, vm: ChatViewModel) {
        guard !vm.isLoadingHistory else { return }
        // Flush buffered text before inserting the confirmation message.
        vm.flushStreamingBuffer()
        vm.flushPartialOutputBuffer()
        // Route using conversationId when available (daemon >= v1.x includes
        // the conversationId). Fall back to the timestamp-based heuristic
        // via shouldAcceptConfirmation for older daemons that omit conversationId.
        if let msgConversationId = msg.conversationId {
            guard vm.conversationId != nil, belongsToConversation(msgConversationId) else { return }
        } else {
            guard vm.conversationId != nil,
                  vm.lastToolUseReceivedAt != nil,
                  vm.shouldAcceptConfirmation?() ?? false else { return }
        }
        vm.isThinking = false
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
           let assistantId = vm.currentAssistantMessageId,
           let msgIdx = vm.messages.firstIndex(where: { $0.id == assistantId }),
           let tcIdx = vm.messages[msgIdx].toolCalls.firstIndex(where: { $0.toolUseId == toolUseId }) {
            vm.messages[msgIdx].toolCalls[tcIdx].pendingConfirmation = confirmation
        }
        let confirmMsg = ChatMessage(
            role: .assistant,
            text: "",
            confirmation: confirmation
        )
        // Insert after the current streaming assistant message so the
        // assistant's text appears above the confirmation buttons.
        if let existingId = vm.currentAssistantMessageId,
           let index = vm.messages.firstIndex(where: { $0.id == existingId }) {
            vm.messages[index].isStreaming = false
            vm.messages.insert(confirmMsg, at: index + 1)
        } else {
            vm.messages.append(confirmMsg)
        }
    }

    private func handleConversationError(_ msg: ConversationErrorMessage, vm: ChatViewModel) {
        // Empty conversationId is treated as a broadcast (e.g. transport-level 401)
        guard vm.conversationId != nil, msg.conversationId.isEmpty || belongsToConversation(msg.conversationId) else { return }
        log.error("Session error [\(msg.code.rawValue, privacy: .public)]: \(msg.userMessage, privacy: .public)")

        // Per-message send failure: mark the specific user message instead
        // of showing a conversation-level error banner.
        if let failedContent = msg.failedMessageContent {
            if let idx = vm.messages.lastIndex(where: { $0.role == .user && $0.text == failedContent && $0.status != .sendFailed }) {
                vm.messages[idx].status = .sendFailed
            }
            // Only reset sending state if no other messages are in-flight.
            // Check for genuinely in-flight statuses (.processing, .queued)
            // — NOT .sent, which is the default/terminal status for all
            // previously delivered messages. Also treat an active assistant
            // response (currentAssistantMessageId != nil) as in-flight,
            // because direct (non-queued) sends keep the user bubble at
            // .sent while isSending is true and the assistant streams.
            let hasActiveSend = vm.isSending && (
                vm.currentAssistantMessageId != nil ||
                vm.messages.contains(where: { msg in
                    guard msg.role == .user else { return false }
                    if msg.status == .processing { return true }
                    if case .queued = msg.status { return true }
                    return false
                })
            )
            if !hasActiveSend {
                vm.isThinking = false
                vm.isSending = false
            }
            return
        }

        vm.isWorkspaceRefinementInFlight = false
        vm.refinementFlushTask?.cancel()
        vm.refinementFlushTask = nil
        vm.refinementMessagePreview = nil
        vm.refinementStreamingText = nil
        vm.cancelledDuringRefinement = false
        vm.isThinking = false
        vm.pendingVoiceMessage = false
        let wasCancelling = vm.isCancelling
        vm.isCancelling = false
        // Flush any buffered streaming text so the message exists in
        // `messages` before we try to finalize it below. This mirrors
        // the `messageComplete` path and preserves partial assistant
        // text for the user to see alongside the error.
        vm.flushStreamingBuffer()
        if let existingId = vm.currentAssistantMessageId,
           let index = vm.messages.firstIndex(where: { $0.id == existingId }) {
            vm.messages[index].isStreaming = false
            vm.messages[index].streamingCodePreview = nil
            vm.messages[index].streamingCodeToolName = nil
            // Mark preview-only tool calls as complete on conversation error
            for tcIdx in vm.messages[index].toolCalls.indices {
                let tc = vm.messages[index].toolCalls[tcIdx]
                if tc.toolUseId != nil && !tc.isComplete && tc.inputRawDict == nil {
                    vm.messages[index].toolCalls[tcIdx].isComplete = true
                    vm.messages[index].toolCalls[tcIdx].completedAt = Date()
                }
            }
        }
        vm.currentAssistantMessageId = nil
        vm.currentTurnUserText = nil
        vm.currentAssistantHasText = false
        vm.flushPartialOutputBuffer()
        // When the user intentionally cancelled, suppress the error.
        // Otherwise, insert an inline error message so errors are visually
        // distinct from normal assistant replies (rendered with a red box).
        if !wasCancelling {
            let typedError = ConversationError(from: msg)
            vm.conversationError = typedError
            vm.errorText = msg.userMessage
            // Remove empty assistant message left over from the interrupted stream
            if let existingId = vm.messages.last?.id,
               vm.messages.last?.role == .assistant,
               vm.messages.last?.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == true,
               vm.messages.last?.toolCalls.isEmpty == true {
                vm.messages.removeAll(where: { $0.id == existingId })
            }
            // When the managed API key is invalid, trigger automatic
            // reprovision in the background so the next retry uses a fresh key.
            if typedError.isManagedKeyInvalid {
                vm.onManagedKeyInvalid?()
            }
            if vm.shouldCreateInlineErrorMessage?(typedError) ?? true {
                let errorMsg = ChatMessage(role: .assistant, text: msg.userMessage, isError: true, conversationError: typedError)
                vm.messages.append(errorMsg)
                // Mark the error as displayed inline so the toast overlay
                // suppresses its duplicate display, while keeping the typed
                // error state available for downstream consumers (credits-
                // exhausted recovery, sidebar state, iOS banner).
                vm.errorManager.isConversationErrorDisplayedInline = true
            }
        }
        for i in vm.messages.indices {
            if vm.messages[i].role == .user && vm.messages[i].status == .processing {
                vm.messages[i].status = .sent
            }
        }
        if wasCancelling {
            vm.isSending = false
            vm.pendingQueuedCount = 0
            vm.pendingMessageIds = []
            vm.requestIdToMessageId = [:]
            vm.activeRequestIdToMessageId = [:]
            for i in vm.messages.indices {
                if case .queued = vm.messages[i].status, vm.messages[i].role == .user {
                    vm.messages[i].status = .sent
                }
            }
        } else {
            // Always clear sending state so regenerate is unblocked.
            vm.isSending = false
            if vm.pendingQueuedCount == 0 {
                // No queued work remains — safe to tear down everything.
                vm.pendingMessageIds = []
                vm.requestIdToMessageId = [:]
                vm.activeRequestIdToMessageId = [:]
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
    }

    private func handleConfirmationStateChanged(_ msg: ConfirmationStateChangedMessage, vm: ChatViewModel) {
        guard belongsToConversation(msg.conversationId) else { return }
        // Find the confirmation with this requestId and update its state.
        var confirmationToolName: String?
        var precedingAssistantId: UUID?
        for i in vm.messages.indices {
            guard vm.messages[i].confirmation?.requestId == msg.requestId else { continue }
            confirmationToolName = vm.messages[i].confirmation?.toolName
            // Walk backwards past other confirmation messages to find the
            // tool-bearing assistant message. With parallel confirmations the
            // order is [assistant(A), confirm2, confirm1], so looking only one
            // message back would hit confirm2 instead of assistant(A).
            var searchIdx = i
            while searchIdx > vm.messages.startIndex {
                searchIdx = vm.messages.index(before: searchIdx)
                let candidate = vm.messages[searchIdx]
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
                vm.messages[i].confirmation?.state = .approved
                // Preserve approvedDecision if already set locally (the daemon
                // event doesn't carry the decision mode).
            case "denied":
                vm.messages[i].confirmation?.state = .denied
            case "timed_out":
                vm.messages[i].confirmation?.state = .denied
            case "resolved_stale":
                vm.messages[i].confirmation?.state = .denied
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
            for i in vm.messages.indices.reversed() {
                guard vm.messages[i].role == .assistant, vm.messages[i].confirmation == nil else { continue }
                if let tcIdx = vm.messages[i].toolCalls.firstIndex(where: {
                    $0.pendingConfirmation?.requestId == msg.requestId
                }) {
                    vm.messages[i].toolCalls[tcIdx].pendingConfirmation = nil
                    break
                }
            }

            // Clean up the native notification path. If respondToConfirmation /
            // respondToAlwaysAllow already called onInlineConfirmationResponse
            // for this requestId, skip the duplicate call; otherwise forward
            // so externally-resolved confirmations still dismiss notifications.
            if vm.inlineResponseHandledRequestIds.remove(msg.requestId) == nil {
                log.info("[confirm-flow] confirmationStateChanged: forwarding to notification cleanup (not in handledSet): requestId=\(msg.requestId, privacy: .public) state=\(msg.state, privacy: .public)")
                let decisionString = msg.state == "approved" ? "allow" : "deny"
                vm.onInlineConfirmationResponse?(msg.requestId, decisionString)
            } else {
                log.info("[confirm-flow] confirmationStateChanged: skipped notification cleanup (already in handledSet): requestId=\(msg.requestId, privacy: .public) state=\(msg.state, privacy: .public)")
            }
        }
    }

    private func handleAssistantActivityState(_ msg: AssistantActivityStateMessage, vm: ChatViewModel) {
        guard belongsToConversation(msg.conversationId) else { return }
        // Ignore stale events — only accept monotonically increasing versions.
        guard msg.activityVersion > vm.lastActivityVersion else { return }
        vm.lastActivityVersion = msg.activityVersion
        vm.assistantActivityPhase = msg.phase
        vm.assistantActivityAnchor = msg.anchor
        vm.assistantActivityReason = msg.reason
        vm.assistantStatusText = msg.statusText
        vm.isCompacting = msg.reason == "context_compacting"
        switch msg.phase {
        case "thinking":
            vm.isThinking = true
            vm.isSending = false
        case "streaming", "tool_running":
            vm.isThinking = false
        case "idle":
            vm.isThinking = false
        case "awaiting_confirmation":
            vm.isThinking = false
            vm.isSending = false
        default:
            break
        }
    }
}
