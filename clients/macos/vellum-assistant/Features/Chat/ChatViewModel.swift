import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ChatViewModel")

@MainActor
final class ChatViewModel: ObservableObject {
    @Published var messages: [ChatMessage] = []
    @Published var inputText: String = ""
    @Published var isThinking: Bool = false
    @Published var isSending: Bool = false
    @Published var errorText: String?
    @Published var pendingQueuedCount: Int = 0

    private let daemonClient: DaemonClient
    var sessionId: String?
    private var pendingUserMessage: String?
    /// Nonce sent with `session_create` and echoed back in `session_info`.
    /// Used to ensure this ChatViewModel only claims its own session.
    private var bootstrapCorrelationId: String?
    private var messageLoopTask: Task<Void, Never>?
    /// Monotonically increasing ID used to distinguish successive message-loop
    /// tasks so that a cancelled loop's cleanup doesn't clear a newer replacement.
    private var messageLoopGeneration: UInt64 = 0
    private var currentAssistantMessageId: UUID?
    /// When true, incoming deltas are suppressed until the daemon acknowledges
    /// the cancellation (via `generation_cancelled` or `message_complete`).
    private var isCancelling: Bool = false
    /// Maps daemon requestId to the user message UUID in the messages array.
    private var requestIdToMessageId: [String: UUID] = [:]
    /// FIFO queue of user message UUIDs awaiting requestId assignment from the daemon.
    private var pendingMessageIds: [UUID] = []

    init(daemonClient: DaemonClient) {
        self.daemonClient = daemonClient
        // Add initial greeting
        let name = UserDefaults.standard.string(forKey: "assistantName") ?? "Vellum"
        messages.append(ChatMessage(role: .assistant, text: "Hello! I'm \(name). How can I help you today?"))
    }

    func sendMessage() {
        let text = inputText.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return }

        // Block rapid-fire only when bootstrapping (no session yet)
        if isSending && sessionId == nil { return }

        // Append user message immediately for responsive UX
        let willBeQueued = isSending && sessionId != nil
        let status: ChatMessageStatus = willBeQueued ? .queued(position: 0) : .sent
        let userMessage = ChatMessage(role: .user, text: text, status: status)
        messages.append(userMessage)
        // Only track in pendingMessageIds when the message will actually be
        // queued by the daemon (i.e. sent while another message is processing).
        // Messages processed immediately never receive a messageQueued event,
        // so adding them would corrupt the FIFO mapping.
        if willBeQueued {
            pendingMessageIds.append(userMessage.id)
        }
        inputText = ""
        errorText = nil

        if sessionId == nil {
            // First message: need to bootstrap session
            bootstrapSession(userMessage: text)
        } else {
            // Subsequent messages: send directly (daemon queues if busy)
            sendUserMessage(text, queuedMessageId: willBeQueued ? userMessage.id : nil)
        }
    }

    private func bootstrapSession(userMessage: String) {
        isSending = true
        isThinking = true
        pendingUserMessage = userMessage

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
                    self.errorText = "Cannot connect to daemon. Please ensure it's running."
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
                self.errorText = "Failed to create session."
            }
        }
    }

    private func sendUserMessage(_ text: String, queuedMessageId: UUID? = nil) {
        guard let sessionId else { return }

        // Check connectivity before entering sending state so the UI
        // doesn't get stuck with isSending/isThinking = true when the
        // daemon has disconnected between turns.
        guard daemonClient.isConnected else {
            log.error("Cannot send user_message: daemon not connected")
            errorText = "Cannot connect to daemon. Please ensure it's running."
            // Remove the queued message ID to prevent stale FIFO entries
            if let queuedMessageId {
                pendingMessageIds.removeAll { $0 == queuedMessageId }
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
                attachments: nil
            ))
        } catch {
            log.error("Failed to send user_message: \(error.localizedDescription)")
            isSending = false
            isThinking = false
            errorText = "Failed to send message."
            // Remove the queued message ID to prevent stale FIFO entries
            if let queuedMessageId {
                pendingMessageIds.removeAll { $0 == queuedMessageId }
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

    /// Returns true if the given session ID belongs to this chat session.
    /// Messages with a nil sessionId are always accepted; messages whose
    /// sessionId doesn't match the current session are silently ignored
    /// to prevent cross-session contamination (e.g. from a popover text_qa flow).
    private func belongsToSession(_ messageSessionId: String?) -> Bool {
        guard let messageSessionId else { return true }
        guard let sessionId else {
            // No session established yet — accept all messages
            return true
        }
        return messageSessionId == sessionId
    }

    func handleServerMessage(_ message: ServerMessage) {
        switch message {
        case .sessionInfo(let info):
            // Only claim this session_info if:
            // 1. We don't have a session yet, AND
            // 2. The correlation ID matches our bootstrap request (if we sent one).
            //    Session info without a correlation ID is accepted when we have no
            //    bootstrap correlation (backwards compatibility with older daemons).
            if sessionId == nil {
                if let expected = bootstrapCorrelationId {
                    guard info.correlationId == expected else {
                        // This session_info belongs to a different ChatViewModel's request.
                        break
                    }
                }

                sessionId = info.sessionId
                bootstrapCorrelationId = nil
                log.info("Chat session created: \(info.sessionId)")

                // Send the queued user message
                if let pending = pendingUserMessage {
                    pendingUserMessage = nil
                    do {
                        try daemonClient.send(UserMessageMessage(
                            sessionId: info.sessionId,
                            content: pending,
                            attachments: nil
                        ))
                    } catch {
                        log.error("Failed to send queued user_message: \(error.localizedDescription)")
                        isSending = false
                        isThinking = false
                        errorText = "Failed to send message."
                    }
                }
            }

        case .assistantThinkingDelta:
            // Stay in thinking state
            break

        case .assistantTextDelta(let delta):
            guard belongsToSession(delta.sessionId) else { return }
            // Suppress late-arriving deltas after the user clicked stop.
            guard !isCancelling else { return }
            isThinking = false
            if let existingId = currentAssistantMessageId,
               let index = messages.firstIndex(where: { $0.id == existingId }) {
                // Append to existing streaming message
                messages[index].text += delta.text
            } else {
                // Create new assistant message
                let msg = ChatMessage(role: .assistant, text: delta.text, isStreaming: true)
                currentAssistantMessageId = msg.id
                messages.append(msg)
            }

        case .messageComplete(let complete):
            guard belongsToSession(complete.sessionId) else { return }
            isCancelling = false
            isThinking = false
            // Only clear isSending if no messages are still queued
            if pendingQueuedCount == 0 {
                isSending = false
            }
            // Mark the current assistant message as complete
            if let existingId = currentAssistantMessageId,
               let index = messages.firstIndex(where: { $0.id == existingId }) {
                messages[index].isStreaming = false
            }
            currentAssistantMessageId = nil
            // Reset processing messages to sent
            for i in messages.indices {
                if messages[i].role == .user && messages[i].status == .processing {
                    messages[i].status = .sent
                }
            }

        case .generationCancelled(let cancelled):
            guard belongsToSession(cancelled.sessionId) else { return }
            isCancelling = false
            isThinking = false
            if pendingQueuedCount == 0 {
                isSending = false
            }
            if let existingId = currentAssistantMessageId,
               let index = messages.firstIndex(where: { $0.id == existingId }) {
                messages[index].isStreaming = false
            }
            currentAssistantMessageId = nil
            // Reset processing messages to sent
            for i in messages.indices {
                if messages[i].role == .user && messages[i].status == .processing {
                    messages[i].status = .sent
                }
            }

        case .messageQueued(let queued):
            guard belongsToSession(queued.sessionId) else { return }
            pendingQueuedCount += 1
            // Associate this requestId with the oldest pending user message
            if let messageId = pendingMessageIds.first {
                pendingMessageIds.removeFirst()
                requestIdToMessageId[queued.requestId] = messageId
                if let index = messages.firstIndex(where: { $0.id == messageId }) {
                    messages[index].status = .queued(position: queued.position)
                }
            }

        case .messageDequeued(let msg):
            guard belongsToSession(msg.sessionId) else { return }
            pendingQueuedCount = max(0, pendingQueuedCount - 1)
            // Mark the associated user message as processing
            if let messageId = requestIdToMessageId.removeValue(forKey: msg.requestId),
               let index = messages.firstIndex(where: { $0.id == messageId }) {
                messages[index].status = .processing
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

        case .generationHandoff(let handoff):
            guard belongsToSession(handoff.sessionId) else { return }
            isThinking = false
            // Keep isSending = true — daemon is handing off to next queued message
            if let existingId = currentAssistantMessageId,
               let index = messages.firstIndex(where: { $0.id == existingId }) {
                messages[index].isStreaming = false
            }
            currentAssistantMessageId = nil
            // Reset processing messages to sent
            for i in messages.indices {
                if messages[i].role == .user && messages[i].status == .processing {
                    messages[i].status = .sent
                }
            }

        case .error(let err):
            log.error("Server error: \(err.message)")
            isThinking = false
            isSending = false
            isCancelling = false
            // Mark current assistant message as no longer streaming
            if let existingId = currentAssistantMessageId,
               let index = messages.firstIndex(where: { $0.id == existingId }) {
                messages[index].isStreaming = false
            }
            currentAssistantMessageId = nil
            pendingQueuedCount = 0
            pendingMessageIds = []
            requestIdToMessageId = [:]
            errorText = err.message
            // Reset processing/queued messages to sent
            for i in messages.indices {
                if case .queued = messages[i].status, messages[i].role == .user {
                    messages[i].status = .sent
                } else if messages[i].role == .user && messages[i].status == .processing {
                    messages[i].status = .sent
                }
            }

        default:
            break
        }
    }

    func stopGenerating() {
        guard isSending else { return }

        // If we're still bootstrapping (no session yet), cancel locally:
        // discard the pending message so it won't be sent when session_info
        // arrives, and reset UI state immediately since there's nothing to
        // cancel on the daemon side.
        if sessionId == nil {
            pendingUserMessage = nil
            bootstrapCorrelationId = nil
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
            isSending = false
            isThinking = false
            isCancelling = false
            if let existingId = currentAssistantMessageId,
               let index = messages.firstIndex(where: { $0.id == existingId }) {
                messages[index].isStreaming = false
            }
            currentAssistantMessageId = nil
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
            isSending = false
            isThinking = false
            // Mark current assistant message as stopped
            if let existingId = currentAssistantMessageId,
               let index = messages.firstIndex(where: { $0.id == existingId }) {
                messages[index].isStreaming = false
            }
            currentAssistantMessageId = nil
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
        isThinking = false

        // Mark current assistant message as stopped
        if let existingId = currentAssistantMessageId,
           let index = messages.firstIndex(where: { $0.id == existingId }) {
            messages[index].isStreaming = false
        }
    }

    func dismissError() {
        errorText = nil
    }

    deinit {
        messageLoopTask?.cancel()
    }
}
