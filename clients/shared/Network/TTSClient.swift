import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "TTSClient")

/// Result of a message TTS synthesis request.
public enum TTSResult: Sendable {
    /// Audio binary returned successfully.
    case success(data: Data, contentType: String)
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
@MainActor
public protocol TTSClientProtocol {
    func synthesize(messageId: String, conversationId: String?) async -> TTSResult
}

/// Gateway-backed implementation of ``TTSClientProtocol``.
@MainActor
public struct TTSClient: TTSClientProtocol {
    nonisolated public init() {}

    public func synthesize(messageId: String, conversationId: String?) async -> TTSResult {
        do {
            var path = "assistants/{assistantId}/messages/\(messageId)/tts"
            if let conversationId, !conversationId.isEmpty {
                path += "?conversationId=\(conversationId)"
            }

            let response = try await GatewayHTTPClient.post(path: path, timeout: 60)

            switch response.statusCode {
            case 200:
                return .success(data: response.data, contentType: "audio/mpeg")
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
