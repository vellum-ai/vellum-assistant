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

    /// Returns true if the given conversation ID belongs to this chat conversation.
    /// Messages with a nil conversationId are always accepted; messages whose
    /// conversationId doesn't match the current conversation are silently ignored
    /// to prevent cross-conversation contamination (e.g. from a popover text_qa flow).
    func belongsToConversation(_ messageConversationId: String?) -> Bool {
        guard let messageConversationId else { return true }
        guard let conversationId else {
            // No conversation established yet — accept all messages
            return true
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

    /// Priority list of input keys whose values are most useful as a tool call summary.
    static let toolInputPriorityKeys = [
        "command", "file_path", "path", "query", "url", "pattern", "glob"
    ]

    /// Substrings that indicate a tool failed because the OS denied permission.
    /// This lets the UI reconcile "allowed" confirmations that still fail at
    /// execution time (for example: user clicked Always Allow, then denied the
    /// macOS Accessibility prompt).
    private static let osPermissionDeniedIndicators: [String] = [
        "accessibility permission not granted",
        "accessibility permission denied",
        "screen recording permission denied",
        "full disk access",
        "operation not permitted",
        "permission denied",
        "not authorized"
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
    /// Primary key is listed first, then remaining keys alphabetically. All as `key: value`.
    /// Sensitive keys (passwords, tokens, etc.) are redacted to prevent credential exposure.
    func formatAllToolInput(_ input: [String: AnyCodable]) -> String {
        guard !input.isEmpty else { return "" }

        // Find the primary key (same logic as extractToolInput)
        let primaryKey = Self.toolInputPriorityKeys.first(where: { input[$0] != nil })
            ?? input.keys.sorted().first

        // All keys as "key: value", primary key first then rest alphabetically
        let orderedKeys: [String]
        if let pk = primaryKey {
            orderedKeys = [pk] + input.keys.filter { $0 != pk }.sorted()
        } else {
            orderedKeys = input.keys.sorted()
        }

        var lines: [String] = []
        for key in orderedKeys {
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
    /// Shows the HTML code as it streams during app_create/app_refresh/app_update.
    static func extractCodePreview(from accumulatedJson: String, toolName: String) -> String? {
        guard !accumulatedJson.isEmpty else { return nil }
        let isAppTool = toolName == "app_create" || toolName == "app_refresh" || toolName == "app_update"
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

    /// Map attachment DTOs to ChatAttachment values, generating thumbnails for images.
    func mapMessageAttachments(_ attachments: [UserMessageAttachment]) -> [ChatAttachment] {
        attachments.compactMap { attachment in
            let id = attachment.id ?? UUID().uuidString
            let base64 = attachment.data
            let dataLength = base64.count
            let sizeBytes: Int? = attachment.sizeBytes.flatMap { Int(exactly: $0) }

            var thumbnailData: Data?
            #if os(macOS)
            var thumbnailImage: NSImage?
            #elseif os(iOS)
            var thumbnailImage: UIImage?
            #else
            #error("Unsupported platform")
            #endif

            if attachment.mimeType.hasPrefix("image/"), !base64.isEmpty, let rawData = Data(base64Encoded: base64) {
                thumbnailData = Self.generateThumbnail(from: rawData, maxDimension: 120)
                #if os(macOS)
                thumbnailImage = thumbnailData.flatMap { NSImage(data: $0) }
                #elseif os(iOS)
                thumbnailImage = thumbnailData.flatMap { UIImage(data: $0) }
                #endif
            } else if let serverThumb = attachment.thumbnailData, !serverThumb.isEmpty,
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
                filename: attachment.filename,
                mimeType: attachment.mimeType,
                data: base64,
                thumbnailData: thumbnailData,
                dataLength: dataLength,
                sizeBytes: sizeBytes,
                thumbnailImage: thumbnailImage,
                filePath: attachment.filePath,
                sourceType: attachment.sourceType
            )
        }
    }

    /// Ingest attachments from a completion/handoff event into the current or new assistant message.
    func ingestAssistantAttachments(_ attachments: [UserMessageAttachment]?) {
        guard let attachments, !attachments.isEmpty else { return }
        let chatAttachments = mapMessageAttachments(attachments)
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

    /// Ingest attachment warnings from a completion/handoff event into the
    /// current or new assistant message.
    func ingestAssistantAttachmentWarnings(_ warnings: [String]?) {
        guard let warnings, !warnings.isEmpty else { return }

        if let existingId = currentAssistantMessageId,
           let index = messages.firstIndex(where: { $0.id == existingId }) {
            messages[index].attachmentWarnings.append(contentsOf: warnings)
        } else {
            let msg = ChatMessage(role: .assistant, text: "", attachmentWarnings: warnings)
            currentAssistantMessageId = msg.id
            messages.append(msg)
        }
    }

    /// Returns true when a tool error string looks like a macOS/TCC permission denial.
    private static func isOSPermissionDeniedError(_ result: String) -> Bool {
        let normalized = result.lowercased()
        return osPermissionDeniedIndicators.contains { normalized.contains($0) }
    }

    /// If the user approved a confirmation but execution still failed due OS
    /// permission denial, update the nearby confirmation so the UI does not
    /// incorrectly show it as approved.
    private func downgradeAdjacentApprovedConfirmationForPermissionDeniedError(
        assistantMessageIndex: Int,
        toolResult: String,
        isError: Bool
    ) {
        guard isError, Self.isOSPermissionDeniedError(toolResult) else { return }

        var index = assistantMessageIndex + 1
        while index < messages.count {
            // Stay within this turn.
            if messages[index].role == .user { break }

            guard messages[index].confirmation != nil else {
                index += 1
                continue
            }

            if messages[index].confirmation?.state == .approved {
                messages[index].confirmation?.state = .denied
            }
            return
        }
    }

    // MARK: - Streaming Delta Throttle

    /// Cancel any pending flush and discard buffered text.
    /// Called on every path that clears `currentAssistantMessageId` without
    /// a normal `messageComplete` (cancel, error, handoff, reconnect, etc.)
    /// to prevent a stale flush from creating an orphan assistant message.
    func discardStreamingBuffer() {
        streamingFlushTask?.cancel()
        streamingFlushTask = nil
        streamingDeltaBuffer = ""
    }

    /// Flush any buffered streaming text into the messages array.
    /// Called on a timer and also eagerly on `messageComplete`.
    func flushStreamingBuffer() {
        // Always clear the task reference so scheduleStreamingFlush() can
        // schedule a new flush even if the buffer was empty this time.
        streamingFlushTask?.cancel()
        streamingFlushTask = nil
        guard !streamingDeltaBuffer.isEmpty else { return }
        let buffered = streamingDeltaBuffer
        streamingDeltaBuffer = ""

        if let existingId = currentAssistantMessageId,
           let index = messages.firstIndex(where: { $0.id == existingId }) {
            if lastContentWasToolCall || messages[index].textSegments.isEmpty {
                let segIdx = messages[index].textSegments.count
                messages[index].textSegments.append(buffered)
                messages[index].contentOrder.append(.text(segIdx))
                lastContentWasToolCall = false
            } else {
                messages[index].textSegments[messages[index].textSegments.count - 1] += buffered
            }
        } else if currentAssistantMessageId != nil {
            // Message ID is set but message not found — stale reference after
            // history replacement or reconnect. Discard the buffer to avoid
            // creating an orphan message.
            log.warning("Stale currentAssistantMessageId \(self.currentAssistantMessageId!.uuidString) — discarding \(buffered.count) buffered chars")
            currentAssistantMessageId = nil
            return
        } else {
            // No existing assistant message — create a new one (first text delta)
            var msg = ChatMessage(role: .assistant, text: buffered, isStreaming: true)
            if currentTurnUserText == "/models" {
                msg.modelList = ModelListData()
            } else if currentTurnUserText == "/commands" {
                msg.commandList = CommandListData()
            }
            currentAssistantMessageId = msg.id
            messages.append(msg)
            lastContentWasToolCall = false
        }
    }

    /// Schedule a flush after the throttle interval if one isn't already pending.
    private func scheduleStreamingFlush() {
        guard streamingFlushTask == nil else { return }
        streamingFlushTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Self.streamingFlushInterval * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.flushStreamingBuffer()
        }
    }

    // MARK: - Partial Output Coalescing

    /// Flush buffered partial-output chunks into the `messages` array.
    /// Called on a timer and eagerly on `messageComplete` / `toolResult`.
    func flushPartialOutputBuffer() {
        partialOutputFlushTask?.cancel()
        partialOutputFlushTask = nil
        guard !partialOutputBuffer.isEmpty else { return }
        let buffered = partialOutputBuffer
        partialOutputBuffer = [:]
        let maxPartialOutput = 5000
        for (_, entry) in buffered {
            let tcIndex = entry.tcIndex
            guard let msgIndex = messages.firstIndex(where: { $0.id == entry.messageId }),
                  tcIndex < messages[msgIndex].toolCalls.count else { continue }
            messages[msgIndex].toolCalls[tcIndex].partialOutput.append(entry.content)
            if messages[msgIndex].toolCalls[tcIndex].partialOutput.count > maxPartialOutput {
                let excess = messages[msgIndex].toolCalls[tcIndex].partialOutput.count - maxPartialOutput
                messages[msgIndex].toolCalls[tcIndex].partialOutput.removeFirst(excess)
            }
            messages[msgIndex].toolCalls[tcIndex].partialOutputRevision += 1
        }
    }

    /// Discard any buffered partial-output chunks without flushing.
    func discardPartialOutputBuffer() {
        partialOutputFlushTask?.cancel()
        partialOutputFlushTask = nil
        partialOutputBuffer = [:]
    }

    /// Schedule a partial-output flush after the throttle interval if one isn't already pending.
    private func schedulePartialOutputFlush() {
        guard partialOutputFlushTask == nil else { return }
        partialOutputFlushTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Self.streamingFlushInterval * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.flushPartialOutputBuffer()
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
                    do {
                        let pttMeta = ChatViewModel.currentPttMetadata()
                        try daemonClient.send(UserMessageMessage(
                            conversationId: info.conversationId,
                            content: pending,
                            attachments: attachments,
                            activeSurfaceId: activeSurfaceId,
                            currentPage: activeSurfaceId != nil ? currentPage : nil,
                            pttActivationKey: pttMeta.activationKey,
                            microphonePermissionGranted: pttMeta.microphonePermissionGranted,
                            automated: automated ? true : nil
                        ))
                    } catch {
                        log.error("Failed to send queued user_message: \(error.localizedDescription)")
                        isSending = false
                        isThinking = false
                        errorText = "Failed to send message."
                    }
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
            // Backfill the daemon's persisted message ID so diagnostics exports
            // can anchor to it without requiring a history reload.
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
            // Reset processing messages to sent and drop attachment base64 data
            // for lazy-loadable attachments (sizeBytes != nil means the daemon can
            // re-serve them). Locally-added attachments (sizeBytes == nil) keep their
            // data because openImageInPreview / saveFileAttachment rely on it.
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
                        if !success {
                            log.error("Failed to send deferred delete_queued_message")
                        }
                    }
                } else if let index = messages.firstIndex(where: { $0.id == messageId }) {
                    messages[index].status = .queued(position: queued.position)
                }
            }

        case .messageQueuedDeleted(let msg):
            guard belongsToConversation(msg.conversationId) else { return }
            pendingQueuedCount = max(0, pendingQueuedCount - 1)
            // Remove the message from the UI
            let messageId = requestIdToMessageId.removeValue(forKey: msg.requestId)
                ?? activeRequestIdToMessageId.removeValue(forKey: msg.requestId)
            if let messageId {
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
                // Backfill the daemon's persisted message ID so diagnostics exports
                // can anchor to it without requiring a history reload.
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
            guard belongsToConversation(msg.conversationId) else { return }
            guard !isCancelling else { return }
            guard !isLoadingHistory else { return }
            guard !isWorkspaceRefinementInFlight else { return }
            // Suppress preview chip for proxy tools — the inline surface widget replaces them.
            if msg.toolName == "ui_show" || msg.toolName == "ui_update" || msg.toolName == "ui_dismiss" {
                break
            }
            // Flush buffered text so it lands before the tool call in content order.
            flushStreamingBuffer()
            flushPartialOutputBuffer()
            // If a chip with the same toolUseId already exists (e.g. toolUseStart
            // arrived before this preview), ignore the late preview.
            if let existingId = currentAssistantMessageId,
               let index = messages.firstIndex(where: { $0.id == existingId }),
               messages[index].toolCalls.contains(where: { $0.toolUseId == msg.toolUseId }) {
                break
            }
            isThinking = false
            var toolCall = ToolCallData(
                toolName: msg.toolName,
                inputSummary: "Preparing...",
                inputFull: "",
                inputRawValue: "",
                arrivedBeforeText: !currentAssistantHasText,
                startedAt: Date()
            )
            toolCall.toolUseId = msg.toolUseId
            // Add to existing assistant message or create one.
            if let existingId = currentAssistantMessageId,
               let index = messages.firstIndex(where: { $0.id == existingId }),
               messages[index].toolCalls.count < 100 {
                let tcIdx = messages[index].toolCalls.count
                messages[index].toolCalls.append(toolCall)
                messages[index].contentOrder.append(.toolCall(tcIdx))
            } else {
                if let existingId = currentAssistantMessageId,
                   let oldIndex = messages.firstIndex(where: { $0.id == existingId }) {
                    messages[oldIndex].isStreaming = false
                }
                var newMsg = ChatMessage(role: .assistant, text: "", isStreaming: true, toolCalls: [toolCall])
                newMsg.contentOrder = [.toolCall(0)]
                currentAssistantMessageId = newMsg.id
                messages.append(newMsg)
            }
            lastContentWasToolCall = true

        case .toolUseStart(let msg):
            guard belongsToConversation(msg.conversationId) else { return }
            guard !isCancelling else { return }
            guard !isLoadingHistory else { return }
            guard !isWorkspaceRefinementInFlight else { return }
            // Flush buffered text so it lands before the tool call in content order.
            flushStreamingBuffer()
            flushPartialOutputBuffer()
            lastToolUseReceivedAt = Date()
            // Suppress ToolCallChip for ui_show — the inline surface widget replaces it.
            if msg.toolName == "ui_show" || msg.toolName == "ui_update" || msg.toolName == "ui_dismiss" {
                break
            }
            // Tool chip is now visible — hide the thinking indicator
            isThinking = false
            // Extract building status for app tools
            let buildingStatus: String? = {
                let appTools: Set<String> = ["app_create", "app_refresh", "app_update"]
                guard appTools.contains(msg.toolName) else { return nil }
                if let status = msg.input["status"]?.value as? String, !status.isEmpty {
                    return status
                }
                // app_create/app_refresh/app_update rely on friendlyRunningLabel + progressive label cycling
                return nil
            }()
            // Upsert by toolUseId: if a preview chip already exists for this tool, update it
            // instead of creating a duplicate.
            if let toolUseId = msg.toolUseId,
               let existingId = currentAssistantMessageId,
               let msgIndex = messages.firstIndex(where: { $0.id == existingId }),
               let tcIndex = messages[msgIndex].toolCalls.firstIndex(where: { $0.toolUseId == toolUseId }) {
                messages[msgIndex].toolCalls[tcIndex].inputSummary = summarizeToolInput(msg.input)
                messages[msgIndex].toolCalls[tcIndex].inputFull = formatAllToolInput(msg.input)
                messages[msgIndex].toolCalls[tcIndex].inputRawValue = extractToolInput(msg.input)
                messages[msgIndex].toolCalls[tcIndex].inputRawDict = msg.input
                messages[msgIndex].toolCalls[tcIndex].buildingStatus = buildingStatus
                messages[msgIndex].toolCalls[tcIndex].reasonDescription = (msg.input["activity"]?.value as? String)
                    ?? (msg.input["reason"]?.value as? String)
                    ?? (msg.input["reasoning"]?.value as? String)
                break
            }
            var toolCall = ToolCallData(
                toolName: msg.toolName,
                inputSummary: summarizeToolInput(msg.input),
                inputFull: formatAllToolInput(msg.input),
                inputRawValue: extractToolInput(msg.input),
                arrivedBeforeText: !currentAssistantHasText,
                startedAt: Date()
            )
            toolCall.buildingStatus = buildingStatus
            toolCall.toolUseId = msg.toolUseId
            toolCall.inputRawDict = msg.input
            toolCall.reasonDescription = (msg.input["activity"]?.value as? String)
                ?? (msg.input["reason"]?.value as? String)
                ?? (msg.input["reasoning"]?.value as? String)
            // Add to existing assistant message or create one.
            // Cap at 100 tool calls per message to prevent unbounded memory growth;
            // overflow falls through to create a new message.
            if let existingId = currentAssistantMessageId,
               let index = messages.firstIndex(where: { $0.id == existingId }),
               messages[index].toolCalls.count < 100 {
                let tcIdx = messages[index].toolCalls.count
                messages[index].toolCalls.append(toolCall)
                messages[index].contentOrder.append(.toolCall(tcIdx))
            } else {
                // Cap reached — rotate to a new message.
                // Clear streaming state on the old message first.
                if let existingId = currentAssistantMessageId,
                   let oldIndex = messages.firstIndex(where: { $0.id == existingId }) {
                    messages[oldIndex].isStreaming = false
                }
                var newMsg = ChatMessage(role: .assistant, text: "", isStreaming: true, toolCalls: [toolCall])
                newMsg.contentOrder = [.toolCall(0)]
                currentAssistantMessageId = newMsg.id
                messages.append(newMsg)
            }
            lastContentWasToolCall = true

        case .toolInputDelta(let msg):
            guard belongsToConversation(msg.conversationId) else { return }
            guard !isCancelling else { return }
            guard !isLoadingHistory else { return }
            let preview = Self.extractCodePreview(from: msg.content, toolName: msg.toolName)
            // If toolUseId is present, find the matching tool call and update its streaming preview.
            if let toolUseId = msg.toolUseId,
               let existingId = currentAssistantMessageId,
               let msgIndex = messages.firstIndex(where: { $0.id == existingId }),
               let tcIndex = messages[msgIndex].toolCalls.firstIndex(where: { $0.toolUseId == toolUseId }) {
                // Update code preview on the message for the matched tool call
                messages[msgIndex].streamingCodePreview = preview
                messages[msgIndex].streamingCodeToolName = msg.toolName
                _ = tcIndex // suppress unused warning — match confirms the tool call exists
            } else if let existingId = currentAssistantMessageId,
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

        case .toolOutputChunk(let msg):
            guard !isCancelling else { return }
            guard belongsToConversation(msg.conversationId) else { return }
            guard !isLoadingHistory else { return }
            // Handle structured progress events from claude_code sub-tools
            // Resolve the target tool call: prefer matching by toolUseId, fall back to positional heuristic.
            let resolvedStructuredTarget: (msgIndex: Int, tcIndex: Int)? = {
                if let toolUseId = msg.toolUseId {
                    for i in stride(from: messages.count - 1, through: 0, by: -1) {
                        if let tcIdx = messages[i].toolCalls.firstIndex(where: { $0.toolUseId == toolUseId }) {
                            return (i, tcIdx)
                        }
                    }
                }
                if let existingId = currentAssistantMessageId,
                   let mIdx = messages.firstIndex(where: { $0.id == existingId }),
                   let tcIdx = messages[mIdx].toolCalls.lastIndex(where: { !$0.isComplete && $0.toolName == "claude_code" }) {
                    return (mIdx, tcIdx)
                }
                return nil
            }()
            if let subType = msg.subType, !subType.isEmpty,
               let target = resolvedStructuredTarget {
                let msgIndex = target.msgIndex
                let tcIndex = target.tcIndex
                switch subType {
                case "tool_start":
                    if let toolName = msg.subToolName {
                        let step = ClaudeCodeSubStep(
                            toolName: toolName,
                            inputSummary: msg.subToolInput ?? "",
                            subToolId: msg.subToolId
                        )
                        messages[msgIndex].toolCalls[tcIndex].claudeCodeSteps.append(step)
                        // Cap sub-steps to prevent unbounded memory growth
                        if messages[msgIndex].toolCalls[tcIndex].claudeCodeSteps.count > 200 {
                            messages[msgIndex].toolCalls[tcIndex].claudeCodeSteps.removeFirst(
                                messages[msgIndex].toolCalls[tcIndex].claudeCodeSteps.count - 200
                            )
                        }
                    }
                case "tool_complete":
                    // Prefer matching by subToolId (stable SDK identifier) over tool name.
                    let stepIndex: Int?
                    if let subToolId = msg.subToolId {
                        stepIndex = messages[msgIndex].toolCalls[tcIndex].claudeCodeSteps.firstIndex(where: { $0.subToolId == subToolId && !$0.isComplete })
                    } else if let toolName = msg.subToolName {
                        stepIndex = messages[msgIndex].toolCalls[tcIndex].claudeCodeSteps.firstIndex(where: { $0.toolName == toolName && !$0.isComplete })
                    } else {
                        stepIndex = nil
                    }
                    if let stepIndex {
                        messages[msgIndex].toolCalls[tcIndex].claudeCodeSteps[stepIndex].isComplete = true
                        messages[msgIndex].toolCalls[tcIndex].claudeCodeSteps[stepIndex].isError = msg.subToolIsError ?? false
                    }
                case "status":
                    messages[msgIndex].toolCalls[tcIndex].buildingStatus = msg.subToolInput ?? ""
                default:
                    break
                }
            } else if msg.subType == nil || msg.subType?.isEmpty == true,
                      !msg.chunk.isEmpty {
                // Resolve target tool call: prefer toolUseId, fall back to positional heuristic.
                let resolvedPlainTarget: (msgIndex: Int, tcIndex: Int)? = {
                    if let toolUseId = msg.toolUseId {
                        for i in stride(from: messages.count - 1, through: 0, by: -1) {
                            if let tcIdx = messages[i].toolCalls.firstIndex(where: { $0.toolUseId == toolUseId }) {
                                return (i, tcIdx)
                            }
                        }
                    }
                    if let existingId = currentAssistantMessageId,
                       let mIdx = messages.firstIndex(where: { $0.id == existingId }),
                       let tcIdx = messages[mIdx].toolCalls.lastIndex(where: { !$0.isComplete }) {
                        return (mIdx, tcIdx)
                    }
                    return nil
                }()
                guard let target = resolvedPlainTarget else { return }
                let msgIndex = target.msgIndex
                let tcIndex = target.tcIndex
                // Append plain-text output chunks to the coalescing buffer.
                // Structured JSON sub-events (with a valid subType) are handled above;
                // the subType guard prevents them from leaking raw JSON here.
                let messageId = messages[msgIndex].id
                let key = "\(messageId):\(tcIndex)"
                if var entry = partialOutputBuffer[key] {
                    entry.content += msg.chunk
                    partialOutputBuffer[key] = entry
                } else {
                    partialOutputBuffer[key] = (messageId: messageId, tcIndex: tcIndex, content: msg.chunk)
                }
                schedulePartialOutputFlush()
            }

        case .toolResult(let msg):
            guard belongsToConversation(msg.conversationId) else { return }
            guard !isCancelling else { return }
            guard !isLoadingHistory else { return }
            guard !isWorkspaceRefinementInFlight else { return }
            flushPartialOutputBuffer()
            // Find the matching tool call.
            // Prefer matching by toolUseId (stable identifier) over positional heuristics.
            var targetMsgIndex: Int?
            var targetTcIndex: Int?
            if let toolUseId = msg.toolUseId {
                // Search all messages for a tool call with matching toolUseId
                for i in stride(from: messages.count - 1, through: 0, by: -1) {
                    if let tcIndex = messages[i].toolCalls.firstIndex(where: { $0.toolUseId == toolUseId }) {
                        targetMsgIndex = i
                        targetTcIndex = tcIndex
                        break
                    }
                }
            }
            // Fall back to existing positional heuristic if no ID match.
            if targetMsgIndex == nil {
                if let existingId = currentAssistantMessageId,
                   let msgIndex = messages.firstIndex(where: { $0.id == existingId }),
                   let tcIndex = messages[msgIndex].toolCalls.lastIndex(where: { !$0.isComplete }) {
                    targetMsgIndex = msgIndex
                    targetTcIndex = tcIndex
                } else if let existingId = currentAssistantMessageId,
                          let currentIdx = messages.firstIndex(where: { $0.id == existingId }) {
                    // Current assistant message has no incomplete tool calls.
                    // Search backward from current message position for rotated messages.
                    for i in stride(from: currentIdx - 1, through: max(0, currentIdx - 5), by: -1) {
                        guard messages[i].role == .assistant else { continue }
                        if let tcIndex = messages[i].toolCalls.lastIndex(where: { !$0.isComplete }) {
                            targetMsgIndex = i
                            targetTcIndex = tcIndex
                            break
                        }
                    }
                } else {
                    // currentAssistantMessageId is nil — search backward within current turn
                    // (reconnect scenario where there are no queued messages).
                    let lastUserIndex = messages.lastIndex(where: { $0.role == .user }) ?? 0
                    for i in stride(from: messages.count - 1, through: lastUserIndex, by: -1) {
                        guard messages[i].role == .assistant else { continue }
                        if let tcIndex = messages[i].toolCalls.lastIndex(where: { !$0.isComplete }) {
                            targetMsgIndex = i
                            targetTcIndex = tcIndex
                            break
                        }
                    }
                }
            }
            if let msgIndex = targetMsgIndex, let tcIndex = targetTcIndex {
                messages[msgIndex].toolCalls[tcIndex].result = msg.result
                messages[msgIndex].toolCalls[tcIndex].resultLength = msg.result.count
                messages[msgIndex].toolCalls[tcIndex].isError = msg.isError ?? false
                messages[msgIndex].toolCalls[tcIndex].isComplete = true
                messages[msgIndex].toolCalls[tcIndex].completedAt = Date()
                let decoded = ToolCallData.decodeImage(from: msg.imageData)
                // Keep cachedImage for display, nil out raw base64 to save ~2.7MB per screenshot
                messages[msgIndex].toolCalls[tcIndex].cachedImage = decoded
                messages[msgIndex].toolCalls[tcIndex].imageData = decoded == nil ? msg.imageData : nil
                if let status = msg.status, !status.isEmpty {
                    messages[msgIndex].toolCalls[tcIndex].buildingStatus = status
                }
                // When a claude_code tool completes, mark any remaining in-progress sub-steps
                // as done. This handles timeouts, crashes, and lost tool_complete events.
                let toolErrored = msg.isError ?? false
                downgradeAdjacentApprovedConfirmationForPermissionDeniedError(
                    assistantMessageIndex: msgIndex,
                    toolResult: msg.result,
                    isError: toolErrored
                )
                if toolErrored, Self.isOSPermissionDeniedError(msg.result),
                   messages[msgIndex].toolCalls[tcIndex].confirmationDecision == .approved {
                    messages[msgIndex].toolCalls[tcIndex].confirmationDecision = .denied
                }
                for stepIdx in messages[msgIndex].toolCalls[tcIndex].claudeCodeSteps.indices {
                    if !messages[msgIndex].toolCalls[tcIndex].claudeCodeSteps[stepIdx].isComplete {
                        messages[msgIndex].toolCalls[tcIndex].claudeCodeSteps[stepIdx].isComplete = true
                        messages[msgIndex].toolCalls[tcIndex].claudeCodeSteps[stepIdx].isError = toolErrored
                    }
                }
            }
            // Auto-open clip files in the default video player.
            // Use msg.toolName from the event payload (stable) instead of the
            // matched tool call's toolName (relies on last-incomplete heuristic).
            autoOpenClipIfNeeded(
                toolName: msg.toolName,
                result: msg.result,
                isError: msg.isError ?? false
            )

            // Tool completed — don't re-show "Thinking..." here. The tool
            // call chip already indicates activity, and the LLM isn't actually
            // thinking yet. isThinking will be set when the user sends a new
            // message or the daemon echoes it back.

        case .uiSurfaceShow(let msg):
            guard belongsToConversation(msg.conversationId) else { return }
            guard msg.display == nil || msg.display == "inline" || msg.display == "panel" else { break }
            guard let surface = Surface.from(msg) else { break }

            // Show floating overlay for task_progress cards (macOS only)
            #if os(macOS)
            if case .card(let cardData) = surface.data,
               cardData.template == "task_progress",
               let templateData = cardData.templateData,
               let progressData = TaskProgressData.parse(from: templateData, fallbackTitle: cardData.title) {
                TaskProgressOverlayManager.shared.show(data: progressData, surfaceId: msg.surfaceId)
            }
            #endif

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
            } else if msg.display == "panel" {
                // Non-dynamic-page surfaces with "panel" display are rendered as
                // floating panels by SurfaceManager — skip inline rendering to
                // avoid showing duplicates (one inline, one in a panel window).
                break
            }
            #endif

            isThinking = false
            let inlineSurface = InlineSurfaceData(
                id: surface.id,
                surfaceType: surface.type,
                title: surface.title,
                data: surface.data,
                actions: surface.actions,
                surfaceRef: SurfaceRef(from: msg, surface: surface)
            )

            if let existingId = currentAssistantMessageId,
               let index = messages.firstIndex(where: { $0.id == existingId }) {
                let surfIdx = messages[index].inlineSurfaces.count
                messages[index].inlineSurfaces.append(inlineSurface)
                messages[index].contentOrder.append(.surface(surfIdx))
                lastContentWasToolCall = true
            } else if let lastUserIndex = messages.lastIndex(where: { $0.role == .user }),
                      let idx = messages[lastUserIndex...].lastIndex(where: { $0.role == .assistant }) {
                let surfIdx = messages[idx].inlineSurfaces.count
                messages[idx].inlineSurfaces.append(inlineSurface)
                messages[idx].contentOrder.append(.surface(surfIdx))
                lastContentWasToolCall = true
            } else {
                var newMsg = ChatMessage(role: .assistant, text: "", isStreaming: true, inlineSurfaces: [inlineSurface])
                newMsg.contentOrder = [.surface(0)]
                currentAssistantMessageId = newMsg.id
                messages.append(newMsg)
            }

            // Eagerly request preview for app surfaces that don't have one yet.
            // Include the HTML so the handler can fall back to offscreen capture
            // when the daemon has no stored preview (e.g. brand new app).
            if case .dynamicPage(let dpData) = surface.data,
               let appId = dpData.appId,
               dpData.preview != nil,
               dpData.preview?.previewImage == nil {
                var userInfo: [String: Any] = ["appId": appId]
                userInfo["html"] = dpData.html
                NotificationCenter.default.post(
                    name: Notification.Name("MainWindow.requestAppPreview"),
                    object: nil,
                    userInfo: userInfo
                )
            }

        case .uiSurfaceUndoResult(let msg):
            guard belongsToConversation(msg.conversationId) else { return }
            surfaceUndoCount = msg.remainingUndos

        case .uiSurfaceUpdate(let msg):
            guard belongsToConversation(msg.conversationId) else { return }
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
                    let tempSurface = Surface(id: existing.id, conversationId: msg.conversationId, type: existing.surfaceType, title: existing.title, data: existing.data, actions: existing.actions)
                    if let updated = tempSurface.updated(with: msg) {
                        messages[msgIndex].inlineSurfaces[surfaceIndex] = InlineSurfaceData(
                            id: updated.id,
                            surfaceType: updated.type,
                            title: updated.title,
                            data: updated.data,
                            actions: updated.actions,
                            surfaceRef: existing.surfaceRef
                        )
                        // Update floating overlay for task_progress cards (macOS only)
                        #if os(macOS)
                        if case .card(let cardData) = updated.data,
                           cardData.template == "task_progress",
                           let templateData = cardData.templateData,
                           let progressData = TaskProgressData.parse(from: templateData, fallbackTitle: cardData.title) {
                            TaskProgressOverlayManager.shared.update(data: progressData, surfaceId: msg.surfaceId)
                        }
                        #endif
                    }
                    return
                }
            }

        case .uiSurfaceDismiss(let msg):
            guard belongsToConversation(msg.conversationId) else { return }
            // Find and remove the inline surface across all messages
            for msgIndex in messages.indices {
                if let surfaceIndex = messages[msgIndex].inlineSurfaces.firstIndex(where: { $0.id == msg.surfaceId }) {
                    messages[msgIndex].inlineSurfaces.remove(at: surfaceIndex)
                    return
                }
            }

        case .uiSurfaceComplete(let msg):
            guard belongsToConversation(msg.conversationId) else { return }
            // Dismiss floating overlay for task_progress cards (macOS only)
            #if os(macOS)
            TaskProgressOverlayManager.shared.dismiss(surfaceId: msg.surfaceId)
            #endif
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
            discardStreamingBuffer()
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
                    let decisionString = msg.state == "approved" ? "allow" : "deny"
                    onInlineConfirmationResponse?(msg.requestId, decisionString)
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
                isSending = true
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
            onWatchStarted?(msg, daemonClient)

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

    /// Auto-open generated video clips in the user's default video player.
    /// Scans the result for a `clipPath` field rather than checking toolName,
    /// because generate_clip runs inside claude_code (toolName is "claude_code").
    /// Restricts to known tool names and validated video extensions to prevent
    /// arbitrary file opens from untrusted tool results.
    private static let clipEligibleTools: Set<String> = ["claude_code", "generate_clip"]
    private static let clipVideoExtensions: Set<String> = ["mp4", "mov", "m4v", "avi", "mkv", "webm"]

    private func autoOpenClipIfNeeded(toolName: String, result: String, isError: Bool) {
        guard !isError, Self.clipEligibleTools.contains(toolName) else { return }
        guard let jsonData = result.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
              let clipPath = json["clipPath"] as? String else {
            return
        }
        let pathExtension = (clipPath as NSString).pathExtension.lowercased()
        guard Self.clipVideoExtensions.contains(pathExtension) else {
            log.warning("Clip path has non-video extension '\(pathExtension)', skipping auto-open")
            return
        }
        guard FileManager.default.fileExists(atPath: clipPath) else {
            log.warning("Clip file not found at path, skipping auto-open")
            return
        }
        #if os(macOS)
        NSWorkspace.shared.open(URL(fileURLWithPath: clipPath))
        #endif
    }
}
