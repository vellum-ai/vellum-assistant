import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "InteractionClient")

/// Focused client for user interaction responses (confirmations, secrets)
/// routed through the gateway.
@MainActor
public protocol InteractionClientProtocol {
    func sendConfirmationResponse(requestId: String, decision: String, selectedPattern: String?, selectedScope: String?) async -> Bool
    func sendSecretResponse(requestId: String, value: String?, delivery: String?) async -> Bool
}

/// Gateway-backed implementation of ``InteractionClientProtocol``.
@MainActor
public struct InteractionClient: InteractionClientProtocol {
    nonisolated public init() {}

    @discardableResult
    public func sendConfirmationResponse(
        requestId: String,
        decision: String,
        selectedPattern: String? = nil,
        selectedScope: String? = nil
    ) async -> Bool {
        do {
            var body: [String: Any] = [
                "requestId": requestId,
                "decision": decision,
            ]
            if let selectedPattern { body["selectedPattern"] = selectedPattern }
            if let selectedScope { body["selectedScope"] = selectedScope }

            let response = try await GatewayHTTPClient.post(path: "assistants/{assistantId}/confirm", json: body, timeout: 10)
            if !response.isSuccess {
                log.error("sendConfirmationResponse failed (HTTP \(response.statusCode))")
                return false
            }
            return true
        } catch {
            log.error("sendConfirmationResponse error: \(error.localizedDescription)")
            return false
        }
    }

    @discardableResult
    public func sendSecretResponse(
        requestId: String,
        value: String? = nil,
        delivery: String? = nil
    ) async -> Bool {
        do {
            var body: [String: Any] = [
                "requestId": requestId,
            ]
            if let value { body["value"] = value }
            if let delivery { body["delivery"] = delivery }

            let response = try await GatewayHTTPClient.post(path: "assistants/{assistantId}/secret", json: body, timeout: 10)
            if !response.isSuccess {
                log.error("sendSecretResponse failed (HTTP \(response.statusCode))")
                return false
            }
            return true
        } catch {
            log.error("sendSecretResponse error: \(error.localizedDescription)")
            return false
        }
    }
}
