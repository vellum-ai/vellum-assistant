import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "TTSClient")

/// Result of a TTS synthesis request.
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

/// Client for text-to-speech synthesis routed through the gateway.
public protocol TTSClientProtocol: Sendable {
    /// Synthesize a specific message's text to audio.
    func synthesize(messageId: String, conversationId: String?) async -> TTSResult

    /// Synthesize arbitrary text to audio via the generic TTS endpoint.
    func synthesizeText(_ text: String, context: String?, conversationId: String?) async -> TTSResult
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
            return Self.mapResponse(response)
        } catch {
            log.error("TTS synthesis error: \(error.localizedDescription)")
            return .error(statusCode: nil, message: error.localizedDescription)
        }
    }

    public func synthesizeText(_ text: String, context: String? = nil, conversationId: String? = nil) async -> TTSResult {
        do {
            var json: [String: Any] = ["text": text]
            if let context, !context.isEmpty {
                json["context"] = context
            }
            if let conversationId, !conversationId.isEmpty {
                json["conversationId"] = conversationId
            }

            let path = "assistants/{assistantId}/tts/synthesize"
            let response = try await GatewayHTTPClient.post(path: path, json: json, timeout: 60)
            return Self.mapResponse(response)
        } catch {
            log.error("TTS synthesizeText error: \(error.localizedDescription)")
            return .error(statusCode: nil, message: error.localizedDescription)
        }
    }

    // MARK: - Private

    private static func mapResponse(_ response: GatewayHTTPClient.Response) -> TTSResult {
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
    }
}
