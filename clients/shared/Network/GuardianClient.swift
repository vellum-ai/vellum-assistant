import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "GuardianClient")

/// Focused client for guardian action operations routed through the gateway.
@MainActor
public protocol GuardianClientProtocol {
    func fetchPendingActions(conversationId: String) async -> GuardianActionsPendingResponseMessage?
    func submitDecision(requestId: String, action: String, conversationId: String?) async -> GuardianActionDecisionResponseMessage?
}

/// Gateway-backed implementation of ``GuardianClientProtocol``.
@MainActor
public struct GuardianClient: GuardianClientProtocol {
    nonisolated public init() {}

    public func fetchPendingActions(conversationId: String) async -> GuardianActionsPendingResponseMessage? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/guardian-actions/pending",
                params: ["conversationId": conversationId],
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("fetchPendingActions failed (HTTP \(response.statusCode))")
                return nil
            }
            let decoded = try JSONDecoder().decode(PendingActionsHTTPResponse.self, from: response.data)
            return GuardianActionsPendingResponseMessage(
                conversationId: decoded.conversationId,
                prompts: decoded.prompts
            )
        } catch {
            log.error("fetchPendingActions error: \(error.localizedDescription)")
            return nil
        }
    }

    public func submitDecision(requestId: String, action: String, conversationId: String? = nil) async -> GuardianActionDecisionResponseMessage? {
        do {
            var body: [String: Any] = [
                "requestId": requestId,
                "action": action,
            ]
            if let conversationId { body["conversationId"] = conversationId }

            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/guardian-actions/decision", json: body, timeout: 10
            )
            guard response.isSuccess else {
                log.error("submitDecision failed (HTTP \(response.statusCode))")
                return GuardianActionDecisionResponseMessage(
                    applied: false,
                    reason: "HTTP \(response.statusCode)",
                    resolverFailureReason: nil,
                    requestId: requestId,
                    userText: nil
                )
            }
            return try JSONDecoder().decode(GuardianActionDecisionResponseMessage.self, from: response.data)
        } catch {
            log.error("submitDecision error: \(error.localizedDescription)")
            return GuardianActionDecisionResponseMessage(
                applied: false,
                reason: error.localizedDescription,
                resolverFailureReason: nil,
                requestId: requestId,
                userText: nil
            )
        }
    }

    // MARK: - Response Shapes

    private struct PendingActionsHTTPResponse: Decodable {
        let conversationId: String?
        let prompts: [GuardianDecisionPromptWire]
    }
}
