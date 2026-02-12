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
    private var messageLoopTask: Task<Void, Never>?
    private var currentAssistantMessageId: UUID?
    /// Maps daemon requestId to the user message UUID in the messages array.
    private var requestIdToMessageId: [String: UUID] = [:]
    /// FIFO queue of user message UUIDs awaiting requestId assignment from the daemon.
    private var pendingMessageIds: [UUID] = []

    init(daemonClient: DaemonClient) {
        self.daemonClient = daemonClient
        // Add initial greeting
        let name = UserDefaults.standard.string(forKey: "assistantName") ?? "vellum-assistant"
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

        Task { @MainActor in
            // Ensure daemon connection
            if !daemonClient.isConnected {
                do {
                    try await daemonClient.connect()
                } catch {
                    log.error("Failed to connect to daemon: \(error.localizedDescription)")
                    self.isThinking = false
                    self.isSending = false
                    self.errorText = "Cannot connect to daemon. Please ensure it's running."
                    return
                }
            }

            // Subscribe to daemon stream
            self.startMessageLoop()

            // Send session_create
            do {
                try daemonClient.send(SessionCreateMessage(title: nil))
            } catch {
                log.error("Failed to send session_create: \(error.localizedDescription)")
                self.isThinking = false
                self.isSending = false
                self.errorText = "Failed to create session."
            }
        }
    }

    private func sendUserMessage(_ text: String, queuedMessageId: UUID? = nil) {
        guard let sessionId else { return }
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

        messageLoopTask = Task { @MainActor [weak self] in
            for await message in messageStream {
                guard let self, !Task.isCancelled else { break }
                self.handleServerMessage(message)
            }
        }
    }

    func handleServerMessage(_ message: ServerMessage) {
        switch message {
        case .sessionInfo(let info):
            if sessionId == nil {
                sessionId = info.sessionId
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

        case .messageComplete:
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

        case .generationCancelled:
            isThinking = false
            if pendingQueuedCount == 0 {
                isSending = false
            }
            if let existingId = currentAssistantMessageId,
               let index = messages.firstIndex(where: { $0.id == existingId }) {
                messages[index].isStreaming = false
            }
            currentAssistantMessageId = nil

        case .messageQueued(let queued):
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

        case .error(let err):
            log.error("Server error: \(err.message)")
            isThinking = false
            isSending = false
            currentAssistantMessageId = nil
            errorText = err.message

        default:
            break
        }
    }

    func stopGenerating() {
        guard isSending, let sessionId else { return }

        do {
            try daemonClient.send(CancelMessage(sessionId: sessionId))
        } catch {
            log.error("Failed to send cancel: \(error.localizedDescription)")
        }

        // Immediately update UI state
        isThinking = false
        isSending = false

        // Mark current assistant message as stopped
        if let existingId = currentAssistantMessageId,
           let index = messages.firstIndex(where: { $0.id == existingId }) {
            messages[index].isStreaming = false
        }
        currentAssistantMessageId = nil
    }

    func dismissError() {
        errorText = nil
    }

    deinit {
        messageLoopTask?.cancel()
    }
}
