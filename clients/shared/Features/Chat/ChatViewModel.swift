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

/// Categorizes session errors for UI display and recovery suggestions.
public enum SessionErrorCategory: Equatable, Sendable {
    case providerNetwork
    case rateLimit
    case providerApi
    case queueFull
    case sessionAborted
    case processingFailed
    case regenerateFailed
    case unknown

    public init(from code: SessionErrorCode) {
        switch code {
        case .providerNetwork:
            self = .providerNetwork
        case .providerRateLimit:
            self = .rateLimit
        case .providerApi:
            self = .providerApi
        case .queueFull:
            self = .queueFull
        case .sessionAborted:
            self = .sessionAborted
        case .sessionProcessingFailed:
            self = .processingFailed
        case .regenerateFailed:
            self = .regenerateFailed
        case .unknown:
            self = .unknown
        }
    }

    /// User-facing recovery suggestion for this error category.
    public var recoverySuggestion: String {
        switch self {
        case .providerNetwork:
            return "Check your internet connection and try again."
        case .rateLimit:
            return "You've hit a rate limit. Please wait a moment before retrying."
        case .providerApi:
            return "The AI provider returned an error. Try again or check your API key."
        case .queueFull:
            return "Too many pending messages. Wait for current messages to finish processing."
        case .sessionAborted:
            return "The session was interrupted. Send a new message to continue."
        case .processingFailed:
            return "Message processing failed. Try sending your message again."
        case .regenerateFailed:
            return "Could not regenerate the response. Try again."
        case .unknown:
            return "An unexpected error occurred. Try again."
        }
    }
}

/// Typed error state for session-level errors from the daemon.
public struct SessionError: Equatable {
    public let category: SessionErrorCategory
    public let message: String
    public let isRetryable: Bool
    public let recoverySuggestion: String
    public let sessionId: String
    public let debugDetails: String?

    public init(from msg: SessionErrorMessage) {
        self.category = SessionErrorCategory(from: msg.code)
        self.message = msg.userMessage
        self.isRetryable = msg.retryable
        self.recoverySuggestion = self.category.recoverySuggestion
        self.sessionId = msg.sessionId
        self.debugDetails = msg.debugDetails
    }

    public init(category: SessionErrorCategory, message: String, isRetryable: Bool, sessionId: String, debugDetails: String? = nil) {
        self.category = category
        self.message = message
        self.isRetryable = isRetryable
        self.recoverySuggestion = category.recoverySuggestion
        self.sessionId = sessionId
        self.debugDetails = debugDetails
    }
}

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
    @Published public var pendingSkillInvocation: SkillInvocationData?

    /// Maximum file size per attachment (20 MB).
    private static let maxFileSize = 20 * 1024 * 1024
    /// Maximum number of attachments per message.
    private static let maxAttachments = 5

    private let daemonClient: DaemonClient
    public var sessionId: String?
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
    // Public (rather than private) so tests can simulate the
    // daemon-acknowledged cancellation state directly.
    public var isCancelling: Bool = false
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
    public var lastToolUseReceivedAt: Date?

    /// Called when an inline confirmation is responded to, so the floating panel can be dismissed.
    public var onInlineConfirmationResponse: ((String) -> Void)?

    /// Called to determine whether this ChatViewModel should accept a `confirmationRequest`.
    /// Set by ThreadManager to coordinate routing when multiple ChatViewModels are active.
    public var shouldAcceptConfirmation: (() -> Bool)?

    /// Whether this view model has had its history loaded from the daemon.
    public var isHistoryLoaded: Bool = false

    public init(daemonClient: DaemonClient) {
        self.daemonClient = daemonClient
    }

    // MARK: - Attachments

    public func addAttachment(url: URL) {
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

        #if os(macOS)
        let thumbnailImage = thumbnail.flatMap { NSImage(data: $0) }
        #elseif os(iOS)
        let thumbnailImage = thumbnail.flatMap { UIImage(data: $0) }
        #else
        #error("Unsupported platform")
        #endif

        let attachment = ChatAttachment(
            id: UUID().uuidString,
            filename: filename,
            mimeType: mimeType,
            data: base64,
            thumbnailData: thumbnail,
            dataLength: base64.count,
            thumbnailImage: thumbnailImage
        )
        pendingAttachments.append(attachment)
    }

    public func removeAttachment(id: String) {
        pendingAttachments.removeAll { $0.id == id }
    }

    public func addAttachmentFromPasteboard() {
        #if os(macOS)
        let pasteboard = NSPasteboard.general

        // Prefer file URLs — preserves the original filename
        if let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: [
            .urlReadingFileURLsOnly: true,
        ]) as? [URL], !urls.isEmpty {
            for url in urls {
                addAttachment(url: url)
            }
            return
        }

        // Fall back to raw image data (e.g. screenshot to clipboard)
        guard let imageData = pasteboard.data(forType: .png) ?? pasteboard.data(forType: .tiff) else {
            return
        }
        addAttachment(imageData: imageData, filename: "Pasted Image.png")
        #elseif os(iOS)
        let pasteboard = UIPasteboard.general
        guard let image = pasteboard.image, let imageData = image.pngData() else {
            return
        }
        addAttachment(imageData: imageData, filename: "Pasted Image.png")
        #else
        #error("Unsupported platform")
        #endif
    }

    /// Add an attachment from raw image data (e.g. drag-and-drop, pasteboard).
    /// Converts TIFF to PNG if needed.
    public func addAttachment(imageData: Data, filename: String = "Dropped Image.png") {
        guard pendingAttachments.count < Self.maxAttachments else {
            errorText = "Maximum \(Self.maxAttachments) attachments per message."
            return
        }

        // Convert to PNG if needed — raw image data may be TIFF
        let pngData: Data
        #if os(macOS)
        if let _ = NSImage(data: imageData) {
            // Check if already PNG by looking at magic bytes
            let pngMagic: [UInt8] = [0x89, 0x50, 0x4E, 0x47]
            let headerBytes = [UInt8](imageData.prefix(4))
            if headerBytes == pngMagic {
                pngData = imageData
            } else if let bitmapRep = NSBitmapImageRep(data: imageData),
                      let converted = bitmapRep.representation(using: .png, properties: [:]) {
                pngData = converted
            } else {
                log.error("Failed to convert dropped image to PNG")
                errorText = "Could not process image."
                return
            }
        } else {
            log.error("Dropped data is not a valid image")
            errorText = "Could not process image."
            return
        }
        #elseif os(iOS)
        if let image = UIImage(data: imageData) {
            // Check if already PNG by looking at magic bytes
            let pngMagic: [UInt8] = [0x89, 0x50, 0x4E, 0x47]
            let headerBytes = [UInt8](imageData.prefix(4))
            if headerBytes == pngMagic {
                pngData = imageData
            } else if let converted = image.pngData() {
                pngData = converted
            } else {
                log.error("Failed to convert dropped image to PNG")
                errorText = "Could not process image."
                return
            }
        } else {
            log.error("Dropped data is not a valid image")
            errorText = "Could not process image."
            return
        }
        #else
        #error("Unsupported platform")
        #endif

        guard pngData.count <= Self.maxFileSize else {
            errorText = "Image exceeds 20 MB limit."
            return
        }

        let base64 = pngData.base64EncodedString()
        let thumbnail = Self.generateThumbnail(from: pngData, maxDimension: 120)

        #if os(macOS)
        let thumbnailImage = thumbnail.flatMap { NSImage(data: $0) }
        #elseif os(iOS)
        let thumbnailImage = thumbnail.flatMap { UIImage(data: $0) }
        #else
        #error("Unsupported platform")
        #endif

        let attachment = ChatAttachment(
            id: UUID().uuidString,
            filename: filename,
            mimeType: "image/png",
            data: base64,
            thumbnailData: thumbnail,
            dataLength: base64.count,
            thumbnailImage: thumbnailImage
        )
        pendingAttachments.append(attachment)
    }

    /// Resize image data to fit within `maxDimension` and return PNG data.
    private static func generateThumbnail(from data: Data, maxDimension: CGFloat) -> Data? {
        #if os(macOS)
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
        #elseif os(iOS)
        guard let image = UIImage(data: data) else { return nil }
        let size = image.size
        guard size.width > 0 && size.height > 0 else { return nil }
        let scale = min(maxDimension / size.width, maxDimension / size.height, 1.0)
        let newSize = CGSize(width: size.width * scale, height: size.height * scale)
        UIGraphicsBeginImageContextWithOptions(newSize, false, 0.0)
        image.draw(in: CGRect(origin: .zero, size: newSize))
        let resized = UIGraphicsGetImageFromCurrentImageContext()
        UIGraphicsEndImageContext()
        return resized?.pngData()
        #else
        #error("Unsupported platform")
        #endif
    }

    // MARK: - Sending

    public func sendMessage() {
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
        sessionError = nil

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

    public func handleServerMessage(_ message: ServerMessage) {
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
            // Must run before currentAssistantMessageId is cleared so attachments land on the right message
            ingestAssistantAttachments(complete.attachments)
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

        case .undoComplete(let undoMsg):
            guard belongsToSession(undoMsg.sessionId) else { return }
            // Remove all messages after the last user message (the assistant
            // exchange that was regenerated). The daemon will immediately start
            // streaming a new response.
            if let lastUserIndex = messages.lastIndex(where: { $0.role == .user }) {
                messages.removeSubrange((lastUserIndex + 1)...)
            }
            currentAssistantMessageId = nil

        case .generationCancelled(let cancelled):
            guard belongsToSession(cancelled.sessionId) else { return }
            cancelTimeoutTask?.cancel()
            cancelTimeoutTask = nil
            let wasCancelling = isCancelling
            isCancelling = false
            isThinking = false
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
            // Must run before currentAssistantMessageId is cleared so attachments land on the right message
            ingestAssistantAttachments(handoff.attachments)
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
            // When a cancellation-related generic error arrives while we are
            // in cancel mode, force-clear queue bookkeeping because queued
            // messages will not be processed and no message_dequeued events
            // are expected for them.
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
                scopeOptions: msg.scopeOptions,
                executionTarget: msg.executionTarget
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
                messages[msgIndex].toolCalls[tcIndex].imageData = msg.imageData
                messages[msgIndex].toolCalls[tcIndex].cachedImage = ToolCallData.decodeImage(from: msg.imageData)
            }

        case .uiSurfaceShow(let msg):
            guard belongsToSession(msg.sessionId) else { return }
            guard msg.display == nil || msg.display == "inline" else { break }
            guard let surface = Surface.from(msg) else { break }

            // Route dynamic pages to workspace instead of inline chat
            if case .dynamicPage = surface.data {
                isThinking = false
                NotificationCenter.default.post(
                    name: Notification.Name("MainWindow.openDynamicWorkspace"),
                    object: nil,
                    userInfo: ["surfaceMessage": msg]
                )
                break
            }

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
            } else if let lastUserIndex = messages.lastIndex(where: { $0.role == .user }),
                      let idx = messages[lastUserIndex...].lastIndex(where: { $0.role == .assistant }) {
                // Scope to the current turn so we never attach to an assistant message
                // from a previous conversation turn.
                messages[idx].inlineSurfaces.append(inlineSurface)
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

        case .sessionError(let msg):
            guard sessionId != nil, belongsToSession(msg.sessionId) else { return }
            log.error("Session error [\(msg.code.rawValue)]: \(msg.userMessage)")
            // Mirror the same UI reset as the generic .error handler so the
            // chat doesn't get stuck in a sending/thinking state.
            isThinking = false
            let wasCancelling = isCancelling
            isCancelling = false
            if let existingId = currentAssistantMessageId,
               let index = messages.firstIndex(where: { $0.id == existingId }) {
                messages[index].isStreaming = false
            }
            currentAssistantMessageId = nil
            // When the user intentionally cancelled, suppress both the typed
            // session error and the errorText so no toast appears.
            if !wasCancelling {
                let typedError = SessionError(from: msg)
                sessionError = typedError
                errorText = msg.userMessage
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
                for i in messages.indices {
                    if case .queued = messages[i].status, messages[i].role == .user {
                        messages[i].status = .sent
                    }
                }
            } else if pendingQueuedCount == 0 {
                isSending = false
                pendingMessageIds = []
                requestIdToMessageId = [:]
            }

        default:
            break
        }
    }

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

    public func stopGenerating() {
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

    public func dismissError() {
        sessionError = nil
        errorText = nil
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
        // Dismiss the corresponding floating panel if one exists
        onInlineConfirmationResponse?(requestId)
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

    /// Map IPC attachment DTOs to ChatAttachment values, generating thumbnails for images.
    private func mapIPCAttachments(_ ipcAttachments: [IPCUserMessageAttachment]) -> [ChatAttachment] {
        ipcAttachments.compactMap { ipc in
            let id = ipc.id ?? UUID().uuidString
            let base64 = ipc.data
            let dataLength = base64.count

            var thumbnailData: Data?
            #if os(macOS)
            var thumbnailImage: NSImage?
            #elseif os(iOS)
            var thumbnailImage: UIImage?
            #else
            #error("Unsupported platform")
            #endif

            if ipc.mimeType.hasPrefix("image/"), let rawData = Data(base64Encoded: base64) {
                thumbnailData = Self.generateThumbnail(from: rawData, maxDimension: 120)
                #if os(macOS)
                thumbnailImage = thumbnailData.flatMap { NSImage(data: $0) }
                #elseif os(iOS)
                thumbnailImage = thumbnailData.flatMap { UIImage(data: $0) }
                #endif
            }

            return ChatAttachment(
                id: id,
                filename: ipc.filename,
                mimeType: ipc.mimeType,
                data: base64,
                thumbnailData: thumbnailData,
                dataLength: dataLength,
                thumbnailImage: thumbnailImage
            )
        }
    }

    /// Ingest attachments from a completion/handoff event into the current or new assistant message.
    private func ingestAssistantAttachments(_ ipcAttachments: [IPCUserMessageAttachment]?) {
        guard let ipcAttachments, !ipcAttachments.isEmpty else { return }
        let chatAttachments = mapIPCAttachments(ipcAttachments)
        guard !chatAttachments.isEmpty else { return }

        if let existingId = currentAssistantMessageId,
           let index = messages.firstIndex(where: { $0.id == existingId }) {
            messages[index].attachments.append(contentsOf: chatAttachments)
        } else {
            let msg = ChatMessage(role: .assistant, text: "", attachments: chatAttachments)
            currentAssistantMessageId = msg.id
            messages.append(msg)
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
            if let historyToolCalls = item.toolCalls {
                toolCalls = historyToolCalls.map { tc in
                    ToolCallData(
                        toolName: toolDisplayName(tc.name),
                        inputSummary: summarizeToolInput(tc.input),
                        result: tc.result,
                        isError: tc.isError ?? false,
                        isComplete: true,
                        imageData: tc.imageData
                    )
                }
            }
            let attachments: [ChatAttachment] = mapIPCAttachments(item.attachments ?? [])
            // Skip empty messages (internal tool-result-only turns already filtered by daemon)
            if item.text.isEmpty && toolCalls.isEmpty && attachments.isEmpty { continue }
            let timestamp = Date(timeIntervalSince1970: TimeInterval(item.timestamp) / 1000.0)
            let chatMsg = ChatMessage(
                role: role,
                text: item.text,
                timestamp: timestamp,
                attachments: attachments,
                toolCalls: toolCalls
            )
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
    }

    deinit {
        messageLoopTask?.cancel()
    }
}
