import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ConversationUnreadClient")

/// Error type for conversation unread operations.
public enum ConversationUnreadError: LocalizedError {
    case requestFailed(statusCode: Int, message: String?)

    public var errorDescription: String? {
        switch self {
        case .requestFailed(_, let message):
            return message ?? "Request failed"
        }
    }
}

/// Focused client for marking conversations as unread through the gateway.
@MainActor
public protocol ConversationUnreadClientProtocol {
    func sendConversationUnread(_ signal: ConversationUnreadSignal) async throws
}

/// Gateway-backed implementation of ``ConversationUnreadClientProtocol``.
@MainActor
public struct ConversationUnreadClient: ConversationUnreadClientProtocol {
    nonisolated public init() {}

    public func sendConversationUnread(_ signal: ConversationUnreadSignal) async throws {
        var body: [String: Any] = [
            "conversationId": signal.conversationId,
            "sourceChannel": signal.sourceChannel,
            "signalType": signal.signalType,
            "confidence": signal.confidence,
            "source": signal.source
        ]
        if let evidenceText = signal.evidenceText {
            body["evidenceText"] = evidenceText
        }
        if let observedAt = signal.observedAt {
            body["observedAt"] = observedAt
        }
        if let metadata = signal.metadata {
            body["metadata"] = jsonCompatibleDictionary(metadata)
        }

        let response = try await GatewayHTTPClient.post(
            path: "assistants/{assistantId}/conversations/unread",
            json: body,
            timeout: 10
        )

        guard response.isSuccess else {
            let message = decodeErrorMessage(from: response.data)
            throw ConversationUnreadError.requestFailed(
                statusCode: response.statusCode,
                message: message
            )
        }
    }

    // MARK: - Helpers

    private func decodeErrorMessage(from data: Data) -> String? {
        struct ErrorEnvelope: Decodable {
            struct ErrorBody: Decodable {
                let message: String
            }
            let error: ErrorBody
        }
        if let envelope = try? JSONDecoder().decode(ErrorEnvelope.self, from: data) {
            return envelope.error.message
        }
        guard let body = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !body.isEmpty else { return nil }
        return body
    }

    /// Unwrap `AnyCodable` wrappers for JSON serialization.
    private func jsonCompatibleDictionary(_ values: [String: AnyCodable]) -> [String: Any] {
        var result: [String: Any] = [:]
        for (key, value) in values {
            result[key] = value.value
        }
        return result
    }
}
