import Foundation
import os
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#else
#error("Unsupported platform")
#endif

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ChatViewModel+MessageHandling")

// MARK: - Message Handling

extension ChatViewModel {

    /// Returns true if the given session ID belongs to this chat session.
    /// Messages with a nil sessionId are always accepted; messages whose
    /// sessionId doesn't match the current session are silently ignored
    /// to prevent cross-session contamination (e.g. from a popover text_qa flow).
    func belongsToSession(_ messageSessionId: String?) -> Bool {
        guard let messageSessionId else { return true }
        guard let sessionId else {
            // No session established yet — accept all messages
            return true
        }
        return messageSessionId == sessionId
    }

    /// Priority list of input keys whose values are most useful as a tool call summary.
    static let toolInputPriorityKeys = [
        "command", "file_path", "path", "query", "url", "pattern", "glob"
    ]

    /// Extract the most relevant tool input value as a full string (no truncation).
    /// Redacts values for sensitive keys to prevent credential leakage into inputSummary.
    func extractToolInput(_ input: [String: AnyCodable]) -> String {
        // Pick the first matching priority key, falling back to the first sorted key.
        let key: String
        let value: AnyCodable
        if let match = Self.toolInputPriorityKeys.first(where: { input[$0] != nil }),
           let v = input[match] {
            key = match
            value = v
        } else if let firstKey = input.keys.sorted().first, let v = input[firstKey] {
            key = firstKey
            value = v
        } else {
            return ""
        }
        // Redact sensitive keys before returning
        if Self.isSensitiveKey(key) {
            return "[redacted]"
        }
        if let s = value.value as? String {
            return s
        } else if let encoder = try? JSONEncoder().encode(value),
                  let json = String(data: encoder, encoding: .utf8) {
            return json
        } else {
            return String(describing: value.value ?? "")
        }
    }

    /// Summarize tool input for display, picking the most relevant value truncated to 80 chars.
    func summarizeToolInput(_ input: [String: AnyCodable]) -> String {
        let str = extractToolInput(input)
        return str.count > 80 ? String(str.prefix(77)) + "..." : str
    }

    /// Argument keys whose values may contain credentials and must be redacted.
    /// All comparisons use lowercased keys to catch variants like accessToken,
    /// Authorization, X-API-KEY, etc.
    private static let sensitiveKeys: Set<String> = [
        "value", "secret", "password", "token", "client_secret", "api_key",
        "authorization", "access_token", "refresh_token", "api_secret",
        "accesstoken", "refreshtoken", "apikey", "apisecret", "clientsecret",
        "x-api-key"
    ]

    /// Case-insensitive check: does the given key match any sensitive key?
    private static func isSensitiveKey(_ key: String) -> Bool {
        sensitiveKeys.contains(key.lowercased())
    }

    /// Format all tool input arguments for display in expanded details.
    /// The primary value comes first, then remaining keys as `key: value` lines.
    /// Sensitive keys (passwords, tokens, etc.) are redacted to prevent credential exposure.
    func formatAllToolInput(_ input: [String: AnyCodable]) -> String {
        guard !input.isEmpty else { return "" }

        // Find the primary key (same logic as extractToolInput)
        let primaryKey = Self.toolInputPriorityKeys.first(where: { input[$0] != nil })
            ?? input.keys.sorted().first

        var lines: [String] = []

        // Primary value first (undecorated)
        if let key = primaryKey, let value = input[key] {
            if Self.isSensitiveKey(key) {
                lines.append("[redacted]")
            } else {
                lines.append(redactingStringifyValue(value))
            }
        }

        // Remaining keys sorted alphabetically, redacting sensitive values
        let otherKeys = input.keys
            .filter { $0 != primaryKey }
            .sorted()
        for key in otherKeys {
            guard let value = input[key] else { continue }
            if Self.isSensitiveKey(key) {
                lines.append("\(key): [redacted]")
            } else {
                lines.append("\(key): \(redactingStringifyValue(value))")
            }
        }

        return lines.joined(separator: "\n")
    }

    private func stringifyValue(_ value: AnyCodable) -> String {
        if let s = value.value as? String { return s }
        if let b = value.value as? Bool { return b ? "true" : "false" }
        if let n = value.value as? Int { return String(n) }
        if let n = value.value as? Double { return String(n) }
        if let encoder = try? JSONEncoder().encode(value),
           let json = String(data: encoder, encoding: .utf8) {
            return json
        }
        return String(describing: value.value ?? "")
    }

    /// Stringify a value, recursively redacting sensitive keys in nested objects.
    private func redactingStringifyValue(_ value: AnyCodable) -> String {
        if let dict = value.value as? [String: Any] {
            return redactDictionary(dict)
        }
        if let array = value.value as? [Any] {
            return redactArray(array)
        }
        return stringifyValue(value)
    }

    /// Recursively redact sensitive keys in a dictionary, returning a JSON-like string.
    private func redactDictionary(_ dict: [String: Any]) -> String {
        var redacted: [String: Any] = [:]
        for (key, val) in dict {
            if Self.isSensitiveKey(key) {
                redacted[key] = "[redacted]"
            } else if let nested = val as? [String: Any] {
                redacted[key] = redactDictionaryAsObject(nested)
            } else if let nested = val as? [Any] {
                redacted[key] = redactArrayAsObject(nested)
            } else {
                redacted[key] = val
            }
        }
        // Encode the redacted dict to JSON
        if let data = try? JSONSerialization.data(withJSONObject: redacted, options: [.sortedKeys]),
           let json = String(data: data, encoding: .utf8) {
            return json
        }
        return String(describing: redacted)
    }

    /// Recursively redact sensitive keys in array elements.
    private func redactArray(_ array: [Any]) -> String {
        let redacted = redactArrayAsObject(array)
        if let data = try? JSONSerialization.data(withJSONObject: redacted, options: [.sortedKeys]),
           let json = String(data: data, encoding: .utf8) {
            return json
        }
        return String(describing: redacted)
    }

    /// Recursively redact sensitive keys in array elements, returning an array (not string) for nesting.
    private func redactArrayAsObject(_ array: [Any]) -> [Any] {
        return array.map { element -> Any in
            if let dict = element as? [String: Any] {
                return redactDictionaryAsObject(dict)
            } else if let nested = element as? [Any] {
                return redactArrayAsObject(nested)
            }
            return element
        }
    }

    /// Recursively redact sensitive keys, returning a dictionary (not string) for nesting.
    private func redactDictionaryAsObject(_ dict: [String: Any]) -> [String: Any] {
        var redacted: [String: Any] = [:]
        for (key, val) in dict {
            if Self.isSensitiveKey(key) {
                redacted[key] = "[redacted]"
            } else if let nested = val as? [String: Any] {
                redacted[key] = redactDictionaryAsObject(nested)
            } else if let nested = val as? [Any] {
                redacted[key] = redactArrayAsObject(nested)
            } else {
                redacted[key] = val
            }
        }
        return redacted
    }

    func toolDisplayName(_ name: String) -> String {
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

    /// Extract a code preview from accumulated tool input JSON.
    /// Shows the HTML code as it streams during app_create/app_update.
    static func extractCodePreview(from accumulatedJson: String, toolName: String) -> String? {
        guard !accumulatedJson.isEmpty else { return nil }
        let isAppTool = toolName == "app_create" || toolName == "app_update"
        guard isAppTool else { return nil }

        // Find the html JSON string value by locating the opening quote
        let markers = ["\"html\": \"", "\"html\":\""]
        for marker in markers {
            guard let range = accumulatedJson.range(of: marker) else { continue }
            let afterMarker = accumulatedJson[range.upperBound...]

            // Scan for the closing unescaped quote of the JSON string value
            var result: [Character] = []
            var i = afterMarker.startIndex
            while i < afterMarker.endIndex {
                let ch = afterMarker[i]
                if ch == "\\" {
                    let next = afterMarker.index(after: i)
                    if next < afterMarker.endIndex {
                        // Single-pass unescape: handle the pair
                        switch afterMarker[next] {
                        case "n": result.append("\n")
                        case "t": result.append("\t")
                        case "\"": result.append("\"")
                        case "\\": result.append("\\")
                        default:
                            result.append(ch)
                            result.append(afterMarker[next])
                        }
                        i = afterMarker.index(after: next)
                    } else {
                        // Trailing backslash (incomplete escape at end of stream)
                        break
                    }
                } else if ch == "\"" {
                    // Found the closing quote — stop
                    break
                } else {
                    result.append(ch)
                    i = afterMarker.index(after: i)
                }
            }

            let html = String(result)
            return html.isEmpty ? nil : html
        }

        return nil
    }

    /// Map IPC attachment DTOs to ChatAttachment values, generating thumbnails for images.
    func mapIPCAttachments(_ ipcAttachments: [IPCUserMessageAttachment]) -> [ChatAttachment] {
        ipcAttachments.compactMap { ipc in
            let id = ipc.id ?? UUID().uuidString
            let base64 = ipc.data
            let dataLength = base64.count
            let sizeBytes: Int? = ipc.sizeBytes.flatMap { Int(exactly: $0) }

            var thumbnailData: Data?
            #if os(macOS)
            var thumbnailImage: NSImage?
            #elseif os(iOS)
            var thumbnailImage: UIImage?
            #else
            #error("Unsupported platform")
            #endif

            if ipc.mimeType.hasPrefix("image/"), !base64.isEmpty, let rawData = Data(base64Encoded: base64) {
                thumbnailData = Self.generateThumbnail(from: rawData, maxDimension: 120)
                #if os(macOS)
                thumbnailImage = thumbnailData.flatMap { NSImage(data: $0) }
                #elseif os(iOS)
                thumbnailImage = thumbnailData.flatMap { UIImage(data: $0) }
                #endif
            } else if let serverThumb = ipc.thumbnailData, !serverThumb.isEmpty,
                      let thumbData = Data(base64Encoded: serverThumb) {
                thumbnailData = thumbData
                #if os(macOS)
                thumbnailImage = NSImage(data: thumbData)
                #elseif os(iOS)
                thumbnailImage = UIImage(data: thumbData)
                #endif
            }

            return ChatAttachment(
                id: id,
                filename: ipc.filename,
                mimeType: ipc.mimeType,
                data: base64,
                thumbnailData: thumbnailData,
                dataLength: dataLength,
                sizeBytes: sizeBytes,
                thumbnailImage: thumbnailImage
            )
        }
    }

    /// Ingest attachments from a completion/handoff event into the current or new assistant message.
    func ingestAssistantAttachments(_ ipcAttachments: [IPCUserMessageAttachment]?) {
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
                onSessionCreated?(info.sessionId)
                log.info("Chat session created: \(info.sessionId)")

                // Send the queued user message, or finalize a message-less
                // session create by clearing the bootstrap sending state.
                if let pending = pendingUserMessage {
                    let attachments = pendingUserAttachments
                    pendingUserMessage = nil
                    pendingUserAttachments = nil
                    do {
                        try daemonClient.send(UserMessageMessage(
                            sessionId: info.sessionId,
                            content: pending,
                            attachments: attachments,
                            activeSurfaceId: activeSurfaceId,
                            currentPage: activeSurfaceId != nil ? currentPage : nil
                        ))
                    } catch {
                        log.error("Failed to send queued user_message: \(error.localizedDescription)")
                        isSending = false
                        isThinking = false
                        errorText = "Failed to send message."
                    }
                } else {
                    // Message-less session create (e.g. private thread
                    // pre-allocation) — session is claimed, reset UI state.
                    isSending = false
                    isThinking = false
                }
            }

        case .userMessageEcho(let echo):
            guard belongsToSession(echo.sessionId) else { return }
            let userMsg = ChatMessage(role: .user, text: echo.text, status: .sent)
            messages.append(userMsg)
            isSending = true
            isThinking = true

        case .assistantThinkingDelta:
            // Stay in thinking state
            break

        case .assistantTextDelta(let delta):
            guard belongsToSession(delta.sessionId) else { return }
            guard !isCancelling else { return }
            if isWorkspaceRefinementInFlight {
                refinementTextBuffer += delta.text
                refinementStreamingText = refinementTextBuffer
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
            if let existingId = currentAssistantMessageId,
               let index = messages.firstIndex(where: { $0.id == existingId }) {
                if lastContentWasToolCall || messages[index].textSegments.isEmpty {
                    // Start a new text segment (first text or after a tool call)
                    let segIdx = messages[index].textSegments.count
                    messages[index].textSegments.append(delta.text)
                    messages[index].contentOrder.append(.text(segIdx))
                    lastContentWasToolCall = false
                } else {
                    // Append to the current (last) text segment
                    messages[index].textSegments[messages[index].textSegments.count - 1] += delta.text
                }
            } else {
                // Create new assistant message
                var msg = ChatMessage(role: .assistant, text: delta.text, isStreaming: true)
                if currentTurnUserText == "/model" {
                    msg.modelPicker = ModelPickerData()
                } else if currentTurnUserText == "/models" {
                    msg.modelList = ModelListData()
                } else if currentTurnUserText == "/commands" {
                    msg.commandList = CommandListData()
                }
                currentAssistantMessageId = msg.id
                messages.append(msg)
                lastContentWasToolCall = false
            }

        case .suggestionResponse(let resp):
            // Only accept if this response matches our current request
            guard resp.requestId == pendingSuggestionRequestId else { return }
            pendingSuggestionRequestId = nil
            suggestion = resp.suggestion

        case .messageComplete(let complete):
            guard belongsToSession(complete.sessionId) else { return }
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
                    let responseText = messages[index].textSegments.joined()
                    onVoiceResponseComplete?(responseText)
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
                    DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
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
            // Reset processing messages to sent
            for i in messages.indices {
                if messages[i].role == .user && messages[i].status == .processing {
                    messages[i].status = .sent
                }
            }
            dispatchPendingSendDirect()
            // Skip follow-up suggestions for workspace refinements
            if !isSending && !wasRefinement {
                fetchSuggestion()
            }
            // Notify about completed tool calls
            if let toolCalls = completedToolCalls, let callback = onToolCallsComplete {
                callback(toolCalls)
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
            currentTurnUserText = nil
            currentAssistantHasText = false
            lastContentWasToolCall = false

        case .generationCancelled(let cancelled):
            guard belongsToSession(cancelled.sessionId) else { return }
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
            }
            currentAssistantMessageId = nil
            currentTurnUserText = nil
            currentAssistantHasText = false
            lastContentWasToolCall = false
            // Reset processing messages to sent
            for i in messages.indices {
                if messages[i].role == .user && messages[i].status == .processing {
                    messages[i].status = .sent
                }
            }
            dispatchPendingSendDirect()

        case .messageQueued(let queued):
            guard belongsToSession(queued.sessionId) else { return }
            pendingQueuedCount += 1
            // Associate this requestId with the oldest pending user message
            if let messageId = pendingMessageIds.first {
                pendingMessageIds.removeFirst()
                requestIdToMessageId[queued.requestId] = messageId
                // If the user deleted this message before the ack arrived,
                // forward the deletion to the daemon now that we have the requestId.
                if pendingLocalDeletions.remove(messageId) != nil {
                    do {
                        try daemonClient.send(DeleteQueuedMessageMessage(sessionId: queued.sessionId, requestId: queued.requestId))
                    } catch {
                        log.error("Failed to send deferred delete_queued_message: \(error.localizedDescription)")
                    }
                } else if let index = messages.firstIndex(where: { $0.id == messageId }) {
                    messages[index].status = .queued(position: queued.position)
                }
            }

        case .messageQueuedDeleted(let msg):
            guard belongsToSession(msg.sessionId) else { return }
            pendingQueuedCount = max(0, pendingQueuedCount - 1)
            // Remove the message from the UI
            if let messageId = requestIdToMessageId.removeValue(forKey: msg.requestId) {
                messages.removeAll { $0.id == messageId }
            }
            // Recompute positions for remaining queued messages
            var queuePosition = 0
            for i in messages.indices {
                if case .queued = messages[i].status {
                    messages[i].status = .queued(position: queuePosition)
                    queuePosition += 1
                }
            }
            if pendingQueuedCount == 0 && !isThinking {
                isSending = false
            }

        case .messageDequeued(let msg):
            guard belongsToSession(msg.sessionId) else { return }
            pendingQueuedCount = max(0, pendingQueuedCount - 1)
            // Mark the associated user message as processing and track its text
            // so assistantTextDelta tags the response correctly.
            if let messageId = requestIdToMessageId.removeValue(forKey: msg.requestId),
               let index = messages.firstIndex(where: { $0.id == messageId }) {
                // Move the dequeued message to the end so it appears after the
                // agent's response to the previous message, preserving chronological order.
                var message = messages.remove(at: index)
                message.status = .processing
                message.timestamp = Date()
                messages.append(message)
                currentTurnUserText = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
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
                messages[index].streamingCodePreview = nil
                messages[index].streamingCodeToolName = nil
            }
            currentAssistantMessageId = nil
            currentTurnUserText = nil
            currentAssistantHasText = false
            lastContentWasToolCall = false
            // Reset processing messages to sent
            for i in messages.indices {
                if messages[i].role == .user && messages[i].status == .processing {
                    messages[i].status = .sent
                }
            }

        case .error(let err):
            log.error("Server error: \(err.message)")
            // Only process errors relevant to this chat session. Generic daemon
            // errors (e.g., IPC validation failures from unrelated message types
            // like work_item_delete) should not pollute the chat UI.
            guard isSending || isThinking || isCancelling || currentAssistantMessageId != nil || isWorkspaceRefinementInFlight else {
                return
            }
            isWorkspaceRefinementInFlight = false
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
            // Mark current assistant message as no longer streaming
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
            if !wasCancelling {
                errorText = err.message
                // When the backend blocks a message for containing secrets,
                // stash the full send context so "Send Anyway" can reconstruct
                // the original UserMessageMessage with attachments and surface metadata.
                if err.category == "secret_blocked" {
                    // Prefer the snapshotted turn text (the text that was actually sent)
                    // over the transcript lookup, which can miss workspace refinements
                    // that don't append a user chat message.
                    if let sendText = savedTurnUserText {
                        secretBlockedMessageText = sendText
                    } else if let lastUserMsg = messages.last(where: { $0.role == .user }) {
                        secretBlockedMessageText = lastUserMsg.text
                    }
                    // Reconstruct IPC attachments from the last user message's ChatAttachments
                    if let lastUserMsg = messages.last(where: { $0.role == .user }),
                       !lastUserMsg.attachments.isEmpty {
                        secretBlockedAttachments = lastUserMsg.attachments.map {
                            IPCAttachment(filename: $0.filename, mimeType: $0.mimeType, data: $0.data, extractedText: nil)
                        }
                    }
                    secretBlockedActiveSurfaceId = activeSurfaceId
                    secretBlockedCurrentPage = currentPage
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
                persistentDecisionsAllowed: msg.persistentDecisionsAllowed ?? true
            )
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

        case .toolUseStart(let msg):
            guard belongsToSession(msg.sessionId) else { return }
            guard !isCancelling else { return }
            guard !isWorkspaceRefinementInFlight else { return }
            lastToolUseReceivedAt = Date()
            // Suppress ToolCallChip for ui_show — the inline surface widget replaces it.
            if msg.toolName == "ui_show" || msg.toolName == "ui_update" || msg.toolName == "ui_dismiss" || msg.toolName == "request_file" {
                break
            }
            // Tool chip is now visible — hide the thinking indicator
            isThinking = false
            // Extract building status for app tools
            let buildingStatus: String? = {
                let appTools: Set<String> = ["app_create", "app_update", "app_file_edit", "app_file_write"]
                guard appTools.contains(msg.toolName) else { return nil }
                if let status = msg.input["status"]?.value as? String, !status.isEmpty {
                    return status
                }
                // Fallback status for file tools only; app_create/app_update
                // rely on friendlyRunningLabel + progressive label cycling
                switch msg.toolName {
                case "app_file_edit": return "Editing app files"
                case "app_file_write": return "Writing app files"
                default: return nil
                }
            }()
            var toolCall = ToolCallData(
                toolName: msg.toolName,
                inputSummary: summarizeToolInput(msg.input),
                inputFull: formatAllToolInput(msg.input),
                arrivedBeforeText: !currentAssistantHasText,
                startedAt: Date()
            )
            toolCall.buildingStatus = buildingStatus
            // Add to existing assistant message or create one
            if let existingId = currentAssistantMessageId,
               let index = messages.firstIndex(where: { $0.id == existingId }) {
                let tcIdx = messages[index].toolCalls.count
                messages[index].toolCalls.append(toolCall)
                messages[index].contentOrder.append(.toolCall(tcIdx))
            } else {
                var newMsg = ChatMessage(role: .assistant, text: "", isStreaming: true, toolCalls: [toolCall])
                newMsg.contentOrder = [.toolCall(0)]
                currentAssistantMessageId = newMsg.id
                messages.append(newMsg)
            }
            lastContentWasToolCall = true

        case .toolInputDelta(let msg):
            guard belongsToSession(msg.sessionId) else { return }
            guard !isCancelling else { return }
            let preview = Self.extractCodePreview(from: msg.content, toolName: msg.toolName)
            if let existingId = currentAssistantMessageId,
               let msgIndex = messages.firstIndex(where: { $0.id == existingId }) {
                messages[msgIndex].streamingCodePreview = preview
                messages[msgIndex].streamingCodeToolName = msg.toolName
            } else {
                var newMsg = ChatMessage(role: .assistant, text: "", isStreaming: true)
                newMsg.streamingCodePreview = preview
                newMsg.streamingCodeToolName = msg.toolName
                currentAssistantMessageId = newMsg.id
                messages.append(newMsg)
            }

        case .toolOutputChunk:
            // Streaming output — ignore for now, we show the final result
            break

        case .toolResult(let msg):
            guard belongsToSession(msg.sessionId) else { return }
            guard !isCancelling else { return }
            guard !isWorkspaceRefinementInFlight else { return }
            // Find the most recent pending (incomplete) tool call and mark it complete
            if let existingId = currentAssistantMessageId,
               let msgIndex = messages.firstIndex(where: { $0.id == existingId }),
               let tcIndex = messages[msgIndex].toolCalls.lastIndex(where: { !$0.isComplete }) {
                let truncatedResult = msg.result.count > 2000 ? String(msg.result.prefix(2000)) + "...[truncated]" : msg.result
                messages[msgIndex].toolCalls[tcIndex].result = truncatedResult
                messages[msgIndex].toolCalls[tcIndex].isError = msg.isError ?? false
                messages[msgIndex].toolCalls[tcIndex].isComplete = true
                messages[msgIndex].toolCalls[tcIndex].completedAt = Date()
                messages[msgIndex].toolCalls[tcIndex].imageData = msg.imageData
                messages[msgIndex].toolCalls[tcIndex].cachedImage = ToolCallData.decodeImage(from: msg.imageData)
                if let status = msg.status, !status.isEmpty {
                    messages[msgIndex].toolCalls[tcIndex].buildingStatus = status
                }
            }
            // Tool completed — agent is now processing the result. Show
            // thinking indicator until the next text delta or tool starts.
            if isSending && !isCancelling {
                isThinking = true
            }

        case .uiSurfaceShow(let msg):
            log.info("Received ui_surface_show: surfaceId=\(msg.surfaceId), messageId=\(msg.messageId ?? "nil"), display=\(msg.display ?? "nil")")
            log.info("Current messages count: \(self.messages.count), IDs: \(self.messages.map { $0.id.uuidString }.joined(separator: ", "))")
            guard belongsToSession(msg.sessionId) else {
                log.info("Skipping surface - wrong session")
                return
            }
            guard msg.display == nil || msg.display == "inline" || msg.display == "panel" else {
                log.info("Skipping surface - display mode is '\(msg.display ?? "nil")'")
                break
            }
            guard let surface = Surface.from(msg) else {
                log.info("Skipping surface - failed to create Surface from message")
                break
            }

            // On macOS, dynamic pages with no explicit display mode (or "panel")
            // are routed to the workspace by SurfaceManager. If the dynamic page
            // has a preview, also render a compact preview card inline in chat.
            // On iOS there is no workspace, so dynamic pages always render inline.
            #if os(macOS)
            if case .dynamicPage(let dpData) = surface.data, msg.display == nil || msg.display == "panel" {
                isThinking = false
                // Only render inline preview if the dynamic page has preview metadata
                guard dpData.preview != nil else {
                    log.info("Skipping inline surface - no preview metadata")
                    break
                }
            }
            #endif

            isThinking = false
            let inlineSurface = InlineSurfaceData(
                id: surface.id,
                surfaceType: surface.type,
                title: surface.title,
                data: surface.data,
                actions: surface.actions,
                surfaceMessage: msg
            )

            // If messageId is provided, attach to that specific message (rarely used now that
            // surfaces come directly in history_response, but kept for backwards compatibility)
            if let messageId = msg.messageId,
               let messageUUID = UUID(uuidString: messageId),
               let index = messages.firstIndex(where: { $0.id == messageUUID }) {
                log.info("Attaching surface to message by messageId: \(messageId)")
                let surfIdx = messages[index].inlineSurfaces.count
                messages[index].inlineSurfaces.append(inlineSurface)
                messages[index].contentOrder.append(.surface(surfIdx))
            } else if let existingId = currentAssistantMessageId,
               let index = messages.firstIndex(where: { $0.id == existingId }) {
                log.info("Attaching surface to currentAssistantMessage: \(existingId)")
                let surfIdx = messages[index].inlineSurfaces.count
                messages[index].inlineSurfaces.append(inlineSurface)
                messages[index].contentOrder.append(.surface(surfIdx))
                lastContentWasToolCall = true
            } else if let lastUserIndex = messages.lastIndex(where: { $0.role == .user }),
                      let idx = messages[lastUserIndex...].lastIndex(where: { $0.role == .assistant }) {
                // Scope to the current turn so we never attach to an assistant message
                // from a previous conversation turn.
                log.info("Attaching surface to last assistant message in current turn")
                let surfIdx = messages[idx].inlineSurfaces.count
                messages[idx].inlineSurfaces.append(inlineSurface)
                messages[idx].contentOrder.append(.surface(surfIdx))
                lastContentWasToolCall = true
            } else {
                log.info("Creating new assistant message for surface")
                var newMsg = ChatMessage(role: .assistant, text: "", isStreaming: true, inlineSurfaces: [inlineSurface])
                newMsg.contentOrder = [.surface(0)]
                currentAssistantMessageId = newMsg.id
                messages.append(newMsg)
            }

        case .uiSurfaceUndoResult(let msg):
            guard belongsToSession(msg.sessionId) else { return }
            surfaceUndoCount = msg.remainingUndos

        case .uiSurfaceUpdate(let msg):
            guard belongsToSession(msg.sessionId) else { return }
            if isWorkspaceRefinementInFlight {
                refinementReceivedSurfaceUpdate = true
            }
            if msg.surfaceId == activeSurfaceId {
                surfaceUndoCount += 1
            }
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
                            actions: updated.actions,
                            surfaceMessage: existing.surfaceMessage
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

        case .uiSurfaceComplete(let msg):
            guard belongsToSession(msg.sessionId) else { return }
            // Find the inline surface across all messages and set its completionState
            for msgIndex in messages.indices {
                if let surfaceIndex = messages[msgIndex].inlineSurfaces.firstIndex(where: { $0.id == msg.surfaceId }) {
                    messages[msgIndex].inlineSurfaces[surfaceIndex].completionState = SurfaceCompletionState(
                        summary: msg.summary,
                        submittedData: msg.submittedData
                    )
                    return
                }
            }

        case .sessionError(let msg):
            guard sessionId != nil, belongsToSession(msg.sessionId) else { return }
            log.error("Session error [\(msg.code.rawValue)]: \(msg.userMessage)")
            isWorkspaceRefinementInFlight = false
            refinementMessagePreview = nil
            refinementStreamingText = nil
            cancelledDuringRefinement = false
            isThinking = false
            pendingVoiceMessage = false
            let wasCancelling = isCancelling
            isCancelling = false
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
            // When the user intentionally cancelled, suppress the error.
            // Otherwise, insert an inline error message so errors are visually
            // distinct from normal assistant replies (rendered with a red box).
            if !wasCancelling {
                let typedError = SessionError(from: msg)
                sessionError = typedError
                errorText = msg.userMessage
                // Remove empty assistant message left over from the interrupted stream
                if let existingId = messages.last?.id,
                   messages.last?.role == .assistant,
                   messages.last?.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == true,
                   messages.last?.toolCalls.isEmpty == true {
                    messages.removeAll(where: { $0.id == existingId })
                }
                let errorMsg = ChatMessage(role: .assistant, text: msg.userMessage, isError: true)
                messages.append(errorMsg)
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
            } else {
                // Capture before clearing — surface actions don't set
                // isSending, so this distinguishes user-message sends
                // from surface action rejections.
                let wasSendingUserMessage = isSending
                // Always clear sending state so regenerate is unblocked.
                isSending = false
                // When QUEUE_FULL from a user-message send, the daemon
                // rejected the message — no message_queued will arrive.
                // Remove its stale pending ID so subsequent events don't
                // mis-correlate. Only do this for user-message sends
                // (wasSendingUserMessage), not surface action rejections
                // which never append to pendingMessageIds.
                if msg.code == .queueFull, wasSendingUserMessage, let rejectedId = pendingMessageIds.last {
                    pendingMessageIds.removeLast()
                    if let index = messages.firstIndex(where: { $0.id == rejectedId }) {
                        messages[index].status = .sent
                    }
                }
                if pendingQueuedCount == 0 {
                    // No queued work remains — safe to tear down everything.
                    pendingMessageIds = []
                    requestIdToMessageId = [:]
                } else {
                    // The daemon drains queued work after a session_error
                    // (session.ts calls drainQueue in `finally`), so preserve
                    // pendingQueuedCount, pendingMessageIds, requestIdToMessageId,
                    // and queued message statuses. Incoming message_dequeued events
                    // need requestIdToMessageId to correlate to user messages.
                    // messageDequeued will re-set isSending=true when the next
                    // queued message starts processing.
                }
            }

        case .watchStarted(let msg):
            guard belongsToSession(msg.sessionId) else { return }
            isWatchSessionActive = true
            onWatchStarted?(msg, daemonClient)

        case .watchCompleteRequest(let msg):
            guard belongsToSession(msg.sessionId) else { return }
            isWatchSessionActive = false
            onWatchCompleteRequest?(msg)

        case .subagentSpawned(let msg):
            guard belongsToSession(msg.parentSessionId) else { return }
            let info = SubagentInfo(id: msg.subagentId, label: msg.label, status: .running, parentMessageId: currentAssistantMessageId)
            activeSubagents.append(info)

        case .subagentStatusChanged(let msg):
            if let index = activeSubagents.firstIndex(where: { $0.id == msg.subagentId }) {
                activeSubagents[index].status = SubagentStatus(wire: msg.status)
                activeSubagents[index].error = msg.error
            }

        case .subagentEvent:
            // Subagent internal events (assistant_message, tool_use, etc.) carry the
            // subagent's session ID, not the parent's, so they cannot be routed through
            // the normal belongsToSession-guarded handlers. These will be displayed in
            // the dedicated subagents panel once it's built.
            break

        case .modelInfo(let msg):
            selectedModel = msg.model
            if let providers = msg.configuredProviders {
                configuredProviders = Set(providers)
            }

        default:
            break
        }
    }
}
