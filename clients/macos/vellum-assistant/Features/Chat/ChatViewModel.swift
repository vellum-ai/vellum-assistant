import Foundation
import os
import UniformTypeIdentifiers
import AppKit

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ChatViewModel")

@MainActor
final class ChatViewModel: ObservableObject {
    @Published var messages: [ChatMessage] = []
    @Published var inputText: String = ""
    @Published var isThinking: Bool = false
    @Published var isSending: Bool = false
    @Published var errorText: String?
    @Published var pendingQueuedCount: Int = 0
    @Published var suggestion: String?
    @Published var pendingAttachments: [ChatAttachment] = []
    @Published var isRecording: Bool = false
    @Published var pendingSkillInvocation: SkillInvocationData?

    /// Maximum file size per attachment (20 MB).
    private static let maxFileSize = 20 * 1024 * 1024
    /// Maximum number of attachments per message.
    private static let maxAttachments = 5

    private let daemonClient: DaemonClient
    var sessionId: String?
    private var pendingUserMessage: String?
    private var pendingUserAttachments: [IPCAttachment]?
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
    /// Tracks the current in-flight suggestion request so stale responses are ignored.
    private var pendingSuggestionRequestId: String?
    /// Safety timer that force-resets the UI if the daemon never acknowledges
    /// a cancel request (e.g. a stuck tool blocks the generation_cancelled event).
    private var cancelTimeoutTask: Task<Void, Never>?

    /// Timestamp of the most recent `toolUseStart` event received by this view model.
    /// Used by ThreadManager to route `confirmationRequest` messages to the correct
    /// ChatViewModel when multiple threads have active sessions.
    var lastToolUseReceivedAt: Date?

    /// Called when an inline confirmation is responded to, so the floating panel can be dismissed.
    var onInlineConfirmationResponse: ((String) -> Void)?

    /// Called to determine whether this ChatViewModel should accept a `confirmationRequest`.
    /// Set by ThreadManager to coordinate routing when multiple ChatViewModels are active.
    var shouldAcceptConfirmation: (() -> Bool)?

    /// Whether this view model has had its history loaded from the daemon.
    var isHistoryLoaded: Bool = false

    init(daemonClient: DaemonClient) {
        self.daemonClient = daemonClient
    }

    // MARK: - Attachments

    func addAttachment(url: URL) {
        guard pendingAttachments.count < Self.maxAttachments else {
            errorText = "Maximum \(Self.maxAttachments) attachments per message."
            return
        }

        // Check file size via metadata before reading into memory to avoid
        // loading very large files synchronously (which could freeze the UI).
        do {
            let resourceValues = try url.resourceValues(forKeys: [.fileSizeKey])
            if let fileSize = resourceValues.fileSize, fileSize > Self.maxFileSize {
                errorText = "File exceeds 20 MB limit."
                return
            }
        } catch {
            log.error("Failed to read file attributes: \(error.localizedDescription)")
            errorText = "Could not read file."
            return
        }

        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch {
            log.error("Failed to read attachment: \(error.localizedDescription)")
            errorText = "Could not read file."
            return
        }

        // Belt-and-suspenders: the pre-read metadata check above may report
        // nil (e.g. symlinks, certain file systems) so always validate the
        // actual byte count after reading.
        guard data.count <= Self.maxFileSize else {
            errorText = "File exceeds 20 MB limit."
            return
        }

        let filename = url.lastPathComponent
        let mimeType = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        let base64 = data.base64EncodedString()

        var thumbnail: Data?
        if let utType = UTType(filenameExtension: url.pathExtension), utType.conforms(to: .image) {
            thumbnail = Self.generateThumbnail(from: data, maxDimension: 120)
        }

        let attachment = ChatAttachment(
            id: UUID().uuidString,
            filename: filename,
            mimeType: mimeType,
            data: base64,
            thumbnailData: thumbnail,
            dataLength: base64.count,
            thumbnailImage: thumbnail.flatMap { NSImage(data: $0) }
        )
        pendingAttachments.append(attachment)
    }

    func removeAttachment(id: String) {
        pendingAttachments.removeAll { $0.id == id }
    }

    func addAttachmentFromPasteboard() {
        let pasteboard = NSPasteboard.general
        guard let imageData = pasteboard.data(forType: .png) ?? pasteboard.data(forType: .tiff) else {
            return
        }

        guard pendingAttachments.count < Self.maxAttachments else {
            errorText = "Maximum \(Self.maxAttachments) attachments per message."
            return
        }

        // Convert to PNG if needed
        let pngData: Data
        if pasteboard.data(forType: .png) != nil {
            pngData = imageData
        } else if let bitmapRep = NSBitmapImageRep(data: imageData),
                  let converted = bitmapRep.representation(using: .png, properties: [:]) {
            pngData = converted
        } else {
            log.error("Failed to convert pasted image to PNG")
            errorText = "Could not process pasted image."
            return
        }

        guard pngData.count <= Self.maxFileSize else {
            errorText = "Pasted image exceeds 20 MB limit."
            return
        }

        let base64 = pngData.base64EncodedString()
        let thumbnail = Self.generateThumbnail(from: pngData, maxDimension: 120)

        let attachment = ChatAttachment(
            id: UUID().uuidString,
            filename: "Pasted Image.png",
            mimeType: "image/png",
            data: base64,
            thumbnailData: thumbnail,
            dataLength: base64.count,
            thumbnailImage: thumbnail.flatMap { NSImage(data: $0) }
        )
        pendingAttachments.append(attachment)
    }

    /// Resize image data to fit within `maxDimension` and return PNG data.
    private static func generateThumbnail(from data: Data, maxDimension: CGFloat) -> Data? {
        guard let image = NSImage(data: data) else { return nil }
        let size = image.size
        guard size.width > 0 && size.height > 0 else { return nil }
        let scale = min(maxDimension / size.width, maxDimension / size.height, 1.0)
        let newSize = NSSize(width: size.width * scale, height: size.height * scale)
        let resized = NSImage(size: newSize)
        resized.lockFocus()
        image.draw(in: NSRect(origin: .zero, size: newSize),
                   from: NSRect(origin: .zero, size: size),
                   operation: .copy, fraction: 1.0)
        resized.unlockFocus()
        guard let tiffData = resized.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiffData),
              let png = bitmap.representation(using: .png, properties: [:]) else { return nil }
        return png
    }

    // MARK: - Sending

    func sendMessage() {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        let hasAttachments = !pendingAttachments.isEmpty
        let hasSkillInvocation = pendingSkillInvocation != nil
        guard !text.isEmpty || hasAttachments || hasSkillInvocation else { return }

        // Block rapid-fire only when bootstrapping (no session yet)
        if isSending && sessionId == nil {
            pendingSkillInvocation = nil
            return
        }

        // Snapshot and clear pending attachments
        let attachments = pendingAttachments
        pendingAttachments = []

        // Append user message immediately for responsive UX
        let willBeQueued = isSending && sessionId != nil
        let status: ChatMessageStatus = willBeQueued ? .queued(position: 0) : .sent
        let userMessage = ChatMessage(role: .user, text: text, status: status, skillInvocation: pendingSkillInvocation, attachments: attachments)
        pendingSkillInvocation = nil
        messages.append(userMessage)
        // Only track in pendingMessageIds when the message will actually be
        // queued by the daemon (i.e. sent while another message is processing).
        // Messages processed immediately never receive a messageQueued event,
        // so adding them would corrupt the FIFO mapping.
        if willBeQueued {
            pendingMessageIds.append(userMessage.id)
        }
        inputText = ""
        suggestion = nil
        pendingSuggestionRequestId = nil
        errorText = nil

        let ipcAttachments: [IPCAttachment]? = attachments.isEmpty ? nil : attachments.map {
            IPCAttachment(filename: $0.filename, mimeType: $0.mimeType, data: $0.data, extractedText: nil)
        }

        if sessionId == nil {
            // First message: need to bootstrap session
            bootstrapSession(userMessage: text, attachments: ipcAttachments)
        } else {
            // Subsequent messages: send directly (daemon queues if busy)
            sendUserMessage(text, attachments: ipcAttachments, queuedMessageId: willBeQueued ? userMessage.id : nil)
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

    private func sendUserMessage(_ text: String, attachments: [IPCAttachment]? = nil, queuedMessageId: UUID? = nil) {
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
                attachments: attachments
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

    /// Priority list of input keys whose values are most useful as a tool call summary.
    private static let toolInputPriorityKeys = [
        "command", "file_path", "path", "query", "url", "pattern", "glob"
    ]

    /// Summarize tool input for display, picking the most relevant value truncated to 80 chars.
    private func summarizeToolInput(_ input: [String: AnyCodable]) -> String {
        // Pick the first matching priority key, falling back to the first sorted key.
        let value: AnyCodable
        if let match = Self.toolInputPriorityKeys.first(where: { input[$0] != nil }),
           let v = input[match] {
            value = v
        } else if let firstKey = input.keys.sorted().first, let v = input[firstKey] {
            value = v
        } else {
            return ""
        }
        let str: String
        if let s = value.value as? String {
            str = s
        } else if let encoder = try? JSONEncoder().encode(value),
                  let json = String(data: encoder, encoding: .utf8) {
            str = json
        } else {
            str = String(describing: value.value ?? "")
        }
        return str.count > 80 ? String(str.prefix(77)) + "..." : str
    }

    private func toolDisplayName(_ name: String) -> String {
        switch name {
        case "file_write": return "Write File"
        case "file_edit": return "Edit File"
        case "bash": return "Run Command"
        case "web_fetch": return "Fetch URL"
        case "file_read": return "Read File"
        case "glob": return "Find Files"
        case "grep": return "Search Files"
        default: return name.replacingOccurrences(of: "_", with: " ").capitalized
        }
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
                    let attachments = pendingUserAttachments
                    pendingUserMessage = nil
                    pendingUserAttachments = nil
                    do {
                        try daemonClient.send(UserMessageMessage(
                            sessionId: info.sessionId,
                            content: pending,
                            attachments: attachments
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

        case .suggestionResponse(let resp):
            // Only accept if this response matches our current request
            guard resp.requestId == pendingSuggestionRequestId else { return }
            pendingSuggestionRequestId = nil
            suggestion = resp.suggestion

        case .messageComplete(let complete):
            guard belongsToSession(complete.sessionId) else { return }
            cancelTimeoutTask?.cancel()
            cancelTimeoutTask = nil
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
            // Fetch a follow-up suggestion when the turn is fully complete
            if !isSending {
                fetchSuggestion()
            }

        case .generationCancelled(let cancelled):
            guard belongsToSession(cancelled.sessionId) else { return }
            cancelTimeoutTask?.cancel()
            cancelTimeoutTask = nil
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
            let wasCancelling = isCancelling
            isCancelling = false
            // Mark current assistant message as no longer streaming
            if let existingId = currentAssistantMessageId,
               let index = messages.firstIndex(where: { $0.id == existingId }) {
                messages[index].isStreaming = false
            }
            currentAssistantMessageId = nil
            if !wasCancelling {
                errorText = err.message
            }
            // Reset processing messages to sent
            for i in messages.indices {
                if messages[i].role == .user && messages[i].status == .processing {
                    messages[i].status = .sent
                }
            }
            // When cancelling, the daemon's abort() emits error events for
            // queued messages but drops the queue without sending
            // message_dequeued events, so pendingQueuedCount never drains
            // on its own. Force-clear all queue state to prevent isSending
            // from staying true permanently. Also reset queued message
            // statuses since the daemon will not process them.
            if wasCancelling {
                isSending = false
                pendingQueuedCount = 0
                pendingMessageIds = []
                requestIdToMessageId = [:]
                for i in messages.indices {
                    if case .queued = messages[i].status, messages[i].role == .user {
                        messages[i].status = .sent
                    }
                }
            } else if pendingQueuedCount == 0 {
                // The daemon drains queued work after a non-cancellation
                // error, so preserve queue bookkeeping when messages are
                // still queued. Only clear everything when the queue is
                // empty.
                isSending = false
                pendingMessageIds = []
                requestIdToMessageId = [:]
            }

        case .confirmationRequest(let msg):
            // Route using sessionId when available (daemon >= v1.x includes
            // the conversationId). Fall back to the timestamp-based heuristic
            // via shouldAcceptConfirmation for older daemons that omit sessionId.
            if let msgSessionId = msg.sessionId {
                guard sessionId != nil, belongsToSession(msgSessionId) else { return }
            } else {
                guard sessionId != nil,
                      lastToolUseReceivedAt != nil,
                      shouldAcceptConfirmation?() ?? false else { return }
            }
            isThinking = false
            let confirmation = ToolConfirmationData(
                requestId: msg.requestId,
                toolName: msg.toolName,
                input: msg.input,
                riskLevel: msg.riskLevel,
                diff: msg.diff,
                allowlistOptions: msg.allowlistOptions,
                scopeOptions: msg.scopeOptions
            )
            let confirmMsg = ChatMessage(
                role: .assistant,
                text: "",
                confirmation: confirmation
            )
            // Insert before the current streaming assistant message so the
            // confirmation appears between the user message and the response.
            if let existingId = currentAssistantMessageId,
               let index = messages.firstIndex(where: { $0.id == existingId }) {
                messages.insert(confirmMsg, at: index)
            } else {
                messages.append(confirmMsg)
            }

        case .toolUseStart(let msg):
            guard belongsToSession(msg.sessionId) else { return }
            guard !isCancelling else { return }
            lastToolUseReceivedAt = Date()
            // Suppress ToolCallChip for ui_show — the inline surface widget replaces it.
            if msg.toolName == "ui_show" || msg.toolName == "ui_update" || msg.toolName == "ui_dismiss" || msg.toolName == "request_file" {
                break
            }
            let toolCall = ToolCallData(
                toolName: toolDisplayName(msg.toolName),
                inputSummary: summarizeToolInput(msg.input)
            )
            // Add to existing assistant message or create one
            if let existingId = currentAssistantMessageId,
               let index = messages.firstIndex(where: { $0.id == existingId }) {
                messages[index].toolCalls.append(toolCall)
            } else {
                let newMsg = ChatMessage(role: .assistant, text: "", isStreaming: true, toolCalls: [toolCall])
                currentAssistantMessageId = newMsg.id
                messages.append(newMsg)
            }

        case .toolOutputChunk:
            // Streaming output — ignore for now, we show the final result
            break

        case .toolResult(let msg):
            guard belongsToSession(msg.sessionId) else { return }
            guard !isCancelling else { return }
            // Find the most recent pending (incomplete) tool call and mark it complete
            if let existingId = currentAssistantMessageId,
               let msgIndex = messages.firstIndex(where: { $0.id == existingId }),
               let tcIndex = messages[msgIndex].toolCalls.lastIndex(where: { !$0.isComplete }) {
                let truncatedResult = msg.result.count > 2000 ? String(msg.result.prefix(2000)) + "...[truncated]" : msg.result
                messages[msgIndex].toolCalls[tcIndex].result = truncatedResult
                messages[msgIndex].toolCalls[tcIndex].isError = msg.isError ?? false
                messages[msgIndex].toolCalls[tcIndex].isComplete = true
            }

        case .uiSurfaceShow(let msg):
            guard belongsToSession(msg.sessionId) else { return }
            guard msg.display == nil || msg.display == "inline" else { break }
            guard let surface = Surface.from(msg) else { break }
            isThinking = false
            let inlineSurface = InlineSurfaceData(
                id: surface.id,
                surfaceType: surface.type,
                title: surface.title,
                data: surface.data,
                actions: surface.actions
            )
            if let existingId = currentAssistantMessageId,
               let index = messages.firstIndex(where: { $0.id == existingId }) {
                messages[index].inlineSurfaces.append(inlineSurface)
            } else {
                let newMsg = ChatMessage(role: .assistant, text: "", isStreaming: true, inlineSurfaces: [inlineSurface])
                currentAssistantMessageId = newMsg.id
                messages.append(newMsg)
            }

        case .uiSurfaceUpdate(let msg):
            guard belongsToSession(msg.sessionId) else { return }
            // Find the inline surface across all messages and update its data
            for msgIndex in messages.indices {
                if let surfaceIndex = messages[msgIndex].inlineSurfaces.firstIndex(where: { $0.id == msg.surfaceId }) {
                    let existing = messages[msgIndex].inlineSurfaces[surfaceIndex]
                    let tempSurface = Surface(id: existing.id, sessionId: msg.sessionId, type: existing.surfaceType, title: existing.title, data: existing.data, actions: existing.actions)
                    if let updated = tempSurface.updated(with: msg) {
                        messages[msgIndex].inlineSurfaces[surfaceIndex] = InlineSurfaceData(
                            id: updated.id,
                            surfaceType: updated.type,
                            title: updated.title,
                            data: updated.data,
                            actions: updated.actions
                        )
                    }
                    return
                }
            }

        case .uiSurfaceDismiss(let msg):
            guard belongsToSession(msg.sessionId) else { return }
            // Find and remove the inline surface across all messages
            for msgIndex in messages.indices {
                if let surfaceIndex = messages[msgIndex].inlineSurfaces.firstIndex(where: { $0.id == msg.surfaceId }) {
                    messages[msgIndex].inlineSurfaces.remove(at: surfaceIndex)
                    return
                }
            }

        default:
            break
        }
    }

    func sendSurfaceAction(surfaceId: String, actionId: String, data: [String: AnyCodable]? = nil) {
        guard let sessionId = sessionId else { return }
        let msg = UiSurfaceActionMessage(
            sessionId: sessionId,
            surfaceId: surfaceId,
            actionId: actionId,
            data: data
        )
        try? daemonClient.send(msg)
    }

    func stopGenerating() {
        guard isSending else { return }

        // If we're still bootstrapping (no session yet), cancel locally:
        // discard the pending message so it won't be sent when session_info
        // arrives, and reset UI state immediately since there's nothing to
        // cancel on the daemon side.
        if sessionId == nil {
            pendingUserMessage = nil
            pendingUserAttachments = nil
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
                for j in messages[index].toolCalls.indices where !messages[index].toolCalls[j].isComplete {
                    messages[index].toolCalls[j].isComplete = true
                }
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
            isCancelling = false
            // Mark current assistant message as stopped
            if let existingId = currentAssistantMessageId,
               let index = messages.firstIndex(where: { $0.id == existingId }) {
                messages[index].isStreaming = false
                for j in messages[index].toolCalls.indices where !messages[index].toolCalls[j].isComplete {
                    messages[index].toolCalls[j].isComplete = true
                }
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

        // Mark current assistant message as stopped and complete any in-progress tool calls
        // so their chips don't show an endless spinner.
        if let existingId = currentAssistantMessageId,
           let index = messages.firstIndex(where: { $0.id == existingId }) {
            messages[index].isStreaming = false
            for j in messages[index].toolCalls.indices where !messages[index].toolCalls[j].isComplete {
                messages[index].toolCalls[j].isComplete = true
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
            self.isCancelling = false
            self.isSending = false
            self.currentAssistantMessageId = nil
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

    func dismissError() {
        errorText = nil
    }

    /// Respond to a tool confirmation request displayed inline in the chat.
    func respondToConfirmation(requestId: String, decision: String) {
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
        // Dismiss the corresponding floating panel if one exists
        onInlineConfirmationResponse?(requestId)
    }

    /// Update the inline confirmation message state without sending a response to the daemon.
    /// Used when the floating panel handles the response.
    func updateConfirmationState(requestId: String, decision: String) {
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
    func addTrustRule(toolName: String, pattern: String, scope: String, decision: String) -> Bool {
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

    /// Ask the daemon for a follow-up suggestion for the current session.
    private func fetchSuggestion() {
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
    func acceptSuggestion() {
        guard let suggestion else { return }
        if suggestion.hasPrefix(inputText) {
            inputText = suggestion
        } else if inputText.isEmpty {
            inputText = suggestion
        }
        self.suggestion = nil
    }

    /// Populate messages from history data returned by the daemon.
    /// Only replaces messages if the user hasn't sent any new messages yet,
    /// preventing a late history_response from overwriting live conversation.
    func populateFromHistory(_ historyMessages: [HistoryResponseMessage.HistoryMessageItem]) {
        let hasUserSentMessages = messages.contains { $0.role == .user }
        if hasUserSentMessages {
            isHistoryLoaded = true
            return
        }

        var chatMessages: [ChatMessage] = []
        for item in historyMessages {
            let role: ChatRole = item.role == "assistant" ? .assistant : .user
            var toolCalls: [ToolCallData] = []
            if let historyToolCalls = item.toolCalls {
                toolCalls = historyToolCalls.map { tc in
                    ToolCallData(
                        toolName: toolDisplayName(tc.name),
                        inputSummary: summarizeToolInput(tc.input),
                        result: tc.result,
                        isError: tc.isError ?? false,
                        isComplete: true
                    )
                }
            }
            // Skip empty messages (internal tool-result-only turns already filtered by daemon)
            if item.text.isEmpty && toolCalls.isEmpty { continue }
            let timestamp = Date(timeIntervalSince1970: TimeInterval(item.timestamp) / 1000.0)
            let chatMsg = ChatMessage(
                role: role,
                text: item.text,
                timestamp: timestamp,
                toolCalls: toolCalls
            )
            chatMessages.append(chatMsg)
        }
        self.messages = chatMessages
        self.isHistoryLoaded = true
    }

    deinit {
        messageLoopTask?.cancel()
    }
}
