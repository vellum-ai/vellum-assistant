import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "DictationClient")

/// Focused client for dictation requests routed through the gateway.
@MainActor
public protocol DictationClientProtocol {
    func process(_ request: DictationRequest) async -> DictationResponseMessage
}

/// Gateway-backed implementation of ``DictationClientProtocol``.
@MainActor
public struct DictationClient: DictationClientProtocol {
    nonisolated public init() {}

    private static let actionVerbs: Set<String> = [
        "slack",
        "email",
        "send",
        "create",
        "open",
        "search",
        "find",
        "message",
        "text",
        "schedule",
        "remind",
        "launch",
        "navigate",
    ]

    public func process(_ request: DictationRequest) async -> DictationResponseMessage {
        do {
            let encodedRequest = try JSONEncoder().encode(request)
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/dictation",
                body: encodedRequest,
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("process dictation failed (HTTP \(response.statusCode))")
                return fallbackResponse(for: request, errorMessage: "HTTP \(response.statusCode)")
            }

            let patched = injectType("dictation_response", into: response.data)
            do {
                return try JSONDecoder().decode(DictationResponseMessage.self, from: patched)
            } catch {
                log.error("process dictation decode error: \(error.localizedDescription)")
                return fallbackResponse(for: request, errorMessage: "Failed to decode dictation response")
            }
        } catch {
            log.error("process dictation error: \(error.localizedDescription)")
            return fallbackResponse(for: request, errorMessage: error.localizedDescription)
        }
    }

    // MARK: - Helpers

    /// Internal for test coverage.
    func fallbackResponse(for request: DictationRequest, errorMessage: String) -> DictationResponseMessage {
        log.warning("Falling back to raw dictation response after HTTP failure: \(errorMessage, privacy: .public)")
        let mode = fallbackMode(for: request)
        let text: String
        switch mode {
        case "command":
            text = request.context.selectedText ?? request.transcription
        case "action", "dictation":
            text = request.transcription
        default:
            text = request.transcription
        }

        return DictationResponseMessage(
            type: "dictation_response",
            text: text,
            mode: mode,
            actionPlan: mode == "action" ? "User wants to: \(request.transcription)" : nil,
            resolvedProfileId: nil,
            profileSource: nil
        )
    }

    /// Mirrors the daemon-side fallback heuristic so client-side recovery keeps
    /// routing behavior consistent when the HTTP request fails.
    func fallbackMode(for request: DictationRequest) -> String {
        if let selectedText = request.context.selectedText,
           !selectedText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "command"
        }

        let firstWord =
            request.transcription
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .split(whereSeparator: \.isWhitespace)
                .first?
                .lowercased() ?? ""

        if Self.actionVerbs.contains(firstWord) {
            return "action"
        }

        return "dictation"
    }

    private func injectType(_ type: String, into data: Data) -> Data {
        guard var json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return data
        }
        json["type"] = type
        return (try? JSONSerialization.data(withJSONObject: json)) ?? data
    }
}
