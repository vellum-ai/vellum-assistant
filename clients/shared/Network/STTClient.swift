import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "STTClient")

/// Result of an STT transcription request. Callers use pattern matching to
/// deterministically trigger native fallback when the service is unavailable
/// or unconfigured.
public enum STTResult: Sendable, Equatable {
    /// Transcription succeeded — `text` contains the recognized speech.
    case success(text: String)
    /// STT service is not configured on the assistant (HTTP 503).
    case notConfigured
    /// STT service is temporarily unavailable (HTTP 5xx other than 503).
    case serviceUnavailable
    /// Generic error with optional status code and description.
    case error(statusCode: Int?, message: String)
}

/// Client for speech-to-text transcription routed through the gateway.
public protocol STTClientProtocol: Sendable {
    /// Transcribe an audio payload via the assistant's configured STT service.
    ///
    /// - Parameters:
    ///   - audioData: WAV-encoded audio data.
    ///   - contentType: MIME type of the audio payload (default `"audio/wav"`).
    /// - Returns: A typed ``STTResult`` that callers can match on to decide
    ///   whether to fall back to native recognition.
    func transcribe(audioData: Data, contentType: String) async -> STTResult
}

extension STTClientProtocol {
    /// Convenience overload that defaults `contentType` to `"audio/wav"`.
    public func transcribe(audioData: Data) async -> STTResult {
        await transcribe(audioData: audioData, contentType: "audio/wav")
    }
}

/// Gateway-backed implementation of ``STTClientProtocol``.
public struct STTClient: STTClientProtocol {
    nonisolated public init() {}

    /// Timeout for the STT HTTP request. Kept moderate — transcription may take
    /// a few seconds depending on audio length and provider latency, but we
    /// don't want to block the user indefinitely.
    static let requestTimeout: TimeInterval = 15

    public func transcribe(audioData: Data, contentType: String = "audio/wav") async -> STTResult {
        let start = CFAbsoluteTimeGetCurrent()
        do {
            let json = Self.buildRequestBody(audioData: audioData, contentType: contentType)
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/stt/transcribe",
                json: json,
                timeout: Self.requestTimeout
            )
            let elapsed = CFAbsoluteTimeGetCurrent() - start
            return Self.mapResponse(response, elapsed: elapsed)
        } catch {
            let elapsed = CFAbsoluteTimeGetCurrent() - start
            log.error("STT request error after \(String(format: "%.1f", elapsed))s: \(error.localizedDescription)")
            return .error(statusCode: nil, message: error.localizedDescription)
        }
    }

    // MARK: - Request Body Construction

    /// Builds the JSON request body for the STT transcribe endpoint.
    ///
    /// The server expects a JSON object with `audioBase64` (base64-encoded audio)
    /// and `mimeType` (MIME type string). Internal visibility for testability.
    static func buildRequestBody(audioData: Data, contentType: String) -> [String: Any] {
        return [
            "audioBase64": audioData.base64EncodedString(),
            "mimeType": contentType,
        ]
    }

    // MARK: - Response Mapping

    /// Maps an HTTP response to a typed ``STTResult``.
    ///
    /// Internal visibility so tests can verify mapping without making network calls.
    static func mapResponse(_ response: GatewayHTTPClient.Response, elapsed: TimeInterval = 0) -> STTResult {
        switch response.statusCode {
        case 200:
            return decodeSuccess(response.data, elapsed: elapsed)
        case 400:
            let body = String(data: response.data, encoding: .utf8) ?? "unknown"
            log.warning("STT bad request (400) after \(String(format: "%.1f", elapsed))s: \(body)")
            return .error(statusCode: 400, message: "Bad request: \(body)")
        case 503:
            log.info("STT service not configured (503) after \(String(format: "%.1f", elapsed))s")
            return .notConfigured
        default:
            if (500..<600).contains(response.statusCode) {
                let body = String(data: response.data, encoding: .utf8) ?? "unknown"
                log.warning("STT service unavailable (\(response.statusCode)) after \(String(format: "%.1f", elapsed))s: \(body)")
                return .serviceUnavailable
            }
            let body = String(data: response.data, encoding: .utf8) ?? "unknown"
            log.warning("STT unexpected status (\(response.statusCode)) after \(String(format: "%.1f", elapsed))s: \(body)")
            return .error(statusCode: response.statusCode, message: "STT failed (HTTP \(response.statusCode))")
        }
    }

    /// Decodes the 200 response body. Expects a JSON object with a `text` field.
    private static func decodeSuccess(_ data: Data, elapsed: TimeInterval) -> STTResult {
        struct TranscribeResponse: Decodable {
            let text: String
        }
        do {
            let decoded = try JSONDecoder().decode(TranscribeResponse.self, from: data)
            log.info("STT transcription succeeded after \(String(format: "%.1f", elapsed))s (\(decoded.text.count) chars)")
            return .success(text: decoded.text)
        } catch {
            log.warning("STT response decode failed after \(String(format: "%.1f", elapsed))s: \(error.localizedDescription)")
            return .error(statusCode: 200, message: "Failed to decode STT response")
        }
    }
}
