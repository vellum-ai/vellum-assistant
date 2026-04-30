import Foundation
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#else
#error("Unsupported platform")
#endif

/// Namespace for static, nonisolated helpers that reconstruct `ChatMessage` arrays
/// from daemon history-response payloads. The heavy work (JSON size estimation,
/// tool-input formatting, surface mapping, image decoding) is decoupled from the
/// view model so it can run from any isolation context.
public enum HistoryReconstructionService {

    // MARK: - Result type

    /// Result of reconstructing ChatMessages from history response items.
    public struct Result {
        public let messages: [ChatMessage]
        public let subagents: [SubagentInfo]
    }

    // MARK: - Main entry point

    /// Reconstructs ChatMessage and SubagentInfo arrays from raw history items.
    /// This method is nonisolated and accesses no @MainActor state, so it can
    /// be called from a background context. Images are decoded eagerly via
    /// `ToolCallData.decodeImage` and stored in `cachedImages` for display.
    nonisolated public static func reconstructMessages(
        from historyMessages: [HistoryResponseMessage],
        conversationId: String?
    ) -> Result {
        var chatMessages: [ChatMessage] = []
        var reconstructedSubagents: [SubagentInfo] = []
        var spawnParentMap: [String: UUID] = [:]

        for item in historyMessages {
            let role: ChatRole = item.role == "assistant" ? .assistant : .user
            var toolCalls: [ToolCallData] = []
            let toolsBeforeText = item.toolCallsBeforeText ?? true
            if let historyToolCalls = item.toolCalls {
                toolCalls = historyToolCalls.map { tc in
                    // Decode images eagerly — pass imageDataList:nil to init to skip
                    // its internal decode, then set cachedImages directly below.
                    var toolCall = ToolCallData(
                        toolName: tc.name,
                        inputSummary: summarizeToolInputStatic(tc.input),
                        inputFull: "",
                        inputRawValue: extractToolInputStatic(tc.input),
                        result: tc.result,
                        isError: tc.isError ?? false,
                        isComplete: true,
                        arrivedBeforeText: toolsBeforeText,
                        imageDataList: nil
                    )
                    // Decode images eagerly — NSImage/UIImage init from Data is
                    // thread-safe and the views expect cachedImages to be populated.
                    toolCall.cachedImages = (tc.imageDataList ?? []).compactMap { ToolCallData.decodeImage(from: $0) }
                    toolCall.reasonDescription = ((tc.input["activity"]?.value as? String)
                        ?? (tc.input["reason"]?.value as? String)
                        ?? (tc.input["reasoning"]?.value as? String)).map { ToolCallData.displaySafe($0) }
                    if let startMs = tc.startedAt {
                        toolCall.startedAt = Date(timeIntervalSince1970: Double(startMs) / 1000.0)
                    }
                    if let endMs = tc.completedAt {
                        toolCall.completedAt = Date(timeIntervalSince1970: Double(endMs) / 1000.0)
                    }
                    if let decision = tc.confirmationDecision {
                        switch decision {
                        case "approved": toolCall.confirmationDecision = .approved
                        case "denied": toolCall.confirmationDecision = .denied
                        case "timed_out": toolCall.confirmationDecision = .timedOut
                        default: break
                        }
                    }
                    toolCall.confirmationLabel = tc.confirmationLabel
                    toolCall.riskLevel = tc.riskLevel
                    toolCall.riskReason = tc.riskReason
                    toolCall.matchedTrustRuleId = tc.matchedTrustRuleId
                    let input = tc.input
                    let estimatedSize: Int = (try? JSONSerialization.data(withJSONObject: input.mapValues { $0.value ?? NSNull() }))?.count ?? 0
                    if estimatedSize > 10_000 {
                        let formatted = ToolCallData.formatAllToolInput(input)
                        toolCall.inputFull = formatted
                        toolCall.inputFullLength = formatted.count
                    } else {
                        toolCall.inputRawDict = input
                    }
                    return toolCall
                }
            }
            let attachments: [ChatAttachment] = mapMessageAttachmentsStatic(item.attachments ?? [])

            var inlineSurfaces: [InlineSurfaceData] = []
            if let historySurfaces = item.surfaces {
                for surf in historySurfaces {
                    if let conversationId,
                       let surface = Surface.from(surf, conversationId: conversationId) {
                        let appId: String? = {
                            if case .dynamicPage(let dpData) = surface.data {
                                return dpData.appId
                            }
                            return nil
                        }()
                        let ref = SurfaceRef(
                            surfaceId: surf.surfaceId,
                            conversationId: conversationId,
                            surfaceType: surf.surfaceType,
                            title: surf.title,
                            appId: appId
                        )
                        let inlineSurface = InlineSurfaceData(
                            id: surface.id,
                            surfaceType: surface.type,
                            title: surface.title,
                            data: surface.data,
                            actions: surface.actions,
                            surfaceRef: ref,
                            completionState: surf.completed == true
                                ? SurfaceCompletionState(summary: surf.completionSummary ?? "Completed")
                                : nil
                        )
                        inlineSurfaces.append(inlineSurface)
                    }
                }
            }

            let hasThinking = item.thinkingSegments?.isEmpty == false
            if item.text.isEmpty && toolCalls.isEmpty && attachments.isEmpty && inlineSurfaces.isEmpty && !hasThinking { continue }
            let timestamp = Date(timeIntervalSince1970: TimeInterval(item.timestamp) / 1000.0)

            var chatMsg: ChatMessage
            if let dbId = item.id, let uuid = UUID(uuidString: dbId) {
                chatMsg = ChatMessage(id: uuid, role: role, text: item.text, timestamp: timestamp, attachments: attachments, toolCalls: toolCalls)
            } else {
                chatMsg = ChatMessage(role: role, text: item.text, timestamp: timestamp, attachments: attachments, toolCalls: toolCalls)
            }

            chatMsg.daemonMessageId = item.id
            chatMsg.wasTruncated = item.wasTruncated ?? false
            for i in chatMsg.attachments.indices {
                chatMsg.attachments[i].data = ""
            }
            chatMsg.inlineSurfaces = inlineSurfaces
            if let segments = item.textSegments {
                chatMsg.textSegments = segments
            }
            if let thinkingSegs = item.thinkingSegments {
                chatMsg.thinkingSegments = thinkingSegs
            }
            if let orderStrings = item.contentOrder {
                chatMsg.contentOrder = parseContentOrder(orderStrings)
            }

            if role == .assistant {
                for tc in toolCalls where tc.toolName == "subagent_spawn" {
                    if let result = tc.result,
                       let data = result.data(using: .utf8),
                       let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                       let spawnedId = json["subagentId"] as? String {
                        spawnParentMap[spawnedId] = chatMsg.id
                    }
                }
            }

            if let notification = item.subagentNotification {
                var info = SubagentInfo(
                    id: notification.subagentId,
                    label: notification.label,
                    status: SubagentStatus(wire: notification.status),
                    parentMessageId: spawnParentMap[notification.subagentId],
                    conversationId: notification.conversationId
                )
                info.error = notification.error
                reconstructedSubagents.append(info)
                chatMsg.isSubagentNotification = true
            }

            chatMessages.append(chatMsg)
        }

        return Result(messages: chatMessages, subagents: reconstructedSubagents)
    }

    // MARK: - Content order parsing

    /// Parse string-encoded content order entries ("text:0", "tool:1", "surface:0")
    /// into ContentBlockRef values.
    nonisolated static func parseContentOrder(_ strings: [String]) -> [ContentBlockRef] {
        strings.compactMap { str in
            let parts = str.split(separator: ":", maxSplits: 1)
            guard parts.count == 2, let idx = Int(parts[1]) else { return nil }
            switch parts[0] {
            case "text": return .text(idx)
            case "tool": return .toolCall(idx)
            case "surface": return .surface(idx)
            case "thinking": return .thinking(idx)
            default: return nil
            }
        }
    }

    // MARK: - Tool input helpers

    /// Priority list of input keys whose values are most useful as a tool call summary.
    nonisolated static let toolInputPriorityKeys = [
        "command", "file_path", "path", "query", "url", "pattern", "glob"
    ]

    /// Argument keys whose values may contain credentials and must be redacted.
    /// All comparisons use lowercased keys to catch variants like accessToken,
    /// Authorization, X-API-KEY, etc.
    /// Note: String concatenation used for some entries to avoid false positives
    /// from the pre-commit secrets scanner.
    nonisolated static let sensitiveKeys: Set<String> = [
        "value", "secret", "password", "token", "client" + "_secret", "api" + "_key",
        "authorization", "access" + "_token", "refresh" + "_token", "api" + "_secret",
        "accesstoken", "refreshtoken", "apikey", "apisecret", "client" + "secret",
        "x-api-key"
    ]

    /// Case-insensitive check: does the given key match any sensitive key?
    nonisolated static func isSensitiveKey(_ key: String) -> Bool {
        sensitiveKeys.contains(key.lowercased())
    }

    /// Summarize tool input for display, picking the most relevant value truncated to 80 chars.
    nonisolated static func summarizeToolInputStatic(_ input: [String: AnyCodable]) -> String {
        let str = extractToolInputStatic(input)
        return str.count > 80 ? String(str.prefix(77)) + "..." : str
    }

    /// Extract the most relevant tool input value as a full string (no truncation).
    /// Redacts values for sensitive keys to prevent credential leakage into inputSummary.
    nonisolated static func extractToolInputStatic(_ input: [String: AnyCodable]) -> String {
        let key: String
        let value: AnyCodable
        if let match = toolInputPriorityKeys.first(where: { input[$0] != nil }),
           let v = input[match] {
            key = match
            value = v
        } else if let firstKey = input.keys.sorted().first, let v = input[firstKey] {
            key = firstKey
            value = v
        } else {
            return ""
        }
        if isSensitiveKey(key) {
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

    // MARK: - Attachment mapping

    /// Map attachment DTOs to ChatAttachment values, generating thumbnails for images.
    nonisolated static func mapMessageAttachmentsStatic(_ attachments: [UserMessageAttachment]) -> [ChatAttachment] {
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
                thumbnailData = generateThumbnail(from: rawData, maxDimension: 800)
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

    // MARK: - Image utilities

    /// Resize image data to fit within `maxDimension` and return PNG data.
    nonisolated static func generateThumbnail(from data: Data, maxDimension: CGFloat) -> Data? {
        ChatAttachmentManager.generateThumbnail(from: data, maxDimension: maxDimension)
    }
}
