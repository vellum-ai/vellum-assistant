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
            let path = "messages/\(encoded)/tts"
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

            let path = "tts/synthesize"
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
            let message = Self.parseEnvelopeMessage(response.data)
                ?? "TTS synthesis failed (HTTP \(response.statusCode))"
            return .error(statusCode: response.statusCode, message: message)
        }
    }

    /// Best-effort extraction of `error.message` from the daemon's standard
    /// JSON error envelope: `{"error":{"code":"...","message":"..."}}`.
    ///
    /// Returns `nil` when the body is missing, not JSON, or doesn't match
    /// the expected shape — callers should fall back to a generic message.
    /// Exposed at file scope for parity tests.
    static func parseEnvelopeMessage(_ data: Data) -> String? {
        guard !data.isEmpty,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let errorObj = json["error"] as? [String: Any],
              let message = errorObj["message"] as? String
        else {
            return nil
        }
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
