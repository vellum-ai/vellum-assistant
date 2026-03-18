import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ConversationListClient")

/// Focused client for conversation operations routed through the gateway.
///
/// Covers conversation list, message history, message content, regenerate,
/// delete queued message, and conversation unread.
@MainActor
public protocol ConversationListClientProtocol {
    func fetchConversationList(offset: Int, limit: Int) async -> ConversationListResponse?
    func fetchHistory(conversationId: String, limit: Int?, beforeTimestamp: Double?, mode: String?, maxTextChars: Int?, maxToolResultChars: Int?) async -> HistoryResponse?
    func fetchMessageContent(conversationId: String, messageId: String) async -> MessageContentResponse?
    func deleteQueuedMessage(conversationId: String, requestId: String) async -> Bool
    func regenerate(conversationId: String) async -> Bool
    func sendConversationUnread(conversationId: String, sourceChannel: String, signalType: String, confidence: String, source: String, evidenceText: String?, observedAt: Int?, latestAssistantMessageAt: Int?) async throws
}

/// Gateway-backed implementation of ``ConversationClientProtocol``.
@MainActor
public struct ConversationListClient: ConversationListClientProtocol {
    nonisolated public init() {}

    public func fetchConversationList(offset: Int = 0, limit: Int = 50) async -> ConversationListResponse? {
        do {
            var params: [String: String] = [
                "limit": "\(limit)",
                "offset": "\(offset)",
            ]
            // Remove offset if zero to keep URLs clean.
            if offset == 0 { params.removeValue(forKey: "offset") }

            let response = try await GatewayHTTPClient.get(
                path: "conversations", params: params, timeout: 15
            )
            guard response.isSuccess else {
                log.error("fetchConversationList failed (HTTP \(response.statusCode))")
                return nil
            }
            // The HTTP API returns a raw list; decode via the private DTO then
            // map into the public ConversationListResponse type.
            let decoded = try JSONDecoder().decode(HTTPConversationsListResponse.self, from: response.data)
            let items = decoded.conversations.map {
                ConversationListResponseItem(
                    id: $0.id, title: $0.title,
                    createdAt: $0.createdAt ?? $0.updatedAt,
                    updatedAt: $0.updatedAt,
                    conversationType: $0.conversationType,
                    source: $0.source,
                    scheduleJobId: $0.scheduleJobId,
                    channelBinding: $0.channelBinding,
                    conversationOriginChannel: $0.conversationOriginChannel,
                    conversationOriginInterface: $0.conversationOriginInterface,
                    assistantAttention: $0.assistantAttention,
                    displayOrder: $0.displayOrder,
                    isPinned: $0.isPinned
                )
            }
            return ConversationListResponse(
                type: "conversation_list_response",
                conversations: items,
                hasMore: decoded.hasMore
            )
        } catch {
            log.error("fetchConversationList error: \(error.localizedDescription)")
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
                // Rename `content` → `text`.
                let content = m.removeValue(forKey: "content")
                if let content, !(content is NSNull) {
                    m["text"] = content
                } else {
                    m["text"] = ""
                }
                // Convert ISO 8601 timestamp → Double (ms since epoch).
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

            var historyPayload: [String: Any] = [
                "type": "history_response",
                "conversationId": conversationId,
                "messages": transformed,
                "hasMore": json["hasMore"] as? Bool ?? false,
            ]
            if let oldestTimestamp = json["oldestTimestamp"] {
                historyPayload["oldestTimestamp"] = oldestTimestamp
            }
            if let oldestMessageId = json["oldestMessageId"] {
                historyPayload["oldestMessageId"] = oldestMessageId
            }

            let historyData = try JSONSerialization.data(withJSONObject: historyPayload)
            return try JSONDecoder().decode(HistoryResponse.self, from: historyData)
        } catch {
            log.error("fetchHistory error: \(error.localizedDescription)")
            return nil
        }
    }

    public func fetchMessageContent(conversationId: String, messageId: String) async -> MessageContentResponse? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "messages/\(messageId)/content",
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

    public func deleteQueuedMessage(conversationId: String, requestId: String) async -> Bool {
        do {
            let response = try await GatewayHTTPClient.delete(
                path: "messages/queued/\(requestId)?conversationId=\(conversationId)",
                timeout: 10
            )
            if !response.isSuccess {
                log.error("deleteQueuedMessage failed (HTTP \(response.statusCode))")
                return false
            }
            return true
        } catch {
            log.error("deleteQueuedMessage error: \(error.localizedDescription)")
            return false
        }
    }

    @discardableResult
    public func regenerate(conversationId: String) async -> Bool {
        do {
            let response = try await GatewayHTTPClient.post(
                path: "conversations/\(conversationId)/regenerate", timeout: 10
            )
            if !response.isSuccess {
                log.error("regenerate failed (HTTP \(response.statusCode))")
                return false
            }
            return true
        } catch {
            log.error("regenerate error: \(error.localizedDescription)")
            return false
        }
    }

    public func sendConversationUnread(
        conversationId: String,
        sourceChannel: String,
        signalType: String,
        confidence: String,
        source: String,
        evidenceText: String? = nil,
        observedAt: Int? = nil,
        latestAssistantMessageAt: Int? = nil
    ) async throws {
        var body: [String: Any] = [
            "conversationId": conversationId,
            "sourceChannel": sourceChannel,
            "signalType": signalType,
            "confidence": confidence,
            "source": source,
        ]
        if let evidenceText { body["evidenceText"] = evidenceText }
        if let observedAt { body["observedAt"] = observedAt }
        if let latestAssistantMessageAt { body["latestAssistantMessageAt"] = latestAssistantMessageAt }

        let response = try await GatewayHTTPClient.post(
            path: "conversations/unread", json: body, timeout: 10
        )
        if !response.isSuccess {
            let message: String
            if let json = try? JSONSerialization.jsonObject(with: response.data) as? [String: Any],
               let error = json["error"] as? [String: Any],
               let msg = error["message"] as? String {
                message = msg
            } else {
                message = "HTTP \(response.statusCode)"
            }
            throw ConversationUnreadError.requestFailed(message: message)
        }
    }

    // MARK: - Errors

    enum ConversationUnreadError: Error, LocalizedError {
        case requestFailed(message: String)

        var errorDescription: String? {
            switch self {
            case .requestFailed(let message):
                return message
            }
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

// MARK: - Private HTTP Response DTO

/// Mirrors the HTTP API's conversation list response shape. The public
/// ``ConversationListResponse`` type requires a `type` discriminant that
/// the HTTP endpoint omits, so we decode into this private DTO first.
private struct HTTPConversationsListResponse: Decodable {
    struct Conversation: Decodable {
        let id: String
        let title: String
        let createdAt: Int?
        let updatedAt: Int
        let conversationType: String?
        let source: String?
        let scheduleJobId: String?
        let channelBinding: ChannelBinding?
        let conversationOriginChannel: String?
        let conversationOriginInterface: String?
        let assistantAttention: AssistantAttention?
        let displayOrder: Double?
        let isPinned: Bool?
    }
    let conversations: [Conversation]
    let hasMore: Bool?
}
