import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "RegenerateClient")

/// Focused client for regenerating the last assistant response through the gateway.
@MainActor
public protocol RegenerateClientProtocol {
    func regenerate(conversationId: String) async -> Bool
}

/// Gateway-backed implementation of ``RegenerateClientProtocol``.
@MainActor
public struct RegenerateClient: RegenerateClientProtocol {
    nonisolated public init() {}

    /// Regenerate the last assistant response for a conversation.
    /// Returns `true` on success (HTTP 200/202), `false` otherwise.
    public func regenerate(conversationId: String) async -> Bool {
        do {
            let encoded = conversationId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? conversationId
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/conversations/\(encoded)/regenerate",
                timeout: 15
            )
            guard response.isSuccess else {
                log.error("regenerate failed (HTTP \(response.statusCode))")
                return false
            }
            return true
        } catch {
            log.error("regenerate error: \(error.localizedDescription)")
            return false
        }
    }
}
