import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "TTSClient")

/// Result of a message TTS synthesis request.
public enum TTSResult: Sendable {
    /// Audio binary returned successfully.
    case success(data: Data)
    /// Feature flag is disabled (403).
    case featureDisabled
    /// TTS provider is not configured (503).
    case notConfigured
    /// Message not found (404).
    case notFound
    /// Generic error.
    case error(statusCode: Int?, message: String)
}

/// Focused client for message text-to-speech synthesis routed through the gateway.
public protocol TTSClientProtocol {
    func synthesize(messageId: String, conversationId: String?) async -> TTSResult
}

/// Gateway-backed implementation of ``TTSClientProtocol``.
public struct TTSClient: TTSClientProtocol {
    nonisolated public init() {}

    public func synthesize(messageId: String, conversationId: String?) async -> TTSResult {
        do {
            let encoded = messageId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? messageId
            let path = "assistants/{assistantId}/messages/\(encoded)/tts"
            var params: [String: String]? = nil
            if let conversationId, !conversationId.isEmpty {
                params = ["conversationId": conversationId]
            }

            let response = try await GatewayHTTPClient.post(path: path, params: params, timeout: 60)

            switch response.statusCode {
            case 200:
                return .success(data: response.data)
            case 403:
                return .featureDisabled
            case 404:
                return .notFound
            case 503:
                return .notConfigured
            default:
                let body = String(data: response.data, encoding: .utf8) ?? "unknown"
                log.error("TTS synthesis failed (HTTP \(response.statusCode)): \(body)")
                return .error(statusCode: response.statusCode, message: "TTS synthesis failed (HTTP \(response.statusCode))")
            }
        } catch {
            log.error("TTS synthesis error: \(error.localizedDescription)")
            return .error(statusCode: nil, message: error.localizedDescription)
        }
    }
}
