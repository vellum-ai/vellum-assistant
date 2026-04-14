import Foundation
import os
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#else
#error("Unsupported platform")
#endif

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ChatViewModel+SurfaceHandling")

// MARK: - Tool Input Formatting & Display Helpers

extension ChatViewModel {

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
        HistoryReconstructionService.extractToolInputStatic(input)
    }

    /// Summarize tool input for display, picking the most relevant value truncated to 80 chars.
    func summarizeToolInput(_ input: [String: AnyCodable]) -> String {
        HistoryReconstructionService.summarizeToolInputStatic(input)
    }

    /// Format all tool input arguments for display in expanded details.
    /// Primary key is listed first, then remaining keys alphabetically. All as `key: value`.
    /// Sensitive keys (passwords, tokens, etc.) are redacted to prevent credential exposure.
    func formatAllToolInput(_ input: [String: AnyCodable]) -> String {
        guard !input.isEmpty else { return "" }

        // Find the primary key (same logic as extractToolInput)
        let primaryKey = HistoryReconstructionService.toolInputPriorityKeys.first(where: { input[$0] != nil })
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
            if HistoryReconstructionService.isSensitiveKey(key) {
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
            if HistoryReconstructionService.isSensitiveKey(key) {
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
            if HistoryReconstructionService.isSensitiveKey(key) {
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

    // MARK: - Attachment Helpers

    /// Map attachment DTOs to ChatAttachment values, generating thumbnails for images.
    func mapMessageAttachments(_ attachments: [UserMessageAttachment]) -> [ChatAttachment] {
        HistoryReconstructionService.mapMessageAttachmentsStatic(attachments)
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

    // MARK: - Permission & Tool Result Helpers

    /// Returns true when a tool error string looks like a macOS/TCC permission denial.
    static func isOSPermissionDeniedError(_ result: String) -> Bool {
        let normalized = result.lowercased()
        return osPermissionDeniedIndicators.contains { normalized.contains($0) }
    }

    /// If the user approved a confirmation but execution still failed due OS
    /// permission denial, update the nearby confirmation so the UI does not
    /// incorrectly show it as approved.
    func downgradeAdjacentApprovedConfirmationForPermissionDeniedError(
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

    // MARK: - Auto-Open Clip

    /// Auto-open generated video clips in the user's default video player.
    /// Scans the result for a `clipPath` field rather than checking toolName.
    /// Restricts to known tool names and validated video extensions to prevent
    /// arbitrary file opens from untrusted tool results.
    private static let clipEligibleTools: Set<String> = ["generate_clip"]
    private static let clipVideoExtensions: Set<String> = ["mp4", "mov", "m4v", "avi", "mkv", "webm"]

    func autoOpenClipIfNeeded(toolName: String, result: String, isError: Bool) {
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

    // MARK: - Surface Event Handlers

    /// Handle a `ui_surface_show` event: create or attach an inline surface widget.
    /// Returns `false` when the event should be skipped (guard failures, panel-only display).
    @discardableResult
    func handleSurfaceShow(_ msg: UiSurfaceShowMessage) -> Bool {
        guard belongsToConversation(msg.conversationId) else { return false }
        guard msg.display == nil || msg.display == "inline" || msg.display == "panel" else { return false }
        guard let surface = Surface.from(msg) else { return false }

        // Flush buffered text so it lands before the surface in content order.
        flushStreamingBuffer()
        flushPartialOutputBuffer()

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
                return false
            }
        } else if msg.display == "panel" {
            // Non-dynamic-page surfaces with "panel" display are rendered as
            // floating panels by SurfaceManager — skip inline rendering to
            // avoid showing duplicates (one inline, one in a panel window).
            return false
        }
        #endif

        isThinking = false
        var inlineSurface = InlineSurfaceData(
            id: surface.id,
            surfaceType: surface.type,
            title: surface.title,
            data: surface.data,
            actions: surface.actions,
            surfaceRef: SurfaceRef(from: msg, surface: surface)
        )
        // Mark dynamic page surfaces as not yet ready — the parent tool call
        // is still executing.  The flag flips to true in handleToolResult once
        // the tool call completes.
        if case .dynamicPage = surface.data {
            inlineSurface.isToolCallComplete = false
        }

        if let existingId = currentAssistantMessageId,
           let index = messages.firstIndex(where: { $0.id == existingId }) {
            let surfIdx = messages[index].inlineSurfaces.count
            messages[index].inlineSurfaces.append(inlineSurface)
            messages[index].contentOrder.append(.surface(surfIdx))
            // Clear the streaming code preview when a dynamic page surface appears —
            // the inline card visually replaces the raw HTML code block.
            if case .dynamicPage = surface.data {
                messages[index].streamingCodePreview = nil
                messages[index].streamingCodeToolName = nil
            }
        } else if let lastUserIndex = messages.lastIndex(where: { $0.role == .user }),
                  let idx = messages[lastUserIndex...].lastIndex(where: { $0.role == .assistant }) {
            let surfIdx = messages[idx].inlineSurfaces.count
            messages[idx].inlineSurfaces.append(inlineSurface)
            messages[idx].contentOrder.append(.surface(surfIdx))
            if case .dynamicPage = surface.data {
                messages[idx].streamingCodePreview = nil
                messages[idx].streamingCodeToolName = nil
            }
        } else {
            var newMsg = ChatMessage(role: .assistant, text: "", isStreaming: true, inlineSurfaces: [inlineSurface])
            newMsg.contentOrder = [.surface(0)]
            currentAssistantMessageId = newMsg.id
            messages.append(newMsg)
        }

        // Eagerly request preview for app surfaces that don't have one yet.
        // Include the HTML so the handler can fall back to offscreen capture
        // when the daemon has no stored preview (e.g. brand new app).
        // Fire when preview is absent entirely OR when it exists but lacks a
        // previewImage — both cases need a preview to be fetched/captured.
        if case .dynamicPage(let dpData) = surface.data,
           let appId = dpData.appId,
           dpData.preview?.previewImage == nil {
            var userInfo: [String: Any] = ["appId": appId]
            userInfo["html"] = dpData.html
            NotificationCenter.default.post(
                name: Notification.Name("MainWindow.requestAppPreview"),
                object: nil,
                userInfo: userInfo
            )
        }
        return true
    }

    /// Handle a `ui_surface_undo_result` event.
    func handleSurfaceUndoResult(_ msg: UiSurfaceUndoResultMessage) {
        guard belongsToConversation(msg.conversationId) else { return }
        surfaceUndoCount = msg.remainingUndos
    }

    /// Handle a `ui_surface_update` event: update an existing inline surface widget's data.
    func handleSurfaceUpdate(_ msg: UiSurfaceUpdateMessage) {
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
                    var newSurface = InlineSurfaceData(
                        id: updated.id,
                        surfaceType: updated.type,
                        title: updated.title,
                        data: updated.data,
                        actions: updated.actions,
                        surfaceRef: existing.surfaceRef
                    )
                    newSurface.isToolCallComplete = existing.isToolCallComplete
                    newSurface.completionState = existing.completionState
                    messages[msgIndex].inlineSurfaces[surfaceIndex] = newSurface
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
    }

    /// Handle a `ui_surface_dismiss` event: remove an inline surface widget.
    func handleSurfaceDismiss(_ msg: UiSurfaceDismissMessage) {
        guard belongsToConversation(msg.conversationId) else { return }
        // Find and remove the inline surface across all messages
        for msgIndex in messages.indices {
            if let surfaceIndex = messages[msgIndex].inlineSurfaces.firstIndex(where: { $0.id == msg.surfaceId }) {
                messages[msgIndex].inlineSurfaces.remove(at: surfaceIndex)
                return
            }
        }
    }

    /// Handle a `ui_surface_complete` event: mark an inline surface as completed.
    func handleSurfaceComplete(_ msg: UiSurfaceCompleteMessage) {
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
    }
}
