import Combine
import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "MessageSendCoordinator")

/// Protocol defining the ChatViewModel state and actions that the send coordinator
/// needs to read/write. ChatViewModel conforms to this, avoiding a direct reference
/// from the coordinator back to the view model.
@MainActor
protocol MessageSendCoordinatorDelegate: AnyObject {
    // MARK: - State reads
    var conversationId: String? { get set }
    var activeSurfaceId: String? { get }
    var isChatDockedToSide: Bool { get }
    var conversationType: String? { get }
    var isBootstrapping: Bool { get }
    var isCancelling: Bool { get set }
    var cancelledDuringRefinement: Bool { get set }
    var currentAssistantMessageId: UUID? { get set }
    var currentTurnUserText: String? { get set }
    var currentAssistantHasText: Bool { get set }
    var pendingMessageIds: [UUID] { get set }
    var requestIdToMessageId: [String: UUID] { get set }
    var activeRequestIdToMessageId: [String: UUID] { get set }
    var pendingLocalDeletions: Set<UUID> { get set }
    var bootstrapCorrelationId: String? { get set }
    var pendingUserMessage: String? { get set }
    var pendingUserMessageDisplayText: String? { get set }
    var pendingUserMessageAutomated: Bool { get set }
    var pendingUserAttachments: [UserMessageAttachment]? { get set }
    var pendingVoiceMessage: Bool { get set }
    var lastFailedMessageText: String? { get set }
    var lastFailedMessageDisplayText: String? { get set }
    var lastFailedMessageAttachments: [UserMessageAttachment]? { get set }
    var lastFailedMessageAutomated: Bool { get set }
    var lastFailedMessageBypassSecretCheck: Bool { get set }
    var lastFailedSendError: String? { get set }
    var secretBlockedMessageText: String? { get set }
    var secretBlockedAttachments: [UserMessageAttachment]? { get set }
    var secretBlockedActiveSurfaceId: String? { get set }
    var secretBlockedCurrentPage: String? { get set }
    var pendingSendDirectText: String? { get set }
    var pendingSendDirectAttachments: [ChatAttachment]? { get set }
    var pendingSendDirectSkillInvocation: SkillInvocationData? { get set }
    var cancelTimeoutTask: Task<Void, Never>? { get set }
    var needsOfflineFlush: Bool { get set }
    var preactivatedSkillIds: [String]? { get set }
    var pendingSuggestionRequestId: String? { get set }
    var pendingOnboardingContext: PreChatOnboardingContext? { get set }
    var hasIncompleteToolCalls: Bool { get }
    var isAssistantBusy: Bool { get }

    // MARK: - Connection & streaming
    var connectionManager: GatewayConnectionManager { get }
    var eventStreamClient: EventStreamClient { get }

    // MARK: - Actions
    func flushCoalescedPublish()
    func startMessageLoop()
    func refreshGuardianPrompts()
    func discardStreamingBuffer()
    func discardPartialOutputBuffer()
    func flushStreamingBuffer()

    // MARK: - Callbacks
    var onFork: (() -> Void)? { get }
    var onConversationCreated: ((String) -> Void)? { get }
    var onFirstUserMessage: ((String) -> Void)? { get set }
    var onUserMessageSent: (() -> Void)? { get }
    var messageLoopTask: Task<Void, Never>? { get }
}

/// Side-effect coordinator that owns the message send/cancel/queue logic.
/// Not @Observable — this is a side-effect coordinator with no view-facing state.
/// All ChatViewModel state is accessed through the `MessageSendCoordinatorDelegate`
/// protocol, avoiding a direct reference back to the view model.
@MainActor
final class MessageSendCoordinator {

    private weak var delegate: (any MessageSendCoordinatorDelegate)?
    private let messageManager: ChatMessageManager
    private let attachmentManager: ChatAttachmentManager
    private let errorManager: ChatErrorManager
    private let btwState: ChatBtwState
    private let settingsClient: any SettingsClientProtocol
    private let conversationListClient: any ConversationListClientProtocol

    init(
        delegate: any MessageSendCoordinatorDelegate,
        messageManager: ChatMessageManager,
        attachmentManager: ChatAttachmentManager,
        errorManager: ChatErrorManager,
        btwState: ChatBtwState,
        settingsClient: any SettingsClientProtocol,
        conversationListClient: any ConversationListClientProtocol
    ) {
        self.delegate = delegate
        self.messageManager = messageManager
        self.attachmentManager = attachmentManager
        self.errorManager = errorManager
        self.btwState = btwState
        self.settingsClient = settingsClient
        self.conversationListClient = conversationListClient

        delegate.eventStreamClient.onUserMessagePersisted = { [weak self] conversationId, content, messageId in
            guard let self else { return }
            self.tagOptimisticRow(conversationId: conversationId, content: content, messageId: messageId)
        }
    }

    /// Tags the most-recent optimistic user row matching `content` with the
    /// daemon-assigned `messageId` so that a subsequent `user_message_echo`
    /// SSE event can be deduped (PR 4) instead of double-rendering.
    private func tagOptimisticRow(conversationId: String, content: String, messageId: String) {
        guard let delegate, delegate.conversationId == conversationId else { return }
        if let idx = messageManager.messages.indices.reversed().first(where: {
            messageManager.messages[$0].role == .user
                && messageManager.messages[$0].text == content
                && messageManager.messages[$0].daemonMessageId == nil
        }) {
            messageManager.messages[idx].daemonMessageId = messageId
        }
    }

    // MARK: - Platform helper

    private var sendPathPlatform: ChatSlashCommandPlatform {
        #if os(macOS)
        return .macos
        #elseif os(iOS)
        return .ios
        #else
        #error("Unsupported platform")
        #endif
    }

    private static let privateConversationForkErrorText =
        "Forking is unavailable in private conversations."

    // MARK: - Send Message

    func sendMessage(hidden: Bool = false) {
        guard let delegate else { return }

        let rawText = messageManager.inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        let text = rawText
        let hasAttachments = !attachmentManager.pendingAttachments.isEmpty
        let hasSkillInvocation = messageManager.pendingSkillInvocation != nil
        guard !text.isEmpty || hasAttachments || hasSkillInvocation else { return }

        // Intercept the exact `/fork` command locally so it never falls
        // through to the assistant as ordinary chat text.
        if text == "/fork",
           !hasAttachments,
           !hasSkillInvocation
        {
            messageManager.inputText = ""
            messageManager.suggestion = nil
            delegate.pendingSuggestionRequestId = nil
            delegate.flushCoalescedPublish()
            if delegate.conversationType == "private" {
                errorManager.errorText = Self.privateConversationForkErrorText
                errorManager.conversationError = nil
            } else if let onFork = delegate.onFork {
                errorManager.errorText = nil
                errorManager.conversationError = nil
                onFork()
            } else {
                errorManager.errorText = "Send a message before forking this conversation."
            }
            return
        }

        // Intercept /btw side-chain messages before the normal send path.
        if text.hasPrefix("/btw ") {
            let question = String(text.dropFirst(5)).trimmingCharacters(in: .whitespaces)
            messageManager.inputText = ""
            attachmentManager.pendingAttachments = []
            messageManager.pendingSkillInvocation = nil
            delegate.flushCoalescedPublish()
            btwState.sendBtwMessage(question: question, conversationKey: delegate.conversationId ?? "")
            return
        }

        // Confirmation state is now server-authoritative: the daemon emits
        // `confirmation_state_changed` events for all resolution paths.
        // No client-side pessimistic denial is needed.

        // Refresh model state only for slash commands that explicitly opt in.
        let shouldRefreshModelMetadata = !hasSkillInvocation
            && ChatSlashCommandCatalog.shouldRefreshModelMetadata(
                forRawInput: text,
                platform: sendPathPlatform
            )
        if shouldRefreshModelMetadata {
            Task { [weak self] in
                guard let self, self.delegate != nil else { return }
                let info = await self.settingsClient.fetchModelInfo()
                if let model = info?.model {
                    self.messageManager.selectedModel = model
                }
                if let providers = info?.configuredProviders {
                    self.messageManager.configuredProviders = Set(providers)
                }
                if let allProviders = info?.allProviders, !allProviders.isEmpty {
                    self.messageManager.providerCatalog = allProviders
                }
            }
        }

        // Fire auto-title callback on the first user message (skip slash commands
        // so the conversation title isn't set to a command token)
        if !rawText.isEmpty, !rawText.hasPrefix("/"), let callback = delegate.onFirstUserMessage {
            delegate.onFirstUserMessage = nil
            callback(rawText)
        }

        // Notify ConversationManager so the conversation rises to the top of the list
        delegate.onUserMessageSent?()

        // Block rapid-fire only when bootstrapping with a queued message.
        // When a message-less bootstrap is in flight (e.g. private conversation
        // pre-allocation), adopt the user's message as the pending message
        // so it gets sent when conversation_info arrives instead of being dropped.
        if (messageManager.isSending || delegate.isBootstrapping) && delegate.conversationId == nil {
            if delegate.pendingUserMessage == nil {
                messageManager.isSending = true
                let attachments = attachmentManager.pendingAttachments
                attachmentManager.pendingAttachments = []
                delegate.pendingUserMessage = text
                delegate.pendingUserMessageDisplayText = rawText
                delegate.pendingUserMessageAutomated = hidden
                delegate.pendingUserAttachments = attachments.isEmpty ? nil : attachments.map {
                    UserMessageAttachment(filename: $0.filename, mimeType: $0.mimeType, data: $0.data, extractedText: nil, filePath: $0.filePath)
                }
                messageManager.isThinking = true
                var userMsg = ChatMessage(role: .user, text: rawText, status: .sent, skillInvocation: messageManager.pendingSkillInvocation, attachments: attachments)
                userMsg.isHidden = hidden
                messageManager.messages.append(userMsg)
                messageManager.pendingSkillInvocation = nil
                messageManager.inputText = ""
                messageManager.suggestion = nil
                delegate.pendingSuggestionRequestId = nil
                errorManager.errorText = nil
                errorManager.conversationError = nil
                errorManager.isConversationErrorDisplayedInline = false
                delegate.lastFailedMessageText = nil
                delegate.lastFailedMessageDisplayText = nil
                delegate.lastFailedMessageAttachments = nil
                delegate.lastFailedMessageAutomated = false
                delegate.lastFailedMessageBypassSecretCheck = false
                delegate.lastFailedSendError = nil
                errorManager.connectionDiagnosticHint = nil
                delegate.secretBlockedMessageText = nil
                delegate.secretBlockedAttachments = nil
                delegate.secretBlockedActiveSurfaceId = nil
                delegate.secretBlockedCurrentPage = nil
                delegate.currentTurnUserText = rawText
                delegate.flushCoalescedPublish()
                return
            }
            messageManager.pendingSkillInvocation = nil
            messageManager.inputText = ""
            attachmentManager.pendingAttachments = []
            delegate.flushCoalescedPublish()
            return
        }

        // Snapshot and clear pending attachments
        let attachments = attachmentManager.pendingAttachments
        attachmentManager.pendingAttachments = []

        let shouldBypassWorkspaceRefinement = ChatSlashCommandCatalog.shouldBypassWorkspaceRefinement(
            forRawInput: text,
            platform: sendPathPlatform
        )
        let isWorkspaceRefinement = delegate.activeSurfaceId != nil && !delegate.isChatDockedToSide && !shouldBypassWorkspaceRefinement

        let willBeQueued = messageManager.isSending && delegate.conversationId != nil
        var queuedMessageId: UUID?
        if !isWorkspaceRefinement {
            let status: ChatMessageStatus = willBeQueued ? .queued(position: 0) : .sent
            var userMessage = ChatMessage(role: .user, text: rawText, status: status, skillInvocation: messageManager.pendingSkillInvocation, attachments: attachments)
            userMessage.isHidden = hidden
            messageManager.messages.append(userMessage)
            if willBeQueued {
                delegate.pendingMessageIds.append(userMessage.id)
                queuedMessageId = userMessage.id
            }
        } else {
            messageManager.isWorkspaceRefinementInFlight = true
            messageManager.refinementMessagePreview = text
            messageManager.refinementStreamingText = nil
            messageManager.refinementTextBuffer = ""
            messageManager.refinementReceivedSurfaceUpdate = false
            messageManager.refinementFailureText = nil
            messageManager.refinementFailureDismissTask?.cancel()
        }
        messageManager.pendingSkillInvocation = nil
        messageManager.inputText = ""
        messageManager.suggestion = nil
        delegate.pendingSuggestionRequestId = nil
        errorManager.errorText = nil
        errorManager.conversationError = nil
        errorManager.isConversationErrorDisplayedInline = false
        delegate.lastFailedMessageText = nil
        delegate.lastFailedMessageDisplayText = nil
        delegate.lastFailedMessageAttachments = nil
        delegate.lastFailedMessageAutomated = false
        delegate.lastFailedMessageBypassSecretCheck = false
        delegate.lastFailedSendError = nil
        errorManager.connectionDiagnosticHint = nil
        delegate.secretBlockedMessageText = nil
        delegate.secretBlockedAttachments = nil
        delegate.secretBlockedActiveSurfaceId = nil
        delegate.secretBlockedCurrentPage = nil
        delegate.flushCoalescedPublish()

        let messageAttachments: [UserMessageAttachment]? = attachments.isEmpty ? nil : attachments.map {
            UserMessageAttachment(filename: $0.filename, mimeType: $0.mimeType, data: $0.data, extractedText: nil, filePath: $0.filePath)
        }

        // Track the user text for this turn so assistantTextDelta can tag the
        // response correctly (e.g. modelList for "/models") without scanning the
        // whole transcript. For queued messages this is set in messageDequeued.
        if !willBeQueued {
            delegate.currentTurnUserText = rawText
        }

        if delegate.conversationId == nil {
            // First message: need to bootstrap conversation
            delegate.pendingUserMessageDisplayText = rawText
            delegate.pendingUserMessageAutomated = hidden
            bootstrapConversation(userMessage: text, attachments: messageAttachments)
        } else {
            // Subsequent messages: send directly (daemon queues if busy)
            sendUserMessage(text, displayText: rawText, attachments: messageAttachments, queuedMessageId: queuedMessageId, automated: hidden)
        }
    }

    // MARK: - Bootstrap Conversation

    func bootstrapConversation(userMessage: String?, attachments: [UserMessageAttachment]?) {
        guard let delegate else { return }

        // Only set sending/thinking indicators when there's an actual user
        // message; message-less conversation creates (e.g. private conversation
        // pre-allocation) are silent and shouldn't affect UI state.
        if userMessage != nil {
            messageManager.isSending = true
            messageManager.isThinking = true
        }
        delegate.pendingUserMessage = userMessage
        delegate.pendingUserAttachments = attachments

        // Generate a unique correlation ID so this ChatViewModel only claims
        // the conversation_info response that belongs to its own conversation_create request.
        let correlationId = UUID().uuidString
        delegate.bootstrapCorrelationId = correlationId

        Task { @MainActor [weak self] in
            guard let self, let delegate = self.delegate else { return }

            // Ensure daemon connection
            if !delegate.connectionManager.isConnected {
                do {
                    try await delegate.connectionManager.connect()
                } catch {
                    log.error("Failed to connect to daemon: \(error.localizedDescription)")
                    self.messageManager.isThinking = false
                    self.messageManager.isSending = false
                    delegate.bootstrapCorrelationId = nil
                    delegate.lastFailedMessageText = delegate.pendingUserMessage
                    delegate.lastFailedMessageDisplayText = delegate.pendingUserMessageDisplayText
                    delegate.lastFailedMessageAttachments = delegate.pendingUserAttachments
                    delegate.lastFailedMessageAutomated = delegate.pendingUserMessageAutomated
                    delegate.lastFailedMessageBypassSecretCheck = false
                    delegate.lastFailedSendError = "Failed to connect to the assistant."
                    errorManager.connectionDiagnosticHint = ChatViewModel.connectionDiagnosticHint(for: error)
                    delegate.pendingUserMessage = nil
                    delegate.pendingUserMessageDisplayText = nil
                    delegate.pendingUserAttachments = nil
                    delegate.pendingUserMessageAutomated = false
                    self.errorManager.errorText = delegate.lastFailedSendError
                    return
                }
            }

            // Subscribe to daemon stream
            delegate.startMessageLoop()

            // Generate conversation ID locally — conversation creation is implicit
            // for HTTP transport. The conversationKey acts as the conversation.
            let newConversationId = correlationId
            delegate.conversationId = newConversationId
            delegate.bootstrapCorrelationId = nil
            delegate.onConversationCreated?(newConversationId)
            // Clear one-shot preactivated skills so they don't leak into a
            // later conversation if this bootstrap is interrupted before completion.
            delegate.preactivatedSkillIds = nil
            log.info("Chat conversation created: \(newConversationId)")

            // Fetch pending guardian prompts for this conversation
            delegate.refreshGuardianPrompts()

            // Send the queued user message, or finalize a message-less
            // conversation create by clearing the bootstrap sending state.
            if let pending = delegate.pendingUserMessage {
                let pendingAttachments = delegate.pendingUserAttachments
                let automated = delegate.pendingUserMessageAutomated
                delegate.pendingUserMessage = nil
                delegate.pendingUserMessageDisplayText = nil
                delegate.pendingUserAttachments = nil
                delegate.pendingUserMessageAutomated = false
                self.sendUserMessage(pending, attachments: pendingAttachments, automated: automated)
            } else {
                self.messageManager.isSending = false
                self.messageManager.isThinking = false
            }
        }
    }

    // MARK: - Send User Message

    func sendUserMessage(_ text: String, displayText: String? = nil, attachments: [UserMessageAttachment]? = nil, queuedMessageId: UUID? = nil, automated: Bool = false, bypassSecretCheck: Bool = false) {
        guard let delegate else { return }
        guard let conversationId = delegate.conversationId else { return }

        // Check connectivity before entering sending state so the UI
        // doesn't get stuck with isSending/isThinking = true when the
        // daemon has disconnected between turns.
        guard delegate.connectionManager.isConnected else {
            log.error("Cannot send user_message: daemon not connected")

            // Buffer the primary (non-queued-retry) send in the offline queue
            // instead of surfacing an error. The message stays visible with a
            // "pending" indicator and is flushed automatically on reconnect.
            if queuedMessageId == nil {
                log.info("Buffering message in offline queue (conversation: \(conversationId))")
                OfflineMessageQueue.shared.enqueue(conversationId: conversationId, text: text, displayText: displayText, attachments: attachments, automated: automated)
                // Mark the corresponding chat message as offline-pending so the UI
                // can show a visual indicator. Find the last user message with this
                // text — it is the one just appended by sendMessage().
                let matchText = displayText ?? text
                if let idx = messageManager.messages.indices.reversed().first(where: { messageManager.messages[$0].role == .user && messageManager.messages[$0].text == matchText }) {
                    messageManager.messages[idx].status = .pendingOffline
                }
                // Don't show the error banner — the pending indicator on the bubble
                // communicates the offline state without interrupting the conversation.
                return
            }

            // Always track the failed message for retry support.
            delegate.lastFailedMessageText = text
            delegate.lastFailedMessageDisplayText = displayText
            delegate.lastFailedMessageAttachments = attachments
            delegate.lastFailedMessageAutomated = automated
            delegate.lastFailedMessageBypassSecretCheck = bypassSecretCheck
            // Only update UI error state for the primary send (not a queued
            // retry). A queued retry failing must not clobber the active turn's
            // isSending/isThinking flags or show an error banner over it.
            if queuedMessageId == nil {
                delegate.lastFailedSendError = "Failed to connect to the assistant."
                errorManager.errorText = delegate.lastFailedSendError
            }
            // Remove the queued message ID to prevent stale FIFO entries
            if let queuedMessageId {
                delegate.pendingMessageIds.removeAll { $0 == queuedMessageId }
                // Revert status so the message doesn't appear permanently queued
                if let idx = messageManager.messages.firstIndex(where: { $0.id == queuedMessageId }) {
                    messageManager.messages[idx].status = .sent
                }
            }
            return
        }

        messageManager.isSending = true
        // Only show "Thinking" for the primary send. Queued messages will
        // set isThinking = true when they are dequeued for processing.
        if queuedMessageId == nil {
            messageManager.isThinking = true
        }

        // Make sure we're listening
        if delegate.messageLoopTask == nil {
            delegate.startMessageLoop()
        }

        // Consume pending onboarding context on the first send so it's
        // included in the POST body. Nil it out immediately so subsequent
        // messages do not include the onboarding payload.
        let onboarding = delegate.pendingOnboardingContext
        if onboarding != nil {
            delegate.pendingOnboardingContext = nil
        }

        delegate.eventStreamClient.sendUserMessage(
            content: text,
            conversationId: conversationId,
            attachments: attachments,
            conversationType: nil,
            automated: automated ? true : nil,
            bypassSecretCheck: bypassSecretCheck ? true : nil,
            onboarding: onboarding
        )
    }

    // MARK: - Cancel Pending Message

    /// Cancel the queued user message without clearing `bootstrapCorrelationId`.
    /// Used when archiving a conversation before conversation_info arrives.
    func cancelPendingMessage() {
        guard let delegate else { return }
        delegate.pendingUserMessage = nil
        delegate.pendingUserMessageDisplayText = nil
        delegate.pendingUserAttachments = nil
        delegate.pendingUserMessageAutomated = false
        messageManager.isWorkspaceRefinementInFlight = false
        messageManager.refinementMessagePreview = nil
        messageManager.refinementStreamingText = nil
        messageManager.isThinking = false
        messageManager.isSending = false
    }

    // MARK: - Stop Generating

    func stopGenerating() {
        guard let delegate else { return }
        guard delegate.isAssistantBusy else { return }

        // If the only reason we're "busy" is orphaned incomplete tool calls
        // (daemon already sent messageComplete, clearing isSending and
        // currentAssistantMessageId), complete them locally and return —
        // there is nothing to cancel on the daemon side.
        if !messageManager.isSending && !messageManager.isThinking && delegate.currentAssistantMessageId == nil && delegate.hasIncompleteToolCalls {
            messageManager.batchUpdateMessages { msgs in
                if let lastAssistant = msgs.last(where: { $0.role == .assistant }),
                   let index = msgs.firstIndex(where: { $0.id == lastAssistant.id }) {
                    for j in msgs[index].toolCalls.indices where !msgs[index].toolCalls[j].isComplete {
                        msgs[index].toolCalls[j].isComplete = true
                        msgs[index].toolCalls[j].completedAt = Date()
                    }
                }
            }
            return
        }

        delegate.pendingVoiceMessage = false

        // If we're still bootstrapping (no conversation yet), cancel locally:
        // discard the pending message so it won't be sent when conversation_info
        // arrives, and reset UI state immediately since there's nothing to
        // cancel on the daemon side.
        if delegate.conversationId == nil {
            delegate.pendingUserMessage = nil
            delegate.pendingUserMessageDisplayText = nil
            delegate.pendingUserAttachments = nil
            delegate.pendingUserMessageAutomated = false
            delegate.bootstrapCorrelationId = nil
            messageManager.isWorkspaceRefinementInFlight = false
            messageManager.refinementMessagePreview = nil
            messageManager.refinementStreamingText = nil
            messageManager.isThinking = false
            messageManager.isSending = false
            dispatchPendingSendDirect()
            return
        }

        // If the daemon is not connected, the cancel message cannot reach it
        // and no acknowledgment (generation_cancelled / message_complete) will
        // arrive.  Reset all transient state immediately to avoid a permanently
        // stuck isCancelling flag that would suppress future assistant deltas.
        guard delegate.connectionManager.isConnected else {
            log.warning("Cannot send cancel: daemon not connected")
            resetCancelState()
            dispatchPendingSendDirect()
            return
        }

        let cancelConversationId = delegate.conversationId!
        Task { [weak self] in
            guard let self, self.delegate != nil else { return }
            let success = await self.conversationListClient.cancelGeneration(conversationId: cancelConversationId)
            if !success {
                log.error("Failed to send cancel")
                // Cancel failed to send, so no generationCancelled or
                // messageComplete event will arrive from the daemon. Reset
                // all transient state now to avoid stuck UI.
                self.resetCancelState()
                self.dispatchPendingSendDirect()
            }
        }

        // Flush any buffered streaming text so already-received tokens are
        // visible before we set isCancelling (which suppresses future deltas).
        delegate.flushStreamingBuffer()

        // Set cancelling flag so late-arriving deltas are suppressed.
        // isSending stays true until the daemon acknowledges the cancel
        // (via generation_cancelled or message_complete) to prevent the
        // user from sending a new message before the daemon has stopped.
        delegate.isCancelling = true
        delegate.cancelledDuringRefinement = messageManager.isWorkspaceRefinementInFlight
        messageManager.isWorkspaceRefinementInFlight = false
        messageManager.isThinking = false

        // Mark current assistant message as stopped and complete any in-progress
        // tool calls in a single batch so their chips don't show an endless spinner.
        if let existingId = delegate.currentAssistantMessageId {
            messageManager.batchUpdateMessages { msgs in
                guard let index = msgs.firstIndex(where: { $0.id == existingId }) else { return }
                msgs[index].isStreaming = false
                msgs[index].streamingCodePreview = nil
                msgs[index].streamingCodeToolName = nil
                for j in msgs[index].toolCalls.indices where !msgs[index].toolCalls[j].isComplete {
                    msgs[index].toolCalls[j].isComplete = true
                    msgs[index].toolCalls[j].completedAt = Date()
                }
            }
        }

        // Safety timeout: if the daemon never acknowledges the cancel (e.g. a
        // tool is stuck and blocks the response), force-reset the UI so the
        // user can start a new interaction.
        delegate.cancelTimeoutTask?.cancel()
        delegate.cancelTimeoutTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 5_000_000_000) // 5 seconds
            guard let self, let delegate = self.delegate, !Task.isCancelled else { return }
            guard delegate.isCancelling else { return }
            log.warning("Cancel acknowledgment timed out after 5s — force-resetting UI state")
            self.resetCancelState()
            self.dispatchPendingSendDirect()
        }
    }

    /// Reset all transient state after a cancel failure or disconnected cancel.
    /// Shared by the disconnected, send-failure, and timeout cancel paths.
    private func resetCancelState() {
        guard let delegate else { return }
        messageManager.isWorkspaceRefinementInFlight = false
        messageManager.refinementMessagePreview = nil
        messageManager.refinementStreamingText = nil
        delegate.cancelledDuringRefinement = false
        messageManager.isSending = false
        messageManager.isThinking = false
        delegate.isCancelling = false
        // Mark current assistant message as stopped and reset queued statuses
        // in a single batch to avoid O(n) synchronous Combine pipeline evaluations.
        let assistantId = delegate.currentAssistantMessageId
        messageManager.batchUpdateMessages { msgs in
            if let existingId = assistantId,
               let index = msgs.firstIndex(where: { $0.id == existingId }) {
                msgs[index].isStreaming = false
                msgs[index].streamingCodePreview = nil
                msgs[index].streamingCodeToolName = nil
                for j in msgs[index].toolCalls.indices where !msgs[index].toolCalls[j].isComplete {
                    msgs[index].toolCalls[j].isComplete = true
                    msgs[index].toolCalls[j].completedAt = Date()
                }
            }
            for i in msgs.indices {
                if case .queued = msgs[i].status, msgs[i].role == .user {
                    msgs[i].status = .sent
                } else if msgs[i].role == .user && msgs[i].status == .processing {
                    msgs[i].status = .sent
                }
            }
        }
        delegate.currentAssistantMessageId = nil
        delegate.currentTurnUserText = nil
        delegate.currentAssistantHasText = false
        delegate.discardStreamingBuffer()
        delegate.discardPartialOutputBuffer()
        messageManager.pendingQueuedCount = 0
        delegate.pendingMessageIds = []
        delegate.requestIdToMessageId = [:]
        delegate.activeRequestIdToMessageId = [:]
        delegate.pendingLocalDeletions.removeAll()
    }

    // MARK: - Offline Queue Flush

    /// Drain the persistent offline queue and send all buffered messages in order.
    ///
    /// Called automatically when the daemon reconnects. Only flushes messages whose
    /// conversationId matches this view model's current conversation, so concurrent view models
    /// on different conversations don't interfere with each other's queued messages.
    ///
    /// Messages are removed from persistent storage one at a time, immediately before
    /// each send, so a crash mid-flush leaves unprocessed messages intact rather than
    /// silently dropping them.
    func flushOfflineQueue() {
        guard let delegate else { return }
        let queue = OfflineMessageQueue.shared
        guard !queue.isEmpty else { return }

        guard let currentConversationId = delegate.conversationId else {
            // No conversation yet — defer until conversationId is populated.
            delegate.needsOfflineFlush = true
            return
        }

        // Read the queue contents without clearing. Filter for this conversation only;
        // other conversations' messages stay in the persistent store for their own VMs.
        let mine = queue.allMessages.filter { $0.conversationId == currentConversationId }
        guard !mine.isEmpty else { return }

        log.info("Flushing \(mine.count) offline-queued message(s) for conversation \(currentConversationId)")

        // Update message bubbles: clear pendingOffline status so they show as sent.
        for queued in mine {
            let matchText = queued.displayText ?? queued.text
            if let idx = messageManager.messages.indices.reversed().first(where: {
                messageManager.messages[$0].role == .user
                    && messageManager.messages[$0].text == matchText
                    && messageManager.messages[$0].status == .pendingOffline
            }) {
                messageManager.messages[idx].status = .sent
            }
        }

        // Remove each message from persistent storage and send it. Removal happens
        // before the send attempt so a successful removal + failed send is recoverable
        // via the normal error retry path, rather than duplicating on the next flush.
        for queued in mine {
            queue.remove(id: queued.id)
            sendUserMessage(queued.text, displayText: queued.displayText, attachments: queued.messageAttachments, automated: queued.automated)
        }
    }

    // MARK: - Queue Management

    /// Skip the queue: stop the current generation and immediately send a specific queued message.
    func sendDirectQueuedMessage(messageId: UUID) {
        guard let delegate else { return }
        guard let index = messageManager.messages.firstIndex(where: { $0.id == messageId }),
              case .queued = messageManager.messages[index].status else { return }

        // Save content before stop clears everything
        let text = messageManager.messages[index].text
        let attachments = messageManager.messages[index].attachments
        let skillInvocation = messageManager.messages[index].skillInvocation

        // Remove this message from local state (it will be re-added by sendMessage)
        messageManager.messages.remove(at: index)

        // If the assistant is not busy (or only busy due to orphaned tool
        // calls), complete any orphaned tool calls and dispatch immediately
        // instead of going through the cancel flow.
        if !messageManager.isSending && !messageManager.isThinking && delegate.currentAssistantMessageId == nil {
            // Complete any orphaned incomplete tool calls first
            if delegate.hasIncompleteToolCalls,
               let lastAssistant = messageManager.messages.last(where: { $0.role == .assistant }),
               let idx = messageManager.messages.firstIndex(where: { $0.id == lastAssistant.id }) {
                for j in messageManager.messages[idx].toolCalls.indices where !messageManager.messages[idx].toolCalls[j].isComplete {
                    messageManager.messages[idx].toolCalls[j].isComplete = true
                    messageManager.messages[idx].toolCalls[j].completedAt = Date()
                }
            }
            messageManager.inputText = text
            attachmentManager.pendingAttachments = attachments
            messageManager.pendingSkillInvocation = skillInvocation
            sendMessage()
            return
        }

        // Store for dispatch after cancellation completes.
        // Must be set BEFORE stopGenerating() because synchronous cancel paths
        // (bootstrap, disconnected, send-failure) dispatch immediately.
        delegate.pendingSendDirectText = text
        delegate.pendingSendDirectAttachments = attachments
        delegate.pendingSendDirectSkillInvocation = skillInvocation

        // Stop current generation — this clears all queued messages on the daemon
        stopGenerating()
    }

    /// If a send-direct is pending, populate the composer and fire sendMessage.
    /// Called from all cancel-completion paths (generationCancelled, timeout, disconnected, etc.).
    func dispatchPendingSendDirect() {
        guard let delegate else { return }
        guard let directText = delegate.pendingSendDirectText else { return }
        let directAttachments = delegate.pendingSendDirectAttachments ?? []
        let directSkillInvocation = delegate.pendingSendDirectSkillInvocation
        delegate.pendingSendDirectText = nil
        delegate.pendingSendDirectAttachments = nil
        delegate.pendingSendDirectSkillInvocation = nil
        messageManager.inputText = directText
        attachmentManager.pendingAttachments = directAttachments
        messageManager.pendingSkillInvocation = directSkillInvocation
        sendMessage()
    }

    // MARK: - Retry & Send Anyway

    /// Retry sending the last user message that failed (e.g. due to daemon disconnection).
    func retryLastMessage() {
        guard let delegate else { return }
        guard let text = delegate.lastFailedMessageText else { return }
        let displayText = delegate.lastFailedMessageDisplayText
        let attachments = delegate.lastFailedMessageAttachments
        let automated = delegate.lastFailedMessageAutomated
        let bypassSecretCheck = delegate.lastFailedMessageBypassSecretCheck

        // Clear failed message state and error
        delegate.lastFailedMessageText = nil
        delegate.lastFailedMessageDisplayText = nil
        delegate.lastFailedMessageAttachments = nil
        delegate.lastFailedMessageAutomated = false
        delegate.lastFailedMessageBypassSecretCheck = false
        delegate.lastFailedSendError = nil
        errorManager.errorText = nil
        errorManager.connectionDiagnosticHint = nil
        errorManager.isConversationErrorDisplayedInline = false

        if delegate.conversationId == nil {
            delegate.pendingUserMessageDisplayText = displayText
            delegate.pendingUserMessageAutomated = automated
            bootstrapConversation(userMessage: text, attachments: attachments)
        } else {
            // When retrying while another turn is in progress, the retried
            // message will be queued by the daemon. Track it in
            // pendingMessageIds so subsequent messageQueued/messageDequeued
            // events can update the user message's status correctly.
            var queuedMessageId: UUID?
            if messageManager.isSending {
                // Find the user message that corresponds to the failed text
                // (it was already appended to messages[] during the original
                // sendMessage() call). Use the last user message with matching
                // text as the queue entry.
                let matchText = displayText ?? text
                if let idx = messageManager.messages.lastIndex(where: { $0.role == .user && $0.text == matchText }) {
                    delegate.pendingMessageIds.append(messageManager.messages[idx].id)
                    queuedMessageId = messageManager.messages[idx].id
                    messageManager.messages[idx].status = .queued(position: 0)
                }
            }
            sendUserMessage(text, displayText: displayText, attachments: attachments, queuedMessageId: queuedMessageId, automated: automated, bypassSecretCheck: bypassSecretCheck)
        }
    }

    /// Send a message that was blocked by the secret-ingress check, bypassing the check.
    func sendAnyway() {
        guard let delegate else { return }
        guard let text = delegate.secretBlockedMessageText, let _ = delegate.conversationId else { return }

        guard delegate.connectionManager.isConnected else {
            errorManager.errorText = "Cannot connect to assistant. Please ensure it's running."
            return
        }

        // Snapshot and clear stashed context
        let attachments = delegate.secretBlockedAttachments

        delegate.secretBlockedMessageText = nil
        delegate.secretBlockedAttachments = nil
        delegate.secretBlockedActiveSurfaceId = nil
        delegate.secretBlockedCurrentPage = nil
        errorManager.errorText = nil

        sendUserMessage(text, attachments: attachments, bypassSecretCheck: true)
    }
}
