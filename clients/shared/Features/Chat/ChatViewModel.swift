import Foundation
import os
import UniformTypeIdentifiers
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#else
#error("Unsupported platform")
#endif

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ChatViewModel")

@MainActor
public final class ChatViewModel: ObservableObject {
    @Published public var messages: [ChatMessage] = []
    @Published public var inputText: String = ""
    @Published public var isThinking: Bool = false
    @Published public var isSending: Bool = false
    @Published public var errorText: String?
    @Published public var sessionError: SessionError?
    @Published public var pendingQueuedCount: Int = 0
    @Published public var suggestion: String?
    @Published public var pendingAttachments: [ChatAttachment] = []
    @Published public var isRecording: Bool = false
    @Published public var isWorkspaceRefinementInFlight: Bool = false
    @Published public var refinementMessagePreview: String?   // user's sent text
    @Published public var refinementStreamingText: String?     // AI response as it streams
    /// Tracks whether a cancel was initiated during a workspace refinement.
    /// Used by `messageComplete` to correctly suppress refinement side-effects
    /// even though `isWorkspaceRefinementInFlight` is cleared immediately for UI.
    var cancelledDuringRefinement: Bool = false
    /// Text buffered during a workspace refinement (normally suppressed from chat).
    /// Surfaced to the user if the refinement completes without a surface update.
    var refinementTextBuffer: String = ""
    var refinementReceivedSurfaceUpdate: Bool = false
    /// When non-nil, displays a toast in the workspace with the AI's response
    /// after a refinement that produced no surface update.
    @Published public var refinementFailureText: String?
    var refinementFailureDismissTask: Task<Void, Never>?
    /// Number of undo steps available for the active workspace surface.
    @Published public var surfaceUndoCount: Int = 0
    @Published public var pendingSkillInvocation: SkillInvocationData?
    @Published public var isWatchSessionActive: Bool = false

    /// Maximum file size per attachment (20 MB).
    static let maxFileSize = 20 * 1024 * 1024
    /// Maximum image size before compression (4 MB - leaves headroom for base64 encoding).
    /// Anthropic has a 5MB limit per image; base64 encoding adds ~33% overhead.
    static let maxImageSize = 4 * 1024 * 1024
    /// Maximum number of attachments per message.
    static let maxAttachments = 5

    let daemonClient: DaemonClient
    public var sessionId: String?
    var pendingUserMessage: String?
    /// Optional callback for sending notifications when tool-use messages complete
    public var onToolCallsComplete: ((_ toolCalls: [ToolCallData]) -> Void)?
    /// Whether the current assistant response was triggered by a voice message.
    public var pendingVoiceMessage: Bool = false
    /// Called when a voice-triggered assistant response completes, with the response text.
    public var onVoiceResponseComplete: ((String) -> Void)?
    var pendingUserAttachments: [IPCAttachment]?
    /// Stores the last user message that failed to send, enabling retry.
    private(set) var lastFailedMessageText: String?
    private(set) var lastFailedMessageAttachments: [IPCAttachment]?
    /// Set only when a send operation (bootstrapSession or sendUserMessage) fails.
    /// Used by `isRetryableError` to ensure the retry button only appears for
    /// actual send failures, not for unrelated errors (attachment validation,
    /// confirmation response failures, regenerate errors, etc.).
    private(set) var lastFailedSendError: String?
    /// Nonce sent with `session_create` and echoed back in `session_info`.
    /// Used to ensure this ChatViewModel only claims its own session.
    var bootstrapCorrelationId: String?
    /// Whether this view model is currently bootstrapping a new session
    /// (session_create sent, awaiting session_info). Used by ThreadManager
    /// to decide whether it's safe to release the VM on archive.
    public var isBootstrapping: Bool { bootstrapCorrelationId != nil }
    private var messageLoopTask: Task<Void, Never>?
    /// Monotonically increasing ID used to distinguish successive message-loop
    /// tasks so that a cancelled loop's cleanup doesn't clear a newer replacement.
    private var messageLoopGeneration: UInt64 = 0
    var currentAssistantMessageId: UUID?
    /// Tracks whether the current assistant message has received any text content.
    /// Used to determine `arrivedBeforeText` for each tool call in the message.
    var currentAssistantHasText: Bool = false
    /// Tracks whether the last content block was a tool call, so the next text
    /// delta starts a new segment instead of appending to the previous one.
    var lastContentWasToolCall: Bool = false
    /// When true, incoming deltas are suppressed until the daemon acknowledges
    /// the cancellation (via `generation_cancelled` or `message_complete`).
    // Public (rather than private) so tests can simulate the
    // daemon-acknowledged cancellation state directly.
    public var isCancelling: Bool = false
    /// Maps daemon requestId to the user message UUID in the messages array.
    var requestIdToMessageId: [String: UUID] = [:]
    /// FIFO queue of user message UUIDs awaiting requestId assignment from the daemon.
    var pendingMessageIds: [UUID] = []
    /// Tracks the current in-flight suggestion request so stale responses are ignored.
    var pendingSuggestionRequestId: String?
    /// Safety timer that force-resets the UI if the daemon never acknowledges
    /// a cancel request (e.g. a stuck tool blocks the generation_cancelled event).
    var cancelTimeoutTask: Task<Void, Never>?

    /// Timestamp of the most recent `toolUseStart` event received by this view model.
    /// Used by ThreadManager to route `confirmationRequest` messages to the correct
    /// ChatViewModel when multiple threads have active sessions.
    public var lastToolUseReceivedAt: Date?

    /// Called when an inline confirmation is responded to, so the floating panel can be dismissed.
    /// Parameters: (requestId, decision)
    public var onInlineConfirmationResponse: ((String, String) -> Void)?

    /// Called to determine whether this ChatViewModel should accept a `confirmationRequest`.
    /// Set by ThreadManager to coordinate routing when multiple ChatViewModels are active.
    public var shouldAcceptConfirmation: (() -> Bool)?

    /// Called when the daemon sends a `watch_started` message to begin a watch session.
    /// The closure receives the WatchStartedMessage and the DaemonClient so the macOS
    /// layer can create and start a WatchSession.
    public var onWatchStarted: ((WatchStartedMessage, DaemonClient) -> Void)?

    /// Called when the daemon sends a `watch_complete_request` to stop the active watch session.
    public var onWatchCompleteRequest: ((WatchCompleteRequestMessage) -> Void)?

    /// Called when the user taps the stop button on the watch progress UI.
    /// The macOS layer should cancel the WatchSession and send a cancel to the daemon.
    public var onStopWatch: (() -> Void)?

    /// Called when the daemon assigns a session ID to this chat (via session_info).
    /// Used by ThreadManager to backfill ThreadModel.sessionId for new threads.
    public var onSessionCreated: ((String) -> Void)?

    /// Called once when the first user message is sent, with the message text.
    /// Used by ThreadManager to auto-title the thread.
    public var onFirstUserMessage: ((String) -> Void)?

    /// Whether this view model has had its history loaded from the daemon.
    public var isHistoryLoaded: Bool = false

    /// Surface the user is currently viewing in workspace mode.
    /// Set by MainWindowView when the dynamic workspace is expanded.
    public var activeSurfaceId: String? {
        didSet {
            if oldValue != activeSurfaceId {
                surfaceUndoCount = 0
                currentPage = nil
            }
        }
    }

    /// The page currently displayed in the workspace WebView (e.g. "settings.html").
    /// Set via the onPageChanged callback when the user navigates within a multi-page app.
    public var currentPage: String?

    public init(daemonClient: DaemonClient, onToolCallsComplete: ((_ toolCalls: [ToolCallData]) -> Void)? = nil) {
        self.daemonClient = daemonClient
        self.onToolCallsComplete = onToolCallsComplete
    }

    // MARK: - Sending

    public func sendMessage() {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        let hasAttachments = !pendingAttachments.isEmpty
        let hasSkillInvocation = pendingSkillInvocation != nil
        guard !text.isEmpty || hasAttachments || hasSkillInvocation else { return }

        // Fire auto-title callback on the first user message
        if !text.isEmpty, let callback = onFirstUserMessage {
            onFirstUserMessage = nil
            callback(text)
        }

        // Block rapid-fire only when bootstrapping (no session yet)
        if isSending && sessionId == nil {
            pendingSkillInvocation = nil
            return
        }

        // Snapshot and clear pending attachments
        let attachments = pendingAttachments
        pendingAttachments = []

        let isWorkspaceRefinement = activeSurfaceId != nil

        let willBeQueued = isSending && sessionId != nil
        var queuedMessageId: UUID?
        if !isWorkspaceRefinement {
            let status: ChatMessageStatus = willBeQueued ? .queued(position: 0) : .sent
            let userMessage = ChatMessage(role: .user, text: text, status: status, skillInvocation: pendingSkillInvocation, attachments: attachments)
            messages.append(userMessage)
            if willBeQueued {
                pendingMessageIds.append(userMessage.id)
                queuedMessageId = userMessage.id
            }
        } else {
            isWorkspaceRefinementInFlight = true
            refinementMessagePreview = text
            refinementStreamingText = nil
            refinementTextBuffer = ""
            refinementReceivedSurfaceUpdate = false
            refinementFailureText = nil
            refinementFailureDismissTask?.cancel()
        }
        pendingSkillInvocation = nil
        inputText = ""
        suggestion = nil
        pendingSuggestionRequestId = nil
        errorText = nil
        sessionError = nil
        lastFailedMessageText = nil
        lastFailedMessageAttachments = nil
        lastFailedSendError = nil

        let ipcAttachments: [IPCAttachment]? = attachments.isEmpty ? nil : attachments.map {
            IPCAttachment(filename: $0.filename, mimeType: $0.mimeType, data: $0.data, extractedText: nil)
        }

        if sessionId == nil {
            // First message: need to bootstrap session
            bootstrapSession(userMessage: text, attachments: ipcAttachments)
        } else {
            // Subsequent messages: send directly (daemon queues if busy)
            sendUserMessage(text, attachments: ipcAttachments, queuedMessageId: queuedMessageId)
        }
    }

    private func bootstrapSession(userMessage: String, attachments: [IPCAttachment]?) {
        isSending = true
        isThinking = true
        pendingUserMessage = userMessage
        pendingUserAttachments = attachments

        // Generate a unique correlation ID so this ChatViewModel only claims
        // the session_info response that belongs to its own session_create request.
        let correlationId = UUID().uuidString
        self.bootstrapCorrelationId = correlationId

        Task { @MainActor in
            // Ensure daemon connection
            if !daemonClient.isConnected {
                do {
                    try await daemonClient.connect()
                } catch {
                    log.error("Failed to connect to daemon: \(error.localizedDescription)")
                    self.isThinking = false
                    self.isSending = false
                    self.bootstrapCorrelationId = nil
                    self.lastFailedMessageText = self.pendingUserMessage
                    self.lastFailedMessageAttachments = self.pendingUserAttachments
                    self.lastFailedSendError = "Cannot connect to daemon. Please ensure it's running."
                    self.pendingUserMessage = nil
                    self.pendingUserAttachments = nil
                    self.errorText = self.lastFailedSendError
                    return
                }
            }

            // Subscribe to daemon stream
            self.startMessageLoop()

            // Send session_create with correlation ID
            do {
                try daemonClient.send(SessionCreateMessage(title: nil, correlationId: correlationId))
            } catch {
                log.error("Failed to send session_create: \(error.localizedDescription)")
                self.isThinking = false
                self.isSending = false
                self.bootstrapCorrelationId = nil
                self.lastFailedMessageText = self.pendingUserMessage
                self.lastFailedMessageAttachments = self.pendingUserAttachments
                self.lastFailedSendError = "Failed to create session."
                self.pendingUserMessage = nil
                self.pendingUserAttachments = nil
                self.errorText = self.lastFailedSendError
            }
        }
    }

    private func sendUserMessage(_ text: String, attachments: [IPCAttachment]? = nil, queuedMessageId: UUID? = nil) {
        guard let sessionId else { return }

        // Check connectivity before entering sending state so the UI
        // doesn't get stuck with isSending/isThinking = true when the
        // daemon has disconnected between turns.
        guard daemonClient.isConnected else {
            log.error("Cannot send user_message: daemon not connected")
            lastFailedMessageText = text
            lastFailedMessageAttachments = attachments
            lastFailedSendError = "Cannot connect to daemon. Please ensure it's running."
            errorText = lastFailedSendError
            // Remove the queued message ID to prevent stale FIFO entries
            if let queuedMessageId {
                pendingMessageIds.removeAll { $0 == queuedMessageId }
                // Revert status so the message doesn't appear permanently queued
                if let idx = messages.firstIndex(where: { $0.id == queuedMessageId }) {
                    messages[idx].status = .sent
                }
            }
            return
        }

        isSending = true
        isThinking = true

        // Make sure we're listening
        if messageLoopTask == nil {
            startMessageLoop()
        }

        do {
            try daemonClient.send(UserMessageMessage(
                sessionId: sessionId,
                content: text,
                attachments: attachments,
                activeSurfaceId: activeSurfaceId,
                currentPage: activeSurfaceId != nil ? currentPage : nil
            ))
        } catch {
            log.error("Failed to send user_message: \(error.localizedDescription)")
            // Only update UI error state for the primary send (not a queued
            // retry). A queued retry failing must not clobber the active turn's
            // isSending/isThinking flags or show an error banner over it.
            if queuedMessageId == nil {
                isSending = false
                isThinking = false
                lastFailedMessageText = text
                lastFailedMessageAttachments = attachments
                lastFailedSendError = "Failed to send message."
                errorText = lastFailedSendError
            }
            // Remove the queued message ID to prevent stale FIFO entries
            if let queuedMessageId {
                pendingMessageIds.removeAll { $0 == queuedMessageId }
                // Revert status so the message doesn't appear permanently queued
                if let idx = messages.firstIndex(where: { $0.id == queuedMessageId }) {
                    messages[idx].status = .sent
                }
            }
        }
    }

    private func startMessageLoop() {
        messageLoopTask?.cancel()
        let messageStream = daemonClient.subscribe()

        messageLoopGeneration &+= 1
        let generation = messageLoopGeneration

        messageLoopTask = Task { @MainActor [weak self] in
            for await message in messageStream {
                guard let self, !Task.isCancelled else { break }
                self.handleServerMessage(message)
            }
            // Stream ended (e.g. daemon disconnected) — clear the task reference
            // so the next sendUserMessage() call will re-subscribe.
            // Only nil out if this task is still the current one; a cancelled
            // loop that finishes after its replacement must not wipe the new
            // task reference, which would cause duplicate subscriptions.
            if self?.messageLoopGeneration == generation {
                self?.messageLoopTask = nil
            }
        }
    }

    // MARK: - Actions

    public func sendSurfaceAction(surfaceId: String, actionId: String, data: [String: AnyCodable]? = nil) {
        guard let sessionId = sessionId else { return }
        let msg = UiSurfaceActionMessage(
            sessionId: sessionId,
            surfaceId: surfaceId,
            actionId: actionId,
            data: data
        )
        try? daemonClient.send(msg)
    }

    /// Cancel the queued user message without clearing `bootstrapCorrelationId`.
    /// Used when archiving a thread before session_info arrives: we want to
    /// discard the pending message (so it isn't sent once the session is claimed)
    /// but preserve the correlation ID so the VM only claims its own session.
    public func cancelPendingMessage() {
        pendingUserMessage = nil
        pendingUserAttachments = nil
        isWorkspaceRefinementInFlight = false
        refinementMessagePreview = nil
        refinementStreamingText = nil
        isThinking = false
        isSending = false
    }

    public func stopGenerating() {
        guard isSending else { return }

        pendingVoiceMessage = false

        // If we're still bootstrapping (no session yet), cancel locally:
        // discard the pending message so it won't be sent when session_info
        // arrives, and reset UI state immediately since there's nothing to
        // cancel on the daemon side.
        if sessionId == nil {
            pendingUserMessage = nil
            pendingUserAttachments = nil
            bootstrapCorrelationId = nil
            isWorkspaceRefinementInFlight = false
            refinementMessagePreview = nil
            refinementStreamingText = nil
            isThinking = false
            isSending = false
            return
        }

        // If the daemon is not connected, the cancel message cannot reach it
        // and no acknowledgment (generation_cancelled / message_complete) will
        // arrive.  Reset all transient state immediately to avoid a permanently
        // stuck isCancelling flag that would suppress future assistant deltas.
        guard daemonClient.isConnected else {
            log.warning("Cannot send cancel: daemon not connected")
            isWorkspaceRefinementInFlight = false
            refinementMessagePreview = nil
            refinementStreamingText = nil
            cancelledDuringRefinement = false
            isSending = false
            isThinking = false
            isCancelling = false
            if let existingId = currentAssistantMessageId,
               let index = messages.firstIndex(where: { $0.id == existingId }) {
                messages[index].isStreaming = false
                messages[index].streamingCodePreview = nil
                messages[index].streamingCodeToolName = nil
                for j in messages[index].toolCalls.indices where !messages[index].toolCalls[j].isComplete {
                    messages[index].toolCalls[j].isComplete = true
                    messages[index].toolCalls[j].completedAt = Date()
                }
            }
            currentAssistantMessageId = nil
            currentAssistantHasText = false
            lastContentWasToolCall = false
            pendingQueuedCount = 0
            pendingMessageIds = []
            requestIdToMessageId = [:]
            for i in messages.indices {
                if case .queued = messages[i].status, messages[i].role == .user {
                    messages[i].status = .sent
                } else if messages[i].role == .user && messages[i].status == .processing {
                    messages[i].status = .sent
                }
            }
            return
        }

        do {
            try daemonClient.send(CancelMessage(sessionId: sessionId!))
        } catch {
            log.error("Failed to send cancel: \(error.localizedDescription)")
            // Cancel failed to send, so no generationCancelled or
            // messageComplete event will arrive from the daemon. Reset
            // all transient state now to avoid stuck UI.
            isWorkspaceRefinementInFlight = false
            refinementMessagePreview = nil
            refinementStreamingText = nil
            cancelledDuringRefinement = false
            isSending = false
            isThinking = false
            isCancelling = false
            // Mark current assistant message as stopped
            if let existingId = currentAssistantMessageId,
               let index = messages.firstIndex(where: { $0.id == existingId }) {
                messages[index].isStreaming = false
                messages[index].streamingCodePreview = nil
                messages[index].streamingCodeToolName = nil
                for j in messages[index].toolCalls.indices where !messages[index].toolCalls[j].isComplete {
                    messages[index].toolCalls[j].isComplete = true
                    messages[index].toolCalls[j].completedAt = Date()
                }
            }
            currentAssistantMessageId = nil
            currentAssistantHasText = false
            lastContentWasToolCall = false
            pendingQueuedCount = 0
            pendingMessageIds = []
            requestIdToMessageId = [:]
            // Reset processing/queued messages to sent
            for i in messages.indices {
                if case .queued = messages[i].status, messages[i].role == .user {
                    messages[i].status = .sent
                } else if messages[i].role == .user && messages[i].status == .processing {
                    messages[i].status = .sent
                }
            }
            return
        }

        // Set cancelling flag so late-arriving deltas are suppressed.
        // isSending stays true until the daemon acknowledges the cancel
        // (via generation_cancelled or message_complete) to prevent the
        // user from sending a new message before the daemon has stopped.
        isCancelling = true
        cancelledDuringRefinement = isWorkspaceRefinementInFlight
        isWorkspaceRefinementInFlight = false
        isThinking = false

        // Mark current assistant message as stopped and complete any in-progress tool calls
        // so their chips don't show an endless spinner.
        if let existingId = currentAssistantMessageId,
           let index = messages.firstIndex(where: { $0.id == existingId }) {
            messages[index].isStreaming = false
            messages[index].streamingCodePreview = nil
            messages[index].streamingCodeToolName = nil
            for j in messages[index].toolCalls.indices where !messages[index].toolCalls[j].isComplete {
                messages[index].toolCalls[j].isComplete = true
                messages[index].toolCalls[j].completedAt = Date()
            }
        }

        // Safety timeout: if the daemon never acknowledges the cancel (e.g. a
        // tool is stuck and blocks the response), force-reset the UI so the
        // user can start a new interaction.
        cancelTimeoutTask?.cancel()
        cancelTimeoutTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 5_000_000_000) // 5 seconds
            guard let self, !Task.isCancelled else { return }
            guard self.isCancelling else { return }
            log.warning("Cancel acknowledgment timed out after 5s — force-resetting UI state")
            self.isWorkspaceRefinementInFlight = false
            self.refinementMessagePreview = nil
            self.refinementStreamingText = nil
            self.cancelledDuringRefinement = false
            self.isCancelling = false
            self.isSending = false
            self.currentAssistantMessageId = nil
            self.currentAssistantHasText = false
            self.lastContentWasToolCall = false
            self.pendingQueuedCount = 0
            self.pendingMessageIds = []
            self.requestIdToMessageId = [:]
            // Reset queued/processing messages to sent (matches other cancel-failure paths)
            for i in self.messages.indices {
                if case .queued = self.messages[i].status, self.messages[i].role == .user {
                    self.messages[i].status = .sent
                } else if self.messages[i].role == .user && self.messages[i].status == .processing {
                    self.messages[i].status = .sent
                }
            }
        }
    }

    /// Regenerate the last assistant response. Removes the old reply from
    /// all memory systems (including Qdrant) and re-runs the agent loop.
    public func regenerateLastMessage() {
        guard let sessionId, !isSending else { return }
        guard daemonClient.isConnected else {
            errorText = "Cannot connect to daemon. Please ensure it's running."
            return
        }

        errorText = nil
        sessionError = nil
        isSending = true
        isThinking = true
        suggestion = nil
        pendingSuggestionRequestId = nil

        // Make sure we're listening for the response
        if messageLoopTask == nil {
            startMessageLoop()
        }

        do {
            try daemonClient.sendRegenerate(sessionId: sessionId)
        } catch {
            log.error("Failed to send regenerate: \(error.localizedDescription)")
            isSending = false
            isThinking = false
            errorText = "Failed to regenerate message."
        }
    }

    /// Revert the last refinement on the active workspace surface.
    public func undoSurfaceRefinement() {
        guard let sessionId, let surfaceId = activeSurfaceId else { return }
        guard surfaceUndoCount > 0 else { return }
        do {
            try daemonClient.sendSurfaceUndo(sessionId: sessionId, surfaceId: surfaceId)
        } catch {
            log.error("Failed to send surface undo: \(error.localizedDescription)")
        }
    }

    /// Stop the active watch session and notify the macOS layer.
    public func stopWatchSession() {
        guard isWatchSessionActive else { return }
        isWatchSessionActive = false
        onStopWatch?()
    }

    public func dismissError() {
        sessionError = nil
        errorText = nil
        lastFailedMessageText = nil
        lastFailedMessageAttachments = nil
        lastFailedSendError = nil
    }

    /// Dismiss the typed session error state. Clears both the typed error
    /// and any corresponding `errorText` so the UI can return to normal.
    public func dismissSessionError() {
        sessionError = nil
        errorText = nil
    }

    /// Copy session error details to the clipboard for debugging.
    public func copySessionErrorDebugDetails() {
        guard let error = sessionError else { return }
        var details = """
        Error: \(error.message)
        Category: \(error.category)
        Session: \(error.sessionId)
        Retryable: \(error.isRetryable)
        """
        if let debugDetails = error.debugDetails {
            details += "\n\nDebug Details:\n\(debugDetails)"
        }
        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(details, forType: .string)
        #elseif os(iOS)
        UIPasteboard.general.string = details
        #endif
    }

    /// Retry the last message after a session error, if the error is retryable.
    public func retryAfterSessionError() {
        guard let error = sessionError, error.isRetryable else { return }
        guard sessionId != nil else { return }
        // Reset sending state that may still be set if the session error arrived
        // while queued messages were pending (pendingQueuedCount > 0).
        // Without this, regenerateLastMessage() silently bails at its
        // `!isSending` guard, leaving the UI stuck with no error and no retry.
        isSending = false
        pendingQueuedCount = 0
        pendingMessageIds = []
        requestIdToMessageId = [:]
        for i in messages.indices {
            if case .queued = messages[i].status, messages[i].role == .user {
                messages[i].status = .sent
            }
        }
        dismissSessionError()
        regenerateLastMessage()
    }

    /// Whether the current error has a failed user message that can be retried.
    /// Only true when `lastFailedSendError` is set, which restricts the retry
    /// button to actual send failures and prevents unrelated errors (attachment
    /// validation, confirmation response failures, regenerate errors) from
    /// offering to resend a stale cached message.
    public var isRetryableError: Bool {
        lastFailedMessageText != nil && lastFailedSendError != nil
    }

    /// Retry sending the last user message that failed (e.g. due to daemon disconnection).
    public func retryLastMessage() {
        guard let text = lastFailedMessageText else { return }
        let attachments = lastFailedMessageAttachments

        // Clear failed message state and error
        lastFailedMessageText = nil
        lastFailedMessageAttachments = nil
        lastFailedSendError = nil
        errorText = nil

        if sessionId == nil {
            bootstrapSession(userMessage: text, attachments: attachments)
        } else {
            // When retrying while another turn is in progress, the retried
            // message will be queued by the daemon. Track it in
            // pendingMessageIds so subsequent messageQueued/messageDequeued
            // events can update the user message's status correctly.
            var queuedMessageId: UUID?
            if isSending {
                // Find the user message that corresponds to the failed text
                // (it was already appended to messages[] during the original
                // sendMessage() call). Use the last user message with matching
                // text as the queue entry.
                if let idx = messages.lastIndex(where: { $0.role == .user && $0.text == text }) {
                    pendingMessageIds.append(messages[idx].id)
                    queuedMessageId = messages[idx].id
                    messages[idx].status = .queued(position: 0)
                }
            }
            sendUserMessage(text, attachments: attachments, queuedMessageId: queuedMessageId)
        }
    }

    /// Respond to a tool confirmation request displayed inline in the chat.
    public func respondToConfirmation(requestId: String, decision: String) {
        // DaemonClient.send silently returns when connection is nil (it does
        // not throw), so we must check connectivity explicitly before calling
        // sendConfirmationResponse. Without this guard the UI would show the
        // decision as finalized even though the daemon never received it.
        guard daemonClient.isConnected else {
            errorText = "Failed to send confirmation response."
            return
        }
        // Send the response to the daemon first, then update UI state only on success.
        // This prevents the UI from showing a finalized decision when the IPC
        // message was never delivered (e.g. daemon disconnected).
        do {
            try daemonClient.sendConfirmationResponse(requestId: requestId, decision: decision)
        } catch {
            log.error("Failed to send confirmation response: \(error.localizedDescription)")
            errorText = "Failed to send confirmation response."
            return
        }
        // IPC send succeeded — update the message state
        if let index = messages.firstIndex(where: { $0.confirmation?.requestId == requestId }) {
            messages[index].confirmation?.state = decision == "allow" ? .approved : .denied
        }
        // Dismiss the corresponding floating panel / native notification if one exists
        onInlineConfirmationResponse?(requestId, decision)
    }

    /// Update the inline confirmation message state without sending a response to the daemon.
    /// Used when the floating panel handles the response.
    public func updateConfirmationState(requestId: String, decision: String) {
        if let index = messages.firstIndex(where: { $0.confirmation?.requestId == requestId }) {
            switch decision {
            case "allow":
                messages[index].confirmation?.state = .approved
            case "deny":
                messages[index].confirmation?.state = .denied
            default:
                break
            }
        }
    }

    /// Send an add_trust_rule message to persist a trust rule.
    /// Returns `true` if the IPC send succeeded, `false` otherwise.
    public func addTrustRule(toolName: String, pattern: String, scope: String, decision: String) -> Bool {
        guard daemonClient.isConnected else {
            log.warning("Cannot send add_trust_rule: daemon not connected")
            return false
        }
        do {
            try daemonClient.sendAddTrustRule(
                toolName: toolName,
                pattern: pattern,
                scope: scope,
                decision: decision
            )
            return true
        } catch {
            log.error("Failed to send add_trust_rule: \(error.localizedDescription)")
            return false
        }
    }

    /// Parse string-encoded content order entries ("text:0", "tool:1", "surface:0")
    /// into ContentBlockRef values.
    private static func parseContentOrder(_ strings: [String]) -> [ContentBlockRef] {
        strings.compactMap { str in
            let parts = str.split(separator: ":", maxSplits: 1)
            guard parts.count == 2, let idx = Int(parts[1]) else { return nil }
            switch parts[0] {
            case "text": return .text(idx)
            case "tool": return .toolCall(idx)
            case "surface": return .surface(idx)
            default: return nil
            }
        }
    }

    /// Ask the daemon for a follow-up suggestion for the current session.
    func fetchSuggestion() {
        guard let sessionId, daemonClient.isConnected else { return }

        let requestId = UUID().uuidString
        pendingSuggestionRequestId = requestId

        do {
            try daemonClient.send(SuggestionRequestMessage(
                sessionId: sessionId,
                requestId: requestId
            ))
        } catch {
            log.error("Failed to send suggestion_request: \(error.localizedDescription)")
            pendingSuggestionRequestId = nil
        }
    }

    /// Accept the current suggestion, appending the ghost suffix to input.
    public func acceptSuggestion() {
        guard let suggestion else { return }
        if suggestion.hasPrefix(inputText) {
            inputText = suggestion
        } else if inputText.isEmpty {
            inputText = suggestion
        }
        self.suggestion = nil
    }

    /// Populate messages from history data returned by the daemon.
    /// If the user hasn't sent any messages yet, replaces messages entirely.
    /// If the user already sent messages (late history_response), prepends
    /// history before the existing messages so the user sees full context.
    public func populateFromHistory(_ historyMessages: [HistoryResponseMessage.HistoryMessageItem]) {
        var chatMessages: [ChatMessage] = []
        for item in historyMessages {
            let role: ChatRole = item.role == "assistant" ? .assistant : .user
            var toolCalls: [ToolCallData] = []
            let toolsBeforeText = item.toolCallsBeforeText ?? true
            if let historyToolCalls = item.toolCalls {
                toolCalls = historyToolCalls.map { tc in
                    ToolCallData(
                        toolName: toolDisplayName(tc.name),
                        inputSummary: summarizeToolInput(tc.input),
                        result: tc.result,
                        isError: tc.isError ?? false,
                        isComplete: true,
                        arrivedBeforeText: toolsBeforeText,
                        imageData: tc.imageData
                    )
                }
            }
            let attachments: [ChatAttachment] = mapIPCAttachments(item.attachments ?? [])

            // Map surfaces from history to inlineSurfaces
            var inlineSurfaces: [InlineSurfaceData] = []
            if let historySurfaces = item.surfaces {
                for surf in historySurfaces {
                    // Use sessionId from the view model (assumes history is for current session)
                    if let sessionId = self.sessionId,
                       let surface = Surface.from(surf, sessionId: sessionId) {
                        let inlineSurface = InlineSurfaceData(
                            id: surface.id,
                            surfaceType: surface.type,
                            title: surface.title,
                            data: surface.data,
                            actions: surface.actions,
                            surfaceMessage: nil  // No IPC message for history surfaces
                        )
                        inlineSurfaces.append(inlineSurface)
                    }
                }
            }

            // Log surface parsing for debugging widget restoration
            if !inlineSurfaces.isEmpty {
                log.info("Mapped \(inlineSurfaces.count) surfaces from history: \(inlineSurfaces.map { $0.id })")
            } else if let historySurfaces = item.surfaces, !historySurfaces.isEmpty {
                log.warning("Failed to parse \(historySurfaces.count) surfaces from history")
            }

            // Skip empty messages (internal tool-result-only turns already filtered by daemon)
            if item.text.isEmpty && toolCalls.isEmpty && attachments.isEmpty && inlineSurfaces.isEmpty { continue }
            let timestamp = Date(timeIntervalSince1970: TimeInterval(item.timestamp) / 1000.0)

            // Use the database message ID if available (for matching surfaces)
            var chatMsg: ChatMessage
            if let dbId = item.id, let uuid = UUID(uuidString: dbId) {
                chatMsg = ChatMessage(
                    id: uuid,
                    role: role,
                    text: item.text,
                    timestamp: timestamp,
                    attachments: attachments,
                    toolCalls: toolCalls
                )
            } else {
                chatMsg = ChatMessage(
                    role: role,
                    text: item.text,
                    timestamp: timestamp,
                    attachments: attachments,
                    toolCalls: toolCalls
                )
            }

            // Populate inlineSurfaces from history
            chatMsg.inlineSurfaces = inlineSurfaces

            // Use daemon-provided segments/order when available; fall back to legacy.
            // The daemon always provides contentOrder when there are any content blocks,
            // so we should use it even when textSegments is empty (e.g., widget-only turns).
            if let segments = item.textSegments, let orderStrings = item.contentOrder {
                chatMsg.textSegments = segments
                chatMsg.contentOrder = Self.parseContentOrder(orderStrings)
            } else {
                chatMsg.contentOrder = ChatMessage.buildDefaultContentOrder(
                    textSegmentCount: chatMsg.textSegments.count,
                    toolCallCount: toolCalls.count,
                    arrivedBeforeText: toolsBeforeText,
                    surfaceCount: inlineSurfaces.count
                )
            }

            // Log contentOrder for debugging widget restoration
            let surfaceRefs = chatMsg.contentOrder.filter {
                if case .surface = $0 { return true }
                return false
            }
            if !inlineSurfaces.isEmpty || !surfaceRefs.isEmpty {
                log.info("Message contentOrder: \(item.contentOrder ?? []), surface refs: \(surfaceRefs.count), inlineSurfaces: \(chatMsg.inlineSurfaces.count)")
            }

            chatMessages.append(chatMsg)
        }

        let hasUserSentMessages = messages.contains { $0.role == .user }
        if hasUserSentMessages {
            // History arrived after the user already sent messages.
            // The history payload includes ALL persisted messages — including
            // ones the user sent (and any assistant replies) before the
            // history_response arrived. Deduplicate by only prepending
            // history messages whose timestamps precede the earliest
            // existing message.
            let earliestExisting = self.messages.map(\.timestamp).min()
            let uniqueHistory: [ChatMessage]
            if let earliest = earliestExisting {
                uniqueHistory = chatMessages.filter { $0.timestamp < earliest }
            } else {
                uniqueHistory = chatMessages
            }
            self.messages = uniqueHistory + self.messages
        } else {
            self.messages = chatMessages
        }
        self.isHistoryLoaded = true
        // Surfaces are now included directly in the history response and populated above
    }

    deinit {
        messageLoopTask?.cancel()
    }
}
