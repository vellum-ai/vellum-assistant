import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ConversationQueueClient")

/// Focused client for message queue operations routed through the gateway.
@MainActor
public protocol ConversationQueueClientProtocol {
    func deleteQueuedMessage(conversationId: String, requestId: String) async -> Bool
}

/// Gateway-backed implementation of ``ConversationQueueClientProtocol``.
@MainActor
public struct ConversationQueueClient: ConversationQueueClientProtocol {
    nonisolated public init() {}

    public func deleteQueuedMessage(conversationId: String, requestId: String) async -> Bool {
        do {
            let encoded = requestId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? requestId
            let response = try await GatewayHTTPClient.delete(
                path: "assistants/{assistantId}/messages/queued/\(encoded)?conversationId=\(conversationId)",
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("deleteQueuedMessage failed (HTTP \(response.statusCode))")
                return false
            }
            return true
        } catch {
            log.error("deleteQueuedMessage error: \(error.localizedDescription)")
            return false
        }
    }
}
