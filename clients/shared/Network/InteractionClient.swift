import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "InteractionClient")

/// Focused client for user interaction responses (confirmations, secrets)
/// routed through the gateway.
@MainActor
public protocol InteractionClientProtocol {
    func sendConfirmationResponse(requestId: String, decision: String, selectedPattern: String?, selectedScope: String?) async
    func sendSecretResponse(requestId: String, value: String?, delivery: String?) async
}

/// Gateway-backed implementation of ``InteractionClientProtocol``.
@MainActor
public struct InteractionClient: InteractionClientProtocol {
    nonisolated public init() {}

    public func sendConfirmationResponse(
        requestId: String,
        decision: String,
        selectedPattern: String? = nil,
        selectedScope: String? = nil
    ) async {
        do {
            var body: [String: Any] = [
                "requestId": requestId,
                "decision": decision,
            ]
            if let selectedPattern { body["selectedPattern"] = selectedPattern }
            if let selectedScope { body["selectedScope"] = selectedScope }

            let response = try await GatewayHTTPClient.post(path: "confirm", json: body, timeout: 10)
            if !response.isSuccess {
                log.error("sendConfirmationResponse failed (HTTP \(response.statusCode))")
            }
        } catch {
            log.error("sendConfirmationResponse error: \(error.localizedDescription)")
        }
    }

    public func sendSecretResponse(
        requestId: String,
        value: String? = nil,
        delivery: String? = nil
    ) async {
        do {
            var body: [String: Any] = [
                "requestId": requestId,
            ]
            if let value { body["value"] = value }
            if let delivery { body["delivery"] = delivery }

            let response = try await GatewayHTTPClient.post(path: "secret", json: body, timeout: 10)
            if !response.isSuccess {
                log.error("sendSecretResponse failed (HTTP \(response.statusCode))")
            }
        } catch {
            log.error("sendSecretResponse error: \(error.localizedDescription)")
        }
    }
}
