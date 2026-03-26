import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ConversationHistoryClient")
private let perfLog = OSLog(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: .pointsOfInterest)

/// Focused client for conversation history operations routed through the gateway.
public protocol ConversationHistoryClientProtocol {
    func fetchHistory(conversationId: String, limit: Int?, beforeTimestamp: Double?, mode: String?, maxTextChars: Int?, maxToolResultChars: Int?) async -> HistoryResponse?
}

/// Gateway-backed implementation of ``ConversationHistoryClientProtocol``.
public struct ConversationHistoryClient: ConversationHistoryClientProtocol {
    nonisolated public init() {}

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
                path: "assistants/{assistantId}/messages", params: params, timeout: 15
            )
            guard response.isSuccess else {
                log.error("fetchHistory failed (HTTP \(response.statusCode))")
                return nil
            }

            // The HTTP API returns messages with `content` (String) and ISO 8601
            // `timestamp`, but HistoryResponse expects `text` and a Double
            // timestamp (ms since epoch). Transform the raw JSON before decoding.
            let spid = OSSignpostID(log: perfLog)
            os_signpost(.begin, log: perfLog, name: "historyJSONTransform", signpostID: spid, "bytes=%d", response.data.count)
            guard let json = try JSONSerialization.jsonObject(with: response.data) as? [String: Any],
                  let messages = json["messages"] as? [[String: Any]] else {
                os_signpost(.end, log: perfLog, name: "historyJSONTransform", signpostID: spid, "failed=parse")
                return nil
            }

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
                    if let date = tsString.iso8601Date {
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

            var historyPayload: [String: Any] = [
                "type": "history_response",
                "conversationId": conversationId,
                "messages": transformed,
                "hasMore": json["hasMore"] as? Bool ?? false,
            ]
            if let oldestTimestamp = json["oldestTimestamp"] as? Double {
                historyPayload["oldestTimestamp"] = oldestTimestamp
            }

            let historyData = try JSONSerialization.data(withJSONObject: historyPayload)
            let decoded = try JSONDecoder().decode(HistoryResponse.self, from: historyData)
            os_signpost(.end, log: perfLog, name: "historyJSONTransform", signpostID: spid, "messages=%d", messages.count)
            return decoded
        } catch {
            log.error("fetchHistory error: \(error.localizedDescription)")
            return nil
        }
    }
}
