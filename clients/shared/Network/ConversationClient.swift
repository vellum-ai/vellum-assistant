import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ConversationClient")

/// Focused client for conversation-related operations routed through the gateway.
@MainActor
public protocol ConversationClientProtocol {
    func fetchMessageContent(conversationId: String, messageId: String) async -> MessageContentResponse?
    func fetchHistory(conversationId: String, limit: Int?, beforeTimestamp: Double?, mode: String?, maxTextChars: Int?, maxToolResultChars: Int?) async -> HistoryResponse?
}

/// Gateway-backed implementation of ``ConversationClientProtocol``.
@MainActor
public struct ConversationClient: ConversationClientProtocol {
    nonisolated public init() {}

    public func fetchMessageContent(conversationId: String, messageId: String) async -> MessageContentResponse? {
        do {
            let encoded = messageId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? messageId
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/messages/\(encoded)/content",
                params: ["conversationId": conversationId],
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("fetchMessageContent failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("message_content_response", into: response.data)
            return try JSONDecoder().decode(MessageContentResponse.self, from: patched)
        } catch {
            log.error("fetchMessageContent error: \(error.localizedDescription)")
            return nil
        }
    }

    public func fetchHistory(
        conversationId: String,
        limit: Int? = nil,
        beforeTimestamp: Double? = nil,
        mode: String? = nil,
        maxTextChars: Int? = nil,
        maxToolResultChars: Int? = nil
    ) async -> HistoryResponse? {
        do {
            var params: [String: String] = ["conversationId": conversationId]
            if let limit { params["limit"] = "\(limit)" }
            if let beforeTimestamp { params["beforeTimestamp"] = "\(beforeTimestamp)" }
            if let mode { params["mode"] = mode }
            if let maxTextChars { params["maxTextChars"] = "\(maxTextChars)" }
            if let maxToolResultChars { params["maxToolResultChars"] = "\(maxToolResultChars)" }

            let response = try await GatewayHTTPClient.get(
                path: "messages", params: params, timeout: 15
            )
            guard response.isSuccess else {
                log.error("fetchHistory failed (HTTP \(response.statusCode))")
                return nil
            }

            // The HTTP API returns messages with `content` (String) and ISO 8601
            // `timestamp`, but HistoryResponse expects `text` and a Double
            // timestamp (ms since epoch). Transform the raw JSON before decoding.
            guard let json = try JSONSerialization.jsonObject(with: response.data) as? [String: Any],
                  let messages = json["messages"] as? [[String: Any]] else {
                return nil
            }

            let isoFormatter = ISO8601DateFormatter()
            isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let fallbackFormatter = ISO8601DateFormatter()

            let transformed: [[String: Any]] = messages.compactMap { msg in
                var m = msg
                // Rename `content` -> `text`.
                let content = m.removeValue(forKey: "content")
                if let content, !(content is NSNull) {
                    m["text"] = content
                } else {
                    m["text"] = ""
                }
                // Convert ISO 8601 timestamp -> Double (ms since epoch).
                if let tsString = m["timestamp"] as? String {
                    if let date = isoFormatter.date(from: tsString) {
                        m["timestamp"] = date.timeIntervalSince1970 * 1000.0
                    } else if let date = fallbackFormatter.date(from: tsString) {
                        m["timestamp"] = date.timeIntervalSince1970 * 1000.0
                    } else {
                        log.warning("Unparseable timestamp in history message: \(tsString, privacy: .public)")
                        m["timestamp"] = 0.0
                    }
                } else if m["timestamp"] == nil || m["timestamp"] is NSNull {
                    m["timestamp"] = 0.0
                }
                // Normalize attachments: backfill missing `data` field.
                if var attachments = m["attachments"] as? [[String: Any]] {
                    for i in attachments.indices {
                        if attachments[i]["data"] == nil || attachments[i]["data"] is NSNull {
                            attachments[i]["data"] = ""
                        }
                    }
                    m["attachments"] = attachments
                }
                return m
            }

            let historyPayload: [String: Any] = [
                "type": "history_response",
                "conversationId": conversationId,
                "messages": transformed,
                "hasMore": json["hasMore"] as? Bool ?? false,
            ]

            let historyData = try JSONSerialization.data(withJSONObject: historyPayload)
            return try JSONDecoder().decode(HistoryResponse.self, from: historyData)
        } catch {
            log.error("fetchHistory error: \(error.localizedDescription)")
            return nil
        }
    }

    // MARK: - Helpers

    private func injectType(_ type: String, into data: Data) -> Data {
        guard var json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return data
        }
        json["type"] = type
        return (try? JSONSerialization.data(withJSONObject: json)) ?? data
    }
}
