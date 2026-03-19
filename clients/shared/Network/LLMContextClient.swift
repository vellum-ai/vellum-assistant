import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "LLMContextClient")

/// A single LLM request/response log entry returned by the context endpoint.
public struct LLMRequestLogEntry: Codable, Identifiable, Sendable {
    public let id: String
    public let requestPayload: AnyCodable
    public let responsePayload: AnyCodable
    public let createdAt: Int
}

/// Response wrapper for the LLM context endpoint.
public struct LLMContextResponse: Codable, Sendable {
    public let messageId: String
    public let logs: [LLMRequestLogEntry]
}

/// Focused client for fetching LLM request/response context for a given message,
/// routed through the gateway.
@MainActor
public protocol LLMContextClientProtocol {
    func fetchContext(messageId: String) async -> LLMContextResponse?
}

/// Gateway-backed implementation of ``LLMContextClientProtocol``.
@MainActor
public struct LLMContextClient: LLMContextClientProtocol {
    nonisolated public init() {}

    public func fetchContext(messageId: String) async -> LLMContextResponse? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/messages/\(messageId)/llm-context",
                timeout: 15
            )
            guard response.isSuccess else {
                log.error("fetchContext failed (HTTP \(response.statusCode))")
                return nil
            }
            return try JSONDecoder().decode(LLMContextResponse.self, from: response.data)
        } catch {
            log.error("fetchContext error: \(error.localizedDescription)")
            return nil
        }
    }
}
