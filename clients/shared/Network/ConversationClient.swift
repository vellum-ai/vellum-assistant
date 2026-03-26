import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ConversationClient")

/// Focused client for conversation-related operations routed through the gateway.
public protocol ConversationClientProtocol {
    func fetchMessageContent(conversationId: String, messageId: String) async -> MessageContentResponse?
}

/// Gateway-backed implementation of ``ConversationClientProtocol``.
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

    // MARK: - Helpers

    private func injectType(_ type: String, into data: Data) -> Data {
        guard var json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return data
        }
        json["type"] = type
        return (try? JSONSerialization.data(withJSONObject: json)) ?? data
    }
}
